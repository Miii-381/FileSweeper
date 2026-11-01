package com.ayanami.filesweeper.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.PowerManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/** The Activity/WebView can pause or disappear without owning the file task lifetime. */
class FileTaskService : Service() {
    private val executor = Executors.newSingleThreadExecutor()
    private val pending = AtomicInteger()
    private val main = Handler(Looper.getMainLooper())
    private var latestProgress: JSONObject? = null
    private var lastNotificationAt = 0L
    private val publishProgress = Runnable {
        val task = latestProgress
        if (!stopping && pending.get() > 0 && task?.optString("state") in listOf("queued", "running")) {
            getSystemService(NotificationManager::class.java).notify(NOTIFICATION, notification(task))
            lastNotificationAt = SystemClock.elapsedRealtime()
            AndroidFiles.log(this, "notification", "Progress published: id=${task!!.optString("id")}, operation=${task.optString("operation")}, items=${task.optInt("completedItems")}/${task.optInt("totalItems")}, bytes=${task.optLong("transferredBytes")}, total=${task.opt("totalBytes")}")
        }
    }
    private var wakeLock: PowerManager.WakeLock? = null
    @Volatile private var stopping = false
    companion object {
        private const val CHANNEL = "file-operations"
        private const val NOTIFICATION = 2101
        fun launch(context: Context, id: String) {
            try { context.startForegroundService(Intent(context, FileTaskService::class.java).putExtra("taskId", id)) }
            catch (error: Exception) { FileTasks.serviceStopped(context, id, "后台服务无法启动：${error.message}"); throw error }
        }
    }
    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL, "文件操作", NotificationManager.IMPORTANCE_LOW))
        wakeLock = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "FileSweeper:FileTask")
    }
    override fun onBind(intent: Intent?): IBinder? = null
    private fun notification(task: JSONObject?): Notification {
        val title = when (task?.optString("operation")) { "copy" -> "复制文件"; "move" -> "移动文件"; "rename" -> "重命名"; "trash" -> "移入回收站"; "restore" -> "恢复文件"; "delete", "purge" -> "永久删除"; else -> "文件任务" }
        val builder = NotificationCompat.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(title).setOnlyAlertOnce(true).setOngoing(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        if (launch != null) builder.setContentIntent(PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        if (task != null) {
            val state = task.optString("state")
            val active = state in listOf("running", "queued")
            val bytes = task.optLong("transferredBytes")
            if (active) {
                val done = task.optInt("completedItems")
                val count = task.optInt("totalItems")
                if (task.optString("phase") == "scanning") {
                    builder.setProgress(0, 0, true)
                    builder.setContentText("正在统计文件大小 · 已找到 ${task.optInt("scannedFiles")} 个文件")
                } else if (task.optString("operation") == "copy") {
                    val total = task.optLong("totalBytes", 0)
                    val percent = if (total > 0) (bytes.toDouble() * 100 / total).toInt().coerceIn(0, 100) else 0
                    builder.setProgress(100, percent, total <= 0)
                    builder.setContentText(if (total > 0) "$percent% · ${size(bytes)} / ${size(total)} · $done / $count 项" else "$done / $count 项 · 已复制 ${size(bytes)}")
                } else {
                    // Same-volume moves are atomic renames: there is no byte-transfer percentage.
                    builder.setProgress(count.coerceAtLeast(1), done, count <= 0)
                    builder.setContentText("$done / $count 项")
                }
                val index = task.optInt("currentIndex", 0)
                val item = task.optJSONArray("items")?.optJSONObject(index)
                if (item != null) builder.setSubText(java.io.File(item.optString("source")).name)
                val cancel = Intent(this, FileTaskService::class.java).setAction("cancel").putExtra("taskId", task.getString("id"))
                builder.addAction(android.R.drawable.ic_menu_close_clear_cancel, "取消", PendingIntent.getService(this, task.getString("id").hashCode(), cancel, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            }
        }
        return builder.build()
    }
    private fun size(bytes: Long): String = when {
        bytes >= 1024 * 1024 -> String.format(java.util.Locale.ROOT, "%.1f MiB", bytes / (1024.0 * 1024))
        bytes >= 1024 -> String.format(java.util.Locale.ROOT, "%.1f KiB", bytes / 1024.0)
        else -> "$bytes B"
    }
    private fun progress(task: JSONObject) {
        // The executor mutates its record immediately after this callback. Cross threads
        // with a snapshot, and coalesce phase changes to one notification per second.
        val snapshot = JSONObject(task.toString())
        main.post {
            if (stopping) return@post
            latestProgress = snapshot
            main.removeCallbacks(publishProgress)
            if (snapshot.optString("state") in listOf("queued", "running")) {
                val delay = (1000 - (SystemClock.elapsedRealtime() - lastNotificationAt)).coerceAtLeast(0)
                main.postDelayed(publishProgress, delay)
            }
        }
    }
    private fun removeProgress() {
        main.removeCallbacks(publishProgress)
        latestProgress = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        getSystemService(NotificationManager::class.java).cancel(NOTIFICATION)
        AndroidFiles.log(this, "notification", "Progress notification removed; pending=${pending.get()}")
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val id = intent?.getStringExtra("taskId") ?: return START_NOT_STICKY
        if (intent.action == "cancel") { FileTasks.cancel(this, id); if (pending.get() == 0) { removeProgress(); stopSelf(startId) }; return START_NOT_STICKY }
        if (pending.getAndIncrement() == 0) {
            lastNotificationAt = 0
            ServiceCompat.startForeground(this, NOTIFICATION, notification(null), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        }
        if (wakeLock?.isHeld != true) wakeLock?.acquire(6 * 60 * 60 * 1000L)
        executor.execute {
            try {
                if (stopping) FileTasks.serviceStopped(this, id, "后台服务已停止，任务尚未开始")
                else FileTasks.execute(this, id, ::progress)
            } catch (error: Exception) { AndroidFiles.log(this, "service", "Task service failed: id=$id", error) }
            finally {
                pending.decrementAndGet()
                main.post {
                    if (pending.get() == 0) {
                        if (wakeLock?.isHeld == true) wakeLock?.release()
                        removeProgress()
                        // A notification cancel intent can have a newer startId.
                        stopSelf()
                    }
                }
            }
        }
        return START_NOT_STICKY
    }
    override fun onTimeout(startId: Int, fgsType: Int) {
        AndroidFiles.log(this, "service", "Foreground service timed out")
        stopping = true
        removeProgress()
        FileTasks.interruptAll()
        stopSelf()
    }
    override fun onDestroy() {
        stopping = true
        removeProgress()
        FileTasks.interruptAll()
        executor.shutdown()
        if (wakeLock?.isHeld == true) wakeLock?.release()
        super.onDestroy()
    }
}
