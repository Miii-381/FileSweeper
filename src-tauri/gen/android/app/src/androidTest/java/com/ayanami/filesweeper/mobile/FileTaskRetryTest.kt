package com.ayanami.filesweeper.mobile

import android.os.Bundle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Leave one genuine failed batch for the WebView test to retry through its button. */
@RunWith(AndroidJUnit4::class)
class FileTaskRetryTest {
    @Test fun createRecoverableFailureWithOneCompletedFile() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val root = InstrumentationRegistry.getArguments().getString("fixtureRoot")!!
        check(root.matches(Regex("/storage/emulated/0/Download/FileSweeper-Navigation-Test-\\d+")))
        // Android can load unextracted libraries directly from the installed APK.
        System.loadLibrary("file_sweeper_lib")
        val source = File(root, "Retry/Source").apply { check(mkdirs()) }
        val target = File(root, "Retry/Target").apply { check(mkdirs()) }
        val first = File(source, "已完成的文件.txt").apply { writeText("completed once", Charsets.UTF_8) }
        val second = File(source, "需要重新执行的文件.txt").apply { writeText("retry this item", Charsets.UTF_8) }
        val task = FileTasks.create(context, JSONObject().put("operation", "copy").put("paths", JSONArray().put(first.absolutePath).put(second.absolutePath)).put("destination", target.absolutePath))
        File(target, second.name).writeText("owned test conflict", Charsets.UTF_8)
        FileTasks.execute(context, task.getString("id")) {}
        val failed = FileTasks.load(context, task.getString("id"))
        assertEquals("failed", failed.getString("state"))
        assertEquals(1, failed.getInt("completedItems"))
        assertEquals(first.name, failed.getJSONArray("items").getJSONObject(0).getString("name"))
        assertEquals(first.readText(Charsets.UTF_8), File(target, first.name).readText(Charsets.UTF_8))
        instrumentation.sendStatus(0, Bundle().apply { putString("retryTaskId", task.getString("id")) })
    }
}
