package com.ayanami.filesweeper.mobile

import android.content.Context
import android.media.MediaScannerConnection
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** One durable record per task; execution has one writer, cancellation uses a separate marker. */
internal object FileTasks {
    private val session = UUID.randomUUID().toString()
    private val running = ConcurrentHashMap.newKeySet<String>()
    private val interrupted = ConcurrentHashMap.newKeySet<String>()
    private class Cancelled : IOException("用户取消任务")
    private class Interrupted : IOException("系统中断任务")

    private fun directory(context: Context) = File(context.filesDir, "tasks").also { check(it.isDirectory || it.mkdirs()) }
    private fun record(context: Context, id: String): File { UUID.fromString(id); return File(directory(context), "$id.json") }
    private fun cancellation(context: Context, id: String) = File(directory(context), "$id.cancel")
    fun load(context: Context, id: String): JSONObject = AndroidFiles.read(record(context, id))
    private fun save(context: Context, task: JSONObject) {
        task.put("updatedAt", System.currentTimeMillis()).put("revision", task.optLong("revision") + 1)
        AndroidFiles.write(record(context, task.getString("id")), task)
    }

    @Synchronized fun list(context: Context): JSONArray {
        val records = mutableListOf<JSONObject>()
        for (file in directory(context).listFiles().orEmpty().filter { it.extension == "json" }) {
            try {
                val task = AndroidFiles.read(file)
                if (task.optString("session") != session && task.getString("state") in listOf("queued", "running")) {
                    task.put("state", "interrupted").put("error", "上次执行已中断，请核对后继续")
                    save(context, task)
                }
                records.add(task)
            } catch (error: Exception) { AndroidFiles.log(context, "tasks", "Task record could not be read: ${file.name}", error) }
        }
        // History stays on disk. The small MVP panel only loads the most recent 30 summaries.
        val recent = records.sortedByDescending { it.optLong("createdAt") }.take(30)
        // Older records did not store a display name. Enrich returned snapshots
        // from surviving trash metadata without rewriting or replaying history.
        for (task in recent) {
            val items = task.getJSONArray("items")
            for (index in 0 until items.length()) {
                val item = items.getJSONObject(index)
                if (item.has("name")) continue
                val metadata = item.optString("trashId").takeIf { it.isNotBlank() }?.let { File(AndroidFiles.trashDirectory(it), "entry.json") }
                val original = if (metadata?.isFile == true) try { AndroidFiles.read(metadata).optString("originalPath") } catch (error: Exception) {
                    AndroidFiles.log(context, "tasks", "Unable to read legacy item name: task=${task.getString("id")}, index=$index", error); ""
                } else ""
                if (original.isNotBlank()) item.put("originalPath", original)
                val path = original.ifBlank { if (task.optString("operation") == "restore") item.optString("destination", item.getString("source")) else item.getString("source") }
                item.put("name", if (File(path).name == "content" && task.optString("operation") == "purge") "已清理的回收项目" else File(path).name)
            }
        }
        return JSONArray(recent)
    }

    @Synchronized fun create(context: Context, args: JSONObject): JSONObject {
        AndroidFiles.requireAccess()
        val operation = args.getString("operation")
        check(operation in setOf("copy", "move", "rename", "trash", "delete", "restore", "purge")) { "不支持的文件操作" }
        if (operation in setOf("delete", "purge")) check(args.optBoolean("confirmed")) { "永久删除需要明确确认" }
        if (operation == "trash") check(AndroidFiles.preferences(context).getBoolean("trashEnabled")) { "回收站已关闭，请重新确认删除方式" }
        val id = UUID.randomUUID().toString()
        val items = JSONArray()
        val paths = args.optJSONArray("paths") ?: JSONArray()
        if (operation in setOf("restore", "purge")) {
            // One durable task owns the entire selection; execution remains strictly sequential.
            val ids = args.optJSONArray("trashIds") ?: JSONArray().put(args.getString("trashId"))
            check(ids.length() > 0) { "请选择回收项目" }
            val seen = mutableSetOf<String>()
            val reserved = mutableSetOf<String>()
            for (index in 0 until ids.length()) {
                val trashId = ids.getString(index)
                check(seen.add(trashId)) { "回收项目不能重复选择" }
                val entry = AndroidFiles.trashDirectory(trashId)
                val metadata = AndroidFiles.read(File(entry, "entry.json"))
                val original = AndroidFiles.shared(metadata.getString("originalPath"), false)
                val source = File(entry, "content")
                check(source.exists()) { "回收文件不存在：${original.name}，请刷新回收站" }
                val restored = item(source).put("trashId", entry.name).put("name", original.name).put("originalPath", original.absolutePath)
                if (operation == "restore") {
                    check(!Files.isSymbolicLink(source.toPath())) { "回收内容已被修改，不能恢复符号链接" }
                    val parent = args.optString("destination").takeIf { it.isNotBlank() }?.let { AndroidFiles.shared(it) } ?: original.parentFile!!
                    check(parent.isDirectory) { "原目录已不存在，请选择其他恢复目录：${original.name}" }
                    // Identical names from different trash entries must reserve distinct destinations
                    // before any move starts, including several versions of the same original file.
                    val destination = AndroidFiles.unused(parent, original.name, reserved).absolutePath
                    reserved.add(destination)
                    restored.put("destination", destination)
                }
                items.put(restored)
                AndroidFiles.log(context, "trash", "Batch item validated: task=$id, operation=$operation, index=$index, trashId=$trashId, destination=${restored.optString("destination")}")
            }
        } else {
            check(paths.length() in 1..1000) { "请选择 1 至 1000 个项目" }
            for (index in 0 until paths.length()) {
                val source = AndroidFiles.shared(paths.getString(index), false)
                check(source.exists()) { "源文件不存在" }
                val item = item(source)
                when (operation) {
                    "copy", "move" -> {
                        val parent = AndroidFiles.shared(args.getString("destination"))
                        check(parent.isDirectory) { "目标目录不存在" }
                        check(!parent.toPath().startsWith(source.toPath())) { "不能移动或复制到自身目录中" }
                        if (operation == "move") check(parent != source.parentFile) { "目标目录与源目录相同" }
                        item.put("destination", AndroidFiles.unused(parent, source.name).absolutePath)
                    }
                    "rename" -> {
                        val name = args.getString("name")
                        AndroidFiles.validateName(name)
                        val target = File(source.parentFile, name)
                        check(!target.exists() || target == source) { "该名称已存在" }
                        item.put("destination", target.absolutePath)
                    }
                    "trash" -> {
                        val trashId = UUID.randomUUID().toString()
                        item.put("trashId", trashId).put("destination", File(AndroidFiles.trashDirectory(trashId), "content").absolutePath)
                    }
                }
                // Unique temp ownership is recorded BEFORE creating or modifying any file.
                if (operation == "copy") {
                    val target = File(item.getString("destination"))
                    item.put("temporary", File(target.parentFile, ".${target.name}.filesweeper-$id-$index.tmp").absolutePath)
                }
                items.put(item)
            }
        }
        val task = JSONObject().put("schemaVersion", 1).put("id", id).put("session", session)
            .put("operation", operation).put("state", "queued").put("createdAt", System.currentTimeMillis())
            .put("items", items).put("completedItems", 0).put("failedItems", 0).put("totalItems", items.length())
            .put("transferredBytes", 0).put("totalBytes", JSONObject.NULL).put("revision", 0)
        if ((0 until items.length()).all { !items.getJSONObject(it).getBoolean("directory") }) {
            task.put("totalBytes", (0 until items.length()).sumOf { items.getJSONObject(it).getLong("sourceSize") })
        }
        save(context, task)
        AndroidFiles.log(context, "tasks", "Task created durably: id=$id, operation=$operation, items=${items.length()}")
        return task
    }

    private fun item(file: File) = JSONObject().put("source", file.absolutePath).put("name", file.name).put("sourceSize", file.length())
        .put("sourceModified", file.lastModified()).put("directory", file.isDirectory).put("stage", "pending")

    fun cancel(context: Context, id: String) {
        val task = load(context, id)
        cancellation(context, id).writeText("cancel", Charsets.UTF_8)
        if (!running.contains(id) && task.getString("state") == "interrupted") { task.put("state", "cancelled"); save(context, task) }
        AndroidFiles.log(context, "tasks", "Cancellation requested: id=$id")
    }

    @Synchronized fun resume(context: Context, id: String): JSONObject {
        check(!running.contains(id)) { "任务仍在执行" }
        val task = load(context, id)
        check(task.getString("state") in setOf("interrupted", "failed", "cancelled")) { "任务不能恢复" }
        cancellation(context, id).delete(); interrupted.remove(id)
        task.put("state", "queued").put("session", session).put("resumeCount", task.optInt("resumeCount") + 1)
        task.put("failedItems", 0).remove("error"); task.remove("finishedAt")
        save(context, task)
        AndroidFiles.log(context, "tasks", "Task requeued: id=$id, operation=${task.getString("operation")}, completed=${task.optInt("completedItems")}, total=${task.optInt("totalItems")}, resumeCount=${task.optInt("resumeCount")}")
        return task
    }

    fun interruptAll() { interrupted.addAll(running) }
    fun serviceStopped(context: Context, id: String, reason: String) {
        val task = load(context, id)
        if (task.optString("state") in setOf("queued", "running")) { task.put("state", "interrupted").put("error", reason); save(context, task) }
    }
    private fun checkpoint(context: Context, id: String) {
        if (interrupted.contains(id)) throw Interrupted()
        if (cancellation(context, id).exists()) throw Cancelled()
    }

    fun execute(context: Context, id: String, progress: (JSONObject) -> Unit) {
        if (!running.add(id)) return
        val task = load(context, id)
        val items = task.getJSONArray("items")
        val operation = task.getString("operation")
        var lastSave = 0L
        fun update(force: Boolean = false) {
            if (force || System.currentTimeMillis() - lastSave > 750) {
                task.put("completedItems", (0 until items.length()).count { items.getJSONObject(it).optString("stage") == "completed" })
                save(context, task); progress(task); lastSave = System.currentTimeMillis()
            }
        }
        try {
            AndroidFiles.requireAccess()
            task.put("state", "running").remove("error"); update(true)
            if (operation == "copy" && task.isNull("totalBytes")) {
                task.put("phase", "scanning").put("scannedFiles", 0); update(true)
                var total = 0L
                fun measure(file: File) {
                    checkpoint(context, id)
                    check(!Files.isSymbolicLink(file.toPath())) { "复制目录中包含符号链接，已停止" }
                    if (file.isDirectory) for (child in file.listFiles() ?: throw IOException("无法统计源目录")) measure(child)
                    else {
                        total = Math.addExact(total, file.length())
                        task.put("scannedFiles", task.optInt("scannedFiles") + 1); update()
                    }
                }
                for (index in 0 until items.length()) {
                    val item = items.getJSONObject(index)
                    if (item.optString("stage") == "completed") total = Math.addExact(total, item.optLong("copiedBytes"))
                    else measure(AndroidFiles.shared(item.getString("source"), false))
                }
                task.put("totalBytes", total)
                AndroidFiles.log(context, "tasks", "Copy size measured: id=$id, bytes=$total, files=${task.optInt("scannedFiles")}")
            }
            task.put("phase", if (operation == "copy") "copying" else "processing"); update(true)
            for (index in 0 until items.length()) {
                checkpoint(context, id)
                val item = items.getJSONObject(index)
                if (item.optString("stage") == "completed") continue
                task.put("currentIndex", index)
                val source = if (operation in setOf("restore", "purge")) File(AndroidFiles.trashDirectory(item.getString("trashId")), "content") else AndroidFiles.shared(item.getString("source"), false)
                val target = item.optString("destination").takeIf { it.isNotBlank() }?.let { path ->
                    if (operation == "trash") File(AndroidFiles.trashDirectory(item.getString("trashId")), "content") else AndroidFiles.shared(path, false)
                }
                AndroidFiles.log(context, "tasks", "Item begin: id=$id, index=$index, stage=${item.getString("stage")}, source=$source, target=$target")
                // Atomic moves can finish before the post-move record is flushed. Never repeat them blindly.
                if (!source.exists()) {
                    if (target?.exists() == true && item.optString("stage") in setOf("moving", "committed")) {
                        check(item.optBoolean("directory") == target.isDirectory && (target.isDirectory || target.length() == item.getLong("sourceSize"))) { "目标状态与记录不符，请人工核对" }
                        item.put("stage", "completed"); update(true); continue
                    }
                    if (operation in setOf("delete", "purge") && item.optString("stage") == "deleting") { item.put("stage", "completed"); update(true); continue }
                    throw IOException("源文件不存在，无法确认任务结果")
                }
                if (item.optString("stage") == "pending" || operation !in setOf("delete", "purge")) {
                    check(source.isDirectory || (source.length() == item.getLong("sourceSize") && source.lastModified() == item.getLong("sourceModified"))) { "源文件已变化，请重新发起操作" }
                }
                when (operation) {
                    "copy" -> {
                        check(target != null)
                        if (target.exists() && item.optString("stage") == "committed") { item.put("stage", "completed"); update(true); continue }
                        check(!target.exists()) { "目标已存在，保留两边文件，请人工核对" }
                        val temp = AndroidFiles.shared(item.getString("temporary"), false)
                        if (temp.exists()) deleteTree(temp) { checkpoint(context, id) }
                        item.put("copiedBytes", 0)
                        task.put("transferredBytes", (0 until items.length()).sumOf { items.getJSONObject(it).optLong("copiedBytes") })
                        item.put("stage", "copying"); update(true)
                        copyTree(source, temp, { checkpoint(context, id) }) { bytes ->
                            item.put("copiedBytes", item.optLong("copiedBytes") + bytes)
                            task.put("transferredBytes", task.optLong("transferredBytes") + bytes); update()
                        }
                        check(source.isDirectory || (source.length() == item.getLong("sourceSize") && source.lastModified() == item.getLong("sourceModified"))) { "复制期间源文件变化，未提交目标" }
                        NativeMoves.move(temp, target)
                        item.put("stage", "committed"); update(true)
                    }
                    "move", "rename", "trash", "restore" -> {
                        check(target != null)
                        if (source != target) {
                            if (operation == "trash") {
                                check(target.parentFile!!.isDirectory || target.parentFile!!.mkdirs()) { "无法建立回收目录" }
                                File(AndroidFiles.trashRoot, ".nomedia").createNewFile()
                                AndroidFiles.write(File(target.parentFile, "entry.json"), JSONObject().put("schemaVersion", 1).put("originalPath", source.absolutePath).put("recycledAt", System.currentTimeMillis()).put("taskId", id))
                            }
                            check(!target.exists()) { "目标已被占用，未覆盖文件" }
                            item.put("stage", "moving"); update(true)
                            // Shared internal storage stays on the same volume: no copy-then-delete fallback.
                            NativeMoves.move(source, target)
                        }
                        item.put("stage", "committed"); update(true)
                    }
                    "delete", "purge" -> {
                        item.put("stage", "deleting"); update(true)
                        deleteTree(source) { checkpoint(context, id) }
                    }
                }
                if (operation in setOf("restore", "purge")) {
                    val entry = AndroidFiles.trashDirectory(item.getString("trashId"))
                    File(entry, "entry.json").delete(); entry.delete()
                }
                item.put("stage", "completed")
                task.put("completedItems", (0 until items.length()).count { items.getJSONObject(it).optString("stage") == "completed" })
                update(true)
                MediaScannerConnection.scanFile(context, listOfNotNull(source.absolutePath, target?.absolutePath).toTypedArray(), null, null)
                AndroidFiles.log(context, "tasks", "Item completed: id=$id, index=$index")
            }
            task.put("completedItems", items.length()).put("state", "completed").put("finishedAt", System.currentTimeMillis())
        } catch (error: Exception) {
            task.put("state", when (error) { is Cancelled -> "cancelled"; is Interrupted -> "interrupted"; else -> "failed" })
                .put("error", error.message ?: "文件任务失败")
            if (error !is Cancelled && error !is Interrupted) task.put("failedItems", 1)
            if (operation == "copy" && error !is Interrupted) {
                // Reclaim only this task's uncommitted staging data. A cancelled copy
                // must not leave a hidden full-sized file consuming shared storage.
                for (index in 0 until items.length()) {
                    val entry = items.getJSONObject(index)
                    if (entry.optString("stage") != "copying") continue
                    try {
                        val temporary = AndroidFiles.shared(entry.getString("temporary"), false)
                        check(temporary.name.contains(".filesweeper-$id-")) { "临时文件归属校验失败" }
                        if (temporary.exists()) deleteTree(temporary) {}
                        entry.put("stage", "pending").put("copiedBytes", 0)
                    } catch (cleanup: Exception) { AndroidFiles.log(context, "tasks", "Temporary cleanup pending: id=$id, index=$index", cleanup) }
                }
            }
            AndroidFiles.log(context, "tasks", "Task stopped: id=$id, state=${task.getString("state")}", error)
        } finally {
            try { update(true) } catch (error: Exception) { AndroidFiles.log(context, "tasks", "Unable to save terminal record: id=$id", error) }
            running.remove(id)
        }
    }

    private fun copyTree(source: File, target: File, check: () -> Unit, progress: (Long) -> Unit) {
        check()
        kotlin.check(!Files.isSymbolicLink(source.toPath())) { "复制目录中包含符号链接，已停止" }
        if (source.isDirectory) {
            kotlin.check(target.mkdir()) { "无法创建临时目录" }
            for (child in source.listFiles() ?: throw IOException("无法读取源目录")) copyTree(child, File(target, child.name), check, progress)
        } else {
            kotlin.check(target.createNewFile()) { "临时文件已存在" }
            source.inputStream().use { input ->
                java.io.FileOutputStream(target).use { output ->
                    val buffer = ByteArray(256 * 1024)
                    while (true) { check(); val count = input.read(buffer); if (count < 0) break; output.write(buffer, 0, count); progress(count.toLong()) }
                    output.fd.sync()
                }
            }
        }
    }

    private fun deleteTree(file: File, check: () -> Unit) {
        check()
        // Do not follow symbolic links found inside a selected directory.
        if (!Files.isSymbolicLink(file.toPath()) && file.isDirectory) for (child in file.listFiles() ?: throw IOException("无法读取待删除目录")) deleteTree(child, check)
        if (!file.delete() && file.exists()) throw IOException("无法删除 ${file.name}")
    }
}
