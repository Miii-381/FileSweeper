package com.ayanami.filesweeper.mobile

import android.os.SystemClock
import android.view.MotionEvent
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Dispatch within our own view hierarchy; no shell/global touch-injection permission is needed. */
@androidx.media3.common.util.UnstableApi
@RunWith(AndroidJUnit4::class)
class MediaSeekGestureTest {
    @Test fun videoAndAudioSeekThroughTheNativeSurface() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val root = InstrumentationRegistry.getArguments().getString("fixtureRoot")!!
        check(root.matches(Regex("/storage/emulated/0/Download/FileSweeper-Navigation-Test-\\d+")))
        for (name in listOf("clip.mp4", "tone.wav")) {
            val file = File(root, "A/$name")
            check(file.isFile)
            lateinit var player: ExoPlayer
            var initialized = false
            val ready = CountDownLatch(1)
            lateinit var surface: FrameLayout
            lateinit var video: PlayerView
            lateinit var hint: TextView
            var downTime = 0L
            fun touch(action: Int) {
                val event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, 400f, 200f, 0)
                surface.dispatchTouchEvent(event); event.recycle()
            }
            try {
                instrumentation.runOnMainSync {
                    player = ExoPlayer.Builder(context).build()
                    initialized = true
                    player.volume = 0f
                    player.addListener(object : Player.Listener {
                        override fun onPlaybackStateChanged(state: Int) { if (state == Player.STATE_READY) ready.countDown() }
                    })
                    player.setMediaItem(MediaItem.fromUri(android.net.Uri.fromFile(file)))
                    player.prepare()
                }
                assertTrue("$name did not prepare", ready.await(15, TimeUnit.SECONDS))
                instrumentation.runOnMainSync {
                    surface = FrameLayout(context)
                    video = PlayerView(context).apply { useController = false; isClickable = false; isFocusable = false; this.player = player }
                    surface.addView(video, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                    if (name.endsWith(".wav")) video.visibility = android.view.View.GONE
                    hint = TextView(context).apply { visibility = android.view.View.GONE }
                    surface.addView(hint)
                    val gesture = MediaSeekGesture(context, hint, { player }, { file.absolutePath })
                    surface.setOnTouchListener(gesture)
                    surface.layout(0, 0, 1000, 400)
                    fun drag(from: Float, to: Float, cancel: Boolean = false, vertical: Boolean = false) {
                        val down = SystemClock.uptimeMillis()
                        for ((action, x, y) in listOf(Triple(MotionEvent.ACTION_DOWN, from, 200f), Triple(MotionEvent.ACTION_MOVE, if (vertical) from else to, if (vertical) 350f else 200f), Triple(if (cancel) MotionEvent.ACTION_CANCEL else MotionEvent.ACTION_UP, if (vertical) from else to, if (vertical) 350f else 200f))) {
                            val event = MotionEvent.obtain(down, down + if (action == MotionEvent.ACTION_DOWN) 0 else 500, action, x, y, 0)
                            surface.dispatchTouchEvent(event); event.recycle()
                        }
                    }
                    player.seekTo(30000)
                    drag(200f, 800f)
                    assertTrue("$name did not seek forward", player.currentPosition > 50000)
                    drag(800f, 200f)
                    assertTrue("$name did not seek backward", player.currentPosition < 30000)
                    assertFalse("Seeking must preserve pause", player.playWhenReady)
                    player.seekTo(30000); drag(200f, 800f, cancel = true)
                    assertEquals("Cancelled gesture must not seek", 30000L, player.currentPosition)
                    drag(200f, 800f, vertical = true)
                    assertEquals("Vertical movement must not seek", 30000L, player.currentPosition)
                    assertEquals(android.view.View.GONE, hint.visibility)
                    downTime = SystemClock.uptimeMillis(); touch(MotionEvent.ACTION_DOWN)
                }
                Thread.sleep(600)
                instrumentation.runOnMainSync {
                    assertEquals(AndroidFiles.preferences(context).getDouble("holdPlaybackSpeed").toFloat(), player.playbackParameters.speed, .001f)
                    assertTrue(player.playWhenReady)
                    touch(MotionEvent.ACTION_UP)
                    assertEquals(1f, player.playbackParameters.speed, .001f)
                    assertFalse(player.playWhenReady)
                    assertEquals(android.view.View.GONE, hint.visibility)
                    video.player = null
                }
            } finally { instrumentation.runOnMainSync { if (initialized) player.release() } }
        }
    }
}
