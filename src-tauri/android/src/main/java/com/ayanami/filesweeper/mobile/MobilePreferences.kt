package com.ayanami.filesweeper.mobile

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Store only mobile settings with real consumers; validate before a single durable commit. */
internal object MobilePreferences {
    private fun defaults() = JSONObject("""{
      "trashEnabled":true,"appearance":"system","accentTheme":"teal","codeTheme":"tomorrow",
      "autoplay":true,"volume":100,"muted":false,"rememberWorkspaceFocus":true,"holdPlaybackSpeed":2,
      "showHiddenItems":false,"showNomediaMedia":false,
      "backgroundImage":null,"backgroundOpacity":30,"backgroundBlur":0,
      "imageMaxMegabytes":32,"imageMaxMegapixels":64,"thumbnailCacheMb":256,
      "thumbnailCapturePosition":"early","textPreviewLatinFont":"monospace","textPreviewCjkFont":"sans-serif",
      "videoExtensions":["mp4","mkv","webm","avi","mov","m4v","3gp","ts"],
      "audioExtensions":["mp3","flac","wav","ogg","m4a","aac","opus","wma"],
      "imageExtensions":["jpg","jpeg","png","gif","webp","bmp","heic","heif","avif","tiff"],
      "textExtensions":["txt","md","json","xml","html","css","js","ts","tsx","jsx","kt","java","rs","py","c","cpp","h","hpp","log","yaml","yml","toml","ini","csv","sql","sh","ps1"],
      "textLanguageMap":{".ts":"typescript",".tsx":"tsx",".js":"javascript",".jsx":"jsx",".json":"json",".py":"python",".rs":"rust",".java":"java",".c":"c",".cpp":"cpp",".md":"markdown",".css":"css",".html":"markup",".xml":"markup",".yml":"yaml",".yaml":"yaml",".sh":"bash",".ps1":"powershell",".sql":"sql"}
    }""")

    @Synchronized fun read(context: Context): JSONObject {
        val result = defaults()
        val prefs = context.getSharedPreferences("mobile", Context.MODE_PRIVATE)
        val saved = JSONObject(prefs.getString("preferences", "{}")!!)
        for (key in saved.keys()) if (result.has(key)) result.put(key, saved.get(key))
        if (!saved.has("trashEnabled")) result.put("trashEnabled", prefs.getBoolean("trashEnabled", true))
        return result
    }

    @Synchronized fun save(context: Context, patch: JSONObject): JSONObject {
        val result = read(context)
        val enums = mapOf("appearance" to setOf("system", "dark", "light"), "accentTheme" to setOf("teal", "sky", "amber", "coral", "lime"), "codeTheme" to setOf("default", "dark", "funky", "okaidia", "tomorrow", "twilight", "coy", "solarizedlight"), "thumbnailCapturePosition" to setOf("opening", "early", "middle", "late", "ending"))
        val ranges = mapOf("volume" to 0..100, "backgroundOpacity" to 0..100, "backgroundBlur" to 0..100, "imageMaxMegabytes" to 1..512, "imageMaxMegapixels" to 1..128, "thumbnailCacheMb" to 16..2048)
        for (key in patch.keys()) {
            check(result.has(key)) { "未知设置：$key" }
            val value = patch.get(key)
            when {
                key == "holdPlaybackSpeed" -> check(value is Number && value.toDouble() in setOf(1.25, 1.5, 2.0, 3.0)) { "长按倍速无效" }
                enums.containsKey(key) -> check(value is String && value in enums.getValue(key)) { "设置值无效：$key" }
                ranges.containsKey(key) -> check(value is Number && value.toDouble().isFinite() && value.toDouble() == value.toInt().toDouble() && value.toInt() in ranges.getValue(key)) { "设置超出范围：$key" }
                key.endsWith("Extensions") -> {
                    check(value is JSONArray && value.length() in 1..128) { "请至少保留一种格式" }
                    val normalized = JSONArray()
                    for (i in 0 until value.length()) {
                        val extension = value.getString(i).trim().lowercase().removePrefix(".")
                        check(extension.matches(Regex("[a-z0-9][a-z0-9_+-]{0,19}"))) { "无效扩展名：$extension" }
                        if ((0 until normalized.length()).none { normalized.getString(it) == extension }) normalized.put(extension)
                    }
                    result.put(key, normalized); continue
                }
                key == "backgroundImage" -> check(value == JSONObject.NULL || value == "wallpaper") { "背景图必须先导入" }
                key == "textLanguageMap" -> {
                    check(value is JSONObject && value.length() <= 128) { "语言映射无效" }
                    for (extension in value.keys()) check(extension.matches(Regex("\\.[a-zA-Z0-9_+-]{1,20}")) && value.getString(extension).matches(Regex("[a-zA-Z0-9_-]{1,30}"))) { "语言映射无效" }
                }
                key.startsWith("textPreview") -> check(value is String && value.length in 1..120) { "字体名称无效" }
                else -> check(value is Boolean) { "开关值无效：$key" }
            }
            result.put(key, value)
        }
        check(context.getSharedPreferences("mobile", 0).edit().putString("preferences", result.toString()).commit()) { "无法保存设置" }
        AndroidFiles.log(context, "settings", "Preferences committed: keys=${patch.keys().asSequence().joinToString()}")
        return result
    }
}
