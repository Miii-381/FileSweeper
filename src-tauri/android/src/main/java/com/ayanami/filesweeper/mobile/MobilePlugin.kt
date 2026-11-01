package com.ayanami.filesweeper.mobile

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.media.ThumbnailUtils
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.util.Size
import android.view.View
import android.view.ViewGroup
import android.view.Gravity
import android.graphics.Color
import android.widget.TextView
import android.webkit.MimeTypeMap
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResult
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.FileProvider
import androidx.media3.common.MediaItem
import androidx.media3.common.AudioAttributes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import app.tauri.annotation.Command
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

@androidx.media3.common.util.UnstableApi
@TauriPlugin
class MobilePlugin(private val activity: Activity) : Plugin(activity) {
    private val io = Executors.newFixedThreadPool(2)
    private var browser: WebView? = null
    private var player: ExoPlayer? = null
    private var playerView: PlayerView? = null
    private var mediaSurface: FrameLayout? = null
    private var seekGesture: MediaSeekGesture? = null
    private var playingPath: String? = null
    private val positions = mutableMapOf<String, Long>()

    override fun load(webView: WebView) {
        browser = webView
        webView.settings.setSupportZoom(false)
        webView.settings.builtInZoomControls = false
        webView.settings.displayZoomControls = false
        activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        val host = activity as? ComponentActivity
        host?.onBackPressedDispatcher?.addCallback(host, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { event("mobile-back", JSONObject()) }
        })
        AndroidFiles.log(activity, "lifecycle", "Native mobile plugin loaded")
    }

    private fun event(name: String, value: JSONObject) {
        browser?.post { browser?.evaluateJavascript("window.dispatchEvent(new CustomEvent(${JSONObject.quote(name)},{detail:$value}))", null) }
    }

    private fun work(invoke: Invoke, action: (JSONObject) -> JSONObject) {
        val args = JSONObject(invoke.getRawArgs())
        io.execute {
            try { invoke.resolve(JSObject(action(args).toString())) }
            catch (error: Exception) { AndroidFiles.log(activity, "${invoke.command}", "Command failed", error); invoke.reject(error.message ?: "操作失败") }
        }
    }

    @Command fun storageState(invoke: Invoke) {
        invoke.resolve(JSObject().apply {
            put("granted", Environment.isExternalStorageManager()); put("root", AndroidFiles.root.absolutePath)
            put("notifications", NotificationManagerCompat.from(activity).areNotificationsEnabled())
            put("preferences", AndroidFiles.preferences(activity))
        })
    }

    @Command fun requestStorage(invoke: Invoke) {
        try {
            activity.startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${activity.packageName}")))
            invoke.resolve()
        } catch (error: Exception) { invoke.reject(error.message) }
    }

    @Command fun listDirectory(invoke: Invoke) = work(invoke) { args ->
        AndroidFiles.list(activity, args.getString("path")).also { AndroidFiles.log(activity, "workspace", "Directory listed: path=${args.getString("path")}, count=${it.getJSONArray("items").length()}, nomedia=${it.getBoolean("mediaSuppressed")}") }
    }
    @Command fun resolveFile(invoke: Invoke) = work(invoke) { args -> JSONObject().put("path", AndroidFiles.preview(activity, args.getString("path")).also { check(it.isFile) { "文件不存在" } }.absolutePath) }
    @Command fun imageInfo(invoke: Invoke) = work(invoke) { args ->
        val file = AndroidFiles.preview(activity, args.getString("path"))
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, options)
        val preferences = AndroidFiles.preferences(activity)
        val allowed = options.outWidth > 0 && options.outWidth.toLong() * options.outHeight <= preferences.getLong("imageMaxMegapixels") * 1_000_000 && file.length() <= preferences.getLong("imageMaxMegabytes") * 1024 * 1024
        JSONObject().put("width", options.outWidth).put("height", options.outHeight).put("allowed", allowed).put("reason", if (allowed) JSONObject.NULL else "图片格式不支持或像素超过手机预览限制")
    }

    @Command fun thumbnail(invoke: Invoke) = work(invoke) { args ->
        val file = AndroidFiles.shared(args.getString("path"))
        val settings = AndroidFiles.preferences(activity)
        val capture = settings.getString("thumbnailCapturePosition")
        val output = File(activity.cacheDir, "thumbnails/${AndroidFiles.cacheKey(file)}-$capture.jpg")
        if (!output.exists()) {
            val bitmap: Bitmap? = when (AndroidFiles.kind(file, settings)) {
                "image" -> ThumbnailUtils.createImageThumbnail(file, Size(256, 256), null)
                "video" -> MediaMetadataRetriever().use { retriever ->
                    retriever.setDataSource(file.absolutePath)
                    val duration = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
                    val fraction = when (capture) { "opening" -> 0.0; "middle" -> 0.5; "late" -> 0.75; "ending" -> 0.95; else -> 0.1 }
                    retriever.getScaledFrameAtTime((duration * 1000 * fraction).toLong(), MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 256, 256)
                }
                "audio" -> MediaMetadataRetriever().use { retriever -> retriever.setDataSource(file.absolutePath); retriever.embeddedPicture?.let { BitmapFactory.decodeByteArray(it, 0, it.size) } }
                else -> null
            }
            if (bitmap == null) return@work JSONObject().put("path", JSONObject.NULL)
            output.parentFile!!.mkdirs()
            // Compress to a small cache file; never pass decoded bitmaps over IPC.
            val scaled = Bitmap.createScaledBitmap(bitmap, 256, (bitmap.height * 256.0 / bitmap.width).toInt().coerceIn(1, 256), true)
            output.outputStream().use { check(scaled.compress(Bitmap.CompressFormat.JPEG, 82, it)) }
            if (scaled !== bitmap) scaled.recycle()
            bitmap.recycle()
            val cached = output.parentFile!!.listFiles().orEmpty().sortedBy { it.lastModified() }
            var bytes = cached.sumOf { it.length() }
            val limit = settings.getLong("thumbnailCacheMb") * 1024 * 1024
            for (old in cached) { if (bytes <= limit) break; if (old != output) { val size = old.length(); if (old.delete()) bytes -= size } }
        }
        JSONObject().put("path", output.absolutePath)
    }

    @Command fun savePreferences(invoke: Invoke) = work(invoke) { args ->
        MobilePreferences.save(activity, args).also { settings -> activity.runOnUiThread { player?.volume = if (settings.getBoolean("muted")) 0f else settings.getInt("volume") / 100f } }
    }

    @Command fun background(invoke: Invoke) = work(invoke) {
        val file = File(activity.filesDir, "backgrounds/wallpaper")
        JSONObject().put("path", if (file.isFile && !AndroidFiles.preferences(activity).isNull("backgroundImage")) file.absolutePath else JSONObject.NULL)
    }
    @Command fun chooseBackground(invoke: Invoke) {
        startActivityForResult(invoke, Intent(Intent.ACTION_OPEN_DOCUMENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE), "backgroundResult")
    }
    @ActivityCallback fun backgroundResult(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) { invoke.resolve(JSObject().put("cancelled", true)); return }
        importBackgroundUri(invoke, uri)
    }
    @Command fun importBackground(invoke: Invoke) {
        try { importBackgroundUri(invoke, Uri.fromFile(AndroidFiles.shared(JSONObject(invoke.getRawArgs()).getString("path")))) }
        catch (error: Exception) { invoke.reject(error.message) }
    }
    private fun importBackgroundUri(invoke: Invoke, uri: Uri) {
        io.execute {
            val temporary = File(activity.filesDir, "backgrounds/import-${java.util.UUID.randomUUID()}")
            try {
                temporary.parentFile!!.mkdirs()
                activity.contentResolver.openInputStream(uri)!!.use { input -> temporary.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024); var total = 0L
                    while (true) { val count = input.read(buffer); if (count < 0) break; total += count; check(total <= 32L * 1024 * 1024) { "背景图片不能超过 32 MiB" }; output.write(buffer, 0, count) }
                    output.fd.sync()
                } }
                val info = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeFile(temporary.absolutePath, info)
                check(info.outWidth > 0 && info.outWidth.toLong() * info.outHeight <= 64_000_000) { "图片格式不支持或超过 64 MP" }
                check(temporary.renameTo(File(temporary.parentFile, "wallpaper"))) { "无法保存背景图" }
                val prefs = MobilePreferences.save(activity, JSONObject().put("backgroundImage", "wallpaper"))
                AndroidFiles.log(activity, "background", "Image imported: width=${info.outWidth}, height=${info.outHeight}")
                invoke.resolve(JSObject().put("preferences", prefs))
            } catch (error: Exception) { AndroidFiles.log(activity, "background", "Import failed", error); invoke.reject(error.message) }
            finally { temporary.delete() }
        }
    }
    @Command fun clearThumbnails(invoke: Invoke) = work(invoke) {
        val directory = File(activity.cacheDir, "thumbnails")
        var count = 0
        for (file in directory.listFiles().orEmpty()) if (file.isFile && file.delete()) count++
        AndroidFiles.log(activity, "cache", "Thumbnail cache cleared: files=$count")
        JSONObject().put("removed", count)
    }

    @Command fun tasks(invoke: Invoke) = work(invoke) { JSONObject().put("tasks", FileTasks.list(activity)) }
    /** Only this application's notifications; useful when OEM UI or rate limits differ. */
    @Command fun taskNotificationState(invoke: Invoke) {
        val items = JSONArray()
        for (entry in activity.getSystemService(android.app.NotificationManager::class.java).activeNotifications) {
            if (entry.notification.channelId != "file-operations") continue
            val extras = entry.notification.extras
            items.put(JSONObject().put("id", entry.id).put("progress", extras.getInt(android.app.Notification.EXTRA_PROGRESS))
                .put("max", extras.getInt(android.app.Notification.EXTRA_PROGRESS_MAX)).put("indeterminate", extras.getBoolean(android.app.Notification.EXTRA_PROGRESS_INDETERMINATE))
                .put("title", extras.getCharSequence(android.app.Notification.EXTRA_TITLE)?.toString())
                .put("text", extras.getCharSequence(android.app.Notification.EXTRA_TEXT)?.toString()))
        }
        invoke.resolve(JSObject().put("notifications", items))
    }
    @Command fun trash(invoke: Invoke) = work(invoke) { JSONObject().put("items", AndroidFiles.trashEntries()) }
    @Command fun startTask(invoke: Invoke) {
        val args = JSONObject(invoke.getRawArgs())
        // Release the native file before a move/delete, including from the context menu.
        val sources = args.optJSONArray("paths") ?: JSONArray()
        val affectsPreview = playingPath?.let { path -> (0 until sources.length()).any { index ->
            val source = sources.getString(index).trimEnd('/')
            path == source || path.startsWith("$source/")
        } } ?: false
        if (args.optString("operation") != "copy" && affectsPreview) clearMedia()
        if (Build.VERSION.SDK_INT >= 33 && !NotificationManagerCompat.from(activity).areNotificationsEnabled()) {
            ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1401)
        }
        work(invoke) { FileTasks.create(activity, args).also { FileTaskService.launch(activity, it.getString("id")) } }
    }
    @Command fun cancelTask(invoke: Invoke) = work(invoke) { args -> FileTasks.cancel(activity, args.getString("id")); JSONObject().put("ok", true) }
    @Command fun resumeTask(invoke: Invoke) = work(invoke) { args -> FileTasks.resume(activity, args.getString("id")).also { FileTaskService.launch(activity, it.getString("id")) } }

    @Command fun openExternally(invoke: Invoke) {
        try {
            val file = AndroidFiles.shared(JSONObject(invoke.getRawArgs()).getString("path"))
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
            val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase()) ?: "application/octet-stream").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            activity.startActivity(Intent.createChooser(intent, "使用其他应用打开")); invoke.resolve()
        } catch (error: Exception) { AndroidFiles.log(activity, "external", "Unable to open file", error); invoke.reject(error.message ?: "没有可用的应用") }
    }

    @Command fun playMedia(invoke: Invoke) {
        try {
            val args = JSONObject(invoke.getRawArgs())
            val file = AndroidFiles.shared(args.getString("path"))
            pauseAndRemember()
            if (player == null) {
                player = ExoPlayer.Builder(activity).setAudioAttributes(AudioAttributes.DEFAULT, true).setHandleAudioBecomingNoisy(true).build().also { exo ->
                    exo.addListener(object : Player.Listener {
                        override fun onPlayerError(error: PlaybackException) {
                            AndroidFiles.log(activity, "media", "Native playback failed: path=$playingPath", error)
                            event("mobile-media-error", JSONObject().put("path", playingPath).put("message", "设备无法播放此文件，请尝试其他应用"))
                        }
                    })
                }
                playerView = PlayerView(activity).also { view ->
                    // Controls live in the WebView toolbar outside this native picture surface.
                    view.useController = false
                    view.isClickable = false
                    view.isFocusable = false
                    view.player = player; view.setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING)
                    val surface = FrameLayout(activity)
                    surface.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                    val hint = TextView(activity).apply {
                        setTextColor(Color.WHITE); textSize = 17f; gravity = Gravity.CENTER
                        setPadding(24, 14, 24, 14); setBackgroundColor(0xCC172322.toInt()); visibility = View.GONE
                        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                    }
                    surface.addView(hint, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
                    seekGesture = MediaSeekGesture(activity, hint, { player }, { playingPath })
                    surface.setOnTouchListener(seekGesture)
                    mediaSurface = surface
                    (activity.findViewById<ViewGroup>(android.R.id.content)).addView(surface, FrameLayout.LayoutParams(1, 1))
                }
            }
            seekGesture?.cancel()
            playingPath = file.absolutePath
            player!!.setMediaItem(MediaItem.fromUri(Uri.fromFile(file)), positions[file.absolutePath] ?: 0)
            player!!.prepare()
            val settings = AndroidFiles.preferences(activity)
            player!!.volume = if (settings.getBoolean("muted")) 0f else settings.getInt("volume") / 100f
            player!!.playWhenReady = args.optBoolean("autoplay", true) && args.optBoolean("visible", true)
            updateBounds(args)
            AndroidFiles.log(activity, "media", "Native media prepared: path=$playingPath, autoplay=${player!!.playWhenReady}, controls=external")
            invoke.resolve()
        } catch (error: Exception) { invoke.reject(error.message) }
    }

    private fun updateBounds(args: JSONObject) {
        // Ignore queued layout callbacks belonging to a closed or previous file.
        if (playingPath == null || args.optString("path") != playingPath) return
        val view = mediaSurface ?: return
        val visible = args.optBoolean("visible", true)
        view.visibility = if (visible) View.VISIBLE else View.GONE
        playerView?.visibility = if (args.optBoolean("renderVideo", true)) View.VISIBLE else View.GONE
        if (!visible) { pauseAndRemember(); return }
        val scale = activity.resources.displayMetrics.density
        val origin = IntArray(2)
        browser?.getLocationInWindow(origin)
        val contentOrigin = IntArray(2)
        activity.findViewById<View>(android.R.id.content).getLocationInWindow(contentOrigin)
        view.layoutParams = FrameLayout.LayoutParams((args.optDouble("width", 1.0) * scale).toInt().coerceAtLeast(1), (args.optDouble("height", 1.0) * scale).toInt().coerceAtLeast(1)).apply {
            leftMargin = origin[0] - contentOrigin[0] - activity.findViewById<View>(android.R.id.content).paddingLeft + (args.optDouble("x", 0.0) * scale).toInt()
            topMargin = origin[1] - contentOrigin[1] - activity.findViewById<View>(android.R.id.content).paddingTop + (args.optDouble("y", 0.0) * scale).toInt()
        }
    }
    @Command fun setPlayerBounds(invoke: Invoke) { updateBounds(JSONObject(invoke.getRawArgs())); invoke.resolve() }
    private fun pauseAndRemember() { seekGesture?.cancel(); player?.let { exo -> playingPath?.let { positions[it] = exo.currentPosition }; exo.pause() } }
    private fun clearMedia() {
        val oldPath = playingPath
        pauseAndRemember()
        mediaSurface?.visibility = View.GONE
        player?.clearMediaItems()
        playingPath = null
        AndroidFiles.log(activity, "media", "Native preview cleared: path=$oldPath")
    }
    @Command fun closeMedia(invoke: Invoke) {
        val args = JSONObject(invoke.getRawArgs())
        if (!args.has("path") || args.optString("path") == playingPath) clearMedia()
        invoke.resolve()
    }
    @Command fun mediaState(invoke: Invoke) {
        invoke.resolve(JSObject().apply {
            put("speed", player?.playbackParameters?.speed ?: 1f)
            put("path", playingPath); put("state", player?.playbackState ?: 0); put("playing", player?.isPlaying ?: false); put("position", player?.currentPosition ?: 0); put("duration", (player?.duration ?: 0).coerceAtLeast(0)); put("error", player?.playerError?.errorCodeName); put("controlsEmbedded", playerView?.useController ?: false)
            mediaSurface?.let { surface ->
                val origin = IntArray(2); surface.getLocationOnScreen(origin)
                put("surface", JSONObject().put("x", origin[0]).put("y", origin[1]).put("width", surface.width).put("height", surface.height).put("visible", surface.visibility == View.VISIBLE))
            }
        })
    }
    @Command fun controlMedia(invoke: Invoke) {
        try {
            val args = JSONObject(invoke.getRawArgs())
            check(args.getString("path") == playingPath) { "预览文件已切换" }
            when (args.getString("action")) {
                "play" -> { if (player?.playbackState == Player.STATE_ENDED) player?.seekTo(0); player?.play() }
                "pause" -> pauseAndRemember()
                "seek" -> player?.seekTo(args.getLong("position").coerceIn(0, (player?.duration ?: 0).coerceAtLeast(0)))
                else -> error("无效的播放操作")
            }
            AndroidFiles.log(activity, "media", "Control: action=${args.getString("action")}, path=$playingPath")
            invoke.resolve()
        } catch (error: Exception) { invoke.reject(error.message) }
    }
    @Command fun setFullscreen(invoke: Invoke) {
        activity.requestedOrientation = if (JSONObject(invoke.getRawArgs()).optBoolean("fullscreen")) ActivityInfo.SCREEN_ORIENTATION_USER else ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        invoke.resolve()
    }
    @Command fun finish(invoke: Invoke) { activity.finish(); invoke.resolve() }
    override fun onPause() { pauseAndRemember(); AndroidFiles.log(activity, "lifecycle", "Activity paused; media paused, file service independent") }
    override fun onResume() { event("mobile-resume", JSONObject()) }
    override fun onDestroy(activity: AppCompatActivity) { pauseAndRemember(); playerView?.player = null; player?.release(); player = null; io.shutdown(); AndroidFiles.log(activity, "lifecycle", "Native view released") }
}
