package com.ayanami.filesweeper.mobile

import android.content.Context
import android.os.Environment
import android.util.AtomicFile
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.security.MessageDigest
import java.util.UUID

/** Shared storage policy and durable records. Cache cleanup must never touch task/trash metadata. */
internal object AndroidFiles {
    val root: File get() = Environment.getExternalStorageDirectory().canonicalFile
    val trashRoot: File get() = File(root, ".FileSweeperTrash")

    fun requireAccess() { check(Environment.isExternalStorageManager()) { "请先授权所有文件访问权限" } }

    fun shared(path: String, allowRoot: Boolean = true, allowTrash: Boolean = false): File {
        requireAccess()
        val input = File(path)
        check(!Files.isSymbolicLink(input.toPath())) { "暂不操作符号链接" }
        val file = input.canonicalFile
        check(file == root || file.toPath().startsWith(root.toPath())) { "文件超出内置共享存储范围" }
        check(allowRoot || file != root) { "不能操作存储根目录" }
        check(allowTrash || !file.toPath().startsWith(trashRoot.toPath())) { "请通过回收站管理这些文件" }
        return file
    }

    fun preview(context: Context, path: String): File {
        val file = File(path).canonicalFile
        val thumbnails = File(context.cacheDir, "thumbnails").canonicalFile
        val backgrounds = File(context.filesDir, "backgrounds").canonicalFile
        return if (file.toPath().startsWith(thumbnails.toPath()) || file.toPath().startsWith(backgrounds.toPath())) file else shared(path)
    }

    fun kind(file: File, settings: JSONObject): String {
        if (file.extension.lowercase() == "pdf") return "pdf"
        for (type in listOf("video", "audio", "image", "text")) {
            val extensions = settings.getJSONArray("${type}Extensions")
            if ((0 until extensions.length()).any { extensions.getString(it) == file.extension.lowercase() }) return type
        }
        return "other"
    }

    fun entry(file: File, settings: JSONObject): JSONObject = JSONObject().apply {
        put("path", file.absolutePath); put("name", file.name); put("entryType", if (file.isDirectory) "folder" else "file")
        put("createdAt", JSONObject.NULL); put("modifiedAt", file.lastModified()); put("canRecycle", true)
        if (file.isFile) {
            put("extension", if (file.extension.isEmpty()) "" else ".${file.extension.lowercase()}")
            val type = kind(file, settings)
            put("size", file.length()); put("kind", type); put("previewCapability", if (type == "other") "unavailable" else "inline")
            for (key in listOf("duration", "width", "height", "thumbnailPath")) put(key, JSONObject.NULL)
        }
    }

    fun list(context: Context, path: String): JSONObject {
        val directory = shared(path)
        val settings = preferences(context)
        check(directory.isDirectory) { "目录不存在" }
        // A marker applies to descendants, while folders, text and PDF stay browsable.
        var ancestor: File? = directory
        var suppressed = false
        while (ancestor != null && ancestor.toPath().startsWith(root.toPath())) {
            if (File(ancestor, ".nomedia").isFile) { suppressed = !settings.getBoolean("showNomediaMedia"); break }
            ancestor = ancestor.parentFile
        }
        val children = directory.listFiles() ?: throw IOException("无法读取目录")
        val items = JSONArray()
        for (file in children) {
            if (file.name == ".FileSweeperTrash" || file.name.contains(".filesweeper-")) continue
            if (!settings.getBoolean("showHiddenItems") && file.name.startsWith(".")) continue
            if (Files.isSymbolicLink(file.toPath())) continue
            if (suppressed && file.isFile && kind(file, settings) in setOf("video", "audio", "image")) continue
            items.put(entry(file, settings))
        }
        return JSONObject().put("path", directory.absolutePath).put("items", items).put("isAvailable", true).put("mediaSuppressed", suppressed)
    }

    @Synchronized fun write(file: File, value: JSONObject) {
        check(file.parentFile!!.isDirectory || file.parentFile!!.mkdirs()) { "无法创建记录目录" }
        val atomic = AtomicFile(file)
        val stream = atomic.startWrite()
        try { stream.write(value.toString().toByteArray(Charsets.UTF_8)); atomic.finishWrite(stream) }
        catch (error: Exception) { atomic.failWrite(stream); throw error }
    }

    @Synchronized fun read(file: File): JSONObject = JSONObject(AtomicFile(file).openRead().bufferedReader(Charsets.UTF_8).use { it.readText() })

    fun preferences(context: Context): JSONObject = MobilePreferences.read(context)

    fun cacheKey(file: File): String = MessageDigest.getInstance("SHA-256").digest("${file.absolutePath}:${file.length()}:${file.lastModified()}".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    fun unused(parent: File, name: String, reserved: Set<String> = emptySet()): File {
        val original = File(parent, name)
        if (!original.exists() && original.absolutePath !in reserved) return original
        val extension = original.extension.let { if (it.isEmpty() || original.isDirectory) "" else ".$it" }
        val stem = if (extension.isEmpty()) name else name.dropLast(extension.length)
        for (index in 1..9999) { val candidate = File(parent, "$stem ($index)$extension"); if (!candidate.exists() && candidate.absolutePath !in reserved) return candidate }
        throw IOException("无法找到可用的文件名")
    }

    fun validateName(name: String) {
        check(name.isNotBlank() && name != "." && name != ".." && !name.contains('/') && !name.contains('\u0000') && name.toByteArray(Charsets.UTF_8).size <= 240) { "文件名无效" }
    }

    fun trashEntries(): JSONArray {
        requireAccess()
        val items = JSONArray()
        for (directory in trashRoot.listFiles().orEmpty()) {
            val metadata = File(directory, "entry.json")
            if (!metadata.isFile) continue
            try {
                val record = read(metadata)
                val payload = File(directory, "content")
                // A crash after rename but before the final record is still recoverable.
                if (payload.exists()) items.put(record.put("id", directory.name).put("name", File(record.getString("originalPath")).name)
                    .put("directory", payload.isDirectory).put("size", if (payload.isFile) payload.length() else JSONObject.NULL))
            } catch (error: Exception) { Log.w("FileSweeper", "Invalid trash entry: ${directory.name}", error) }
        }
        return items
    }

    fun trashDirectory(id: String): File {
        UUID.fromString(id)
        val directory = File(trashRoot, id).canonicalFile
        check(directory.parentFile == trashRoot.canonicalFile && !Files.isSymbolicLink(directory.toPath())) { "回收条目无效" }
        return directory
    }

    @Synchronized fun log(context: Context, module: String, message: String, error: Throwable? = null) {
        Log.println(if (error == null) Log.INFO else Log.ERROR, "FileSweeper/$module", "$message ${error?.message.orEmpty()}")
        try {
            val file = File(context.filesDir, "logs/mobile.log")
            file.parentFile!!.mkdirs()
            if (file.length() > 2 * 1024 * 1024) { val previous = File(file.parentFile, "mobile.previous.log"); previous.delete(); file.renameTo(previous) }
            file.appendText("${System.currentTimeMillis()} [$module] $message${if (error == null) "" else "\n${Log.getStackTraceString(error)}"}\n", Charsets.UTF_8)
        } catch (failure: Exception) { Log.e("FileSweeper", "Unable to persist diagnostic log", failure) }
    }
}
