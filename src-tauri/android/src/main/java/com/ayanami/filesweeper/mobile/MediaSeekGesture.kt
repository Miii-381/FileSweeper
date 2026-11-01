package com.ayanami.filesweeper.mobile

import android.annotation.SuppressLint
import android.content.Context
import android.view.MotionEvent
import android.view.View
import android.os.Handler
import android.os.Looper
import android.widget.TextView
import androidx.media3.common.Player
import java.util.Locale
import kotlin.math.abs
import kotlin.math.min

/** Native overlay receives video and audio gestures even when video sits above the WebView. */
internal class MediaSeekGesture(private val context: Context, private val hint: TextView, private val player: () -> Player?, private val path: () -> String?) : View.OnTouchListener {
    private var startX = 0f
    private var startY = 0f
    private var startPosition = 0L
    private var target = 0L
    private var duration = 0L
    private var dragging = false
    private var tracking = false
    private var gesturePath: String? = null
    private val main = Handler(Looper.getMainLooper())
    private var boosting = false
    private var previousSpeed = 1f
    private var previouslyPlaying = false
    private val hold = Runnable {
        val exo = player()
        if (tracking && !dragging && exo != null && gesturePath == path()) {
            previousSpeed = exo.playbackParameters.speed; previouslyPlaying = exo.playWhenReady
            val speed = AndroidFiles.preferences(context).getDouble("holdPlaybackSpeed").toFloat()
            boosting = true; exo.setPlaybackSpeed(speed); exo.play()
            hint.text = "${speed.toString().removeSuffix(".0")}× 倍速播放"; hint.visibility = View.VISIBLE
            AndroidFiles.log(context, "media-gesture", "Hold speed started: path=$gesturePath, speed=$speed, previousSpeed=$previousSpeed, playing=$previouslyPlaying")
        }
    }
    private val threshold = context.resources.displayMetrics.density * 12

    fun cancel() {
        main.removeCallbacks(hold)
        if (boosting) {
            player()?.let { exo -> exo.setPlaybackSpeed(previousSpeed); exo.playWhenReady = previouslyPlaying }
            boosting = false
            AndroidFiles.log(context, "media-gesture", "Hold speed restored: path=$gesturePath, speed=$previousSpeed, playing=$previouslyPlaying")
        }
        if (dragging) AndroidFiles.log(context, "media-gesture", "Seek gesture cancelled: path=$gesturePath")
        tracking = false; dragging = false; hint.visibility = View.GONE
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouch(view: View, event: MotionEvent): Boolean {
        val exo = player() ?: return false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                cancel()
                if (!exo.isCurrentMediaItemSeekable || exo.duration <= 0 || exo.playerError != null) return false
                tracking = true; gesturePath = path(); startX = event.x; startY = event.y
                startPosition = exo.currentPosition; duration = exo.duration; target = startPosition
                main.postDelayed(hold, 450)
                return true
            }
            MotionEvent.ACTION_POINTER_DOWN, MotionEvent.ACTION_CANCEL -> { cancel(); return true }
            MotionEvent.ACTION_MOVE -> {
                if (!tracking || path() != gesturePath) { cancel(); return false }
                if (boosting) return true
                val dx = event.x - startX
                val dy = event.y - startY
                if (!dragging && abs(dy) > threshold && abs(dy) > abs(dx)) { cancel(); return true }
                if (!dragging && abs(dx) > threshold) {
                    main.removeCallbacks(hold)
                    dragging = true
                    AndroidFiles.log(context, "media-gesture", "Seek gesture started: path=$gesturePath, from=$startPosition, duration=$duration")
                }
                if (dragging) {
                    target = (startPosition + dx / view.width.coerceAtLeast(1) * min(duration, 120_000L)).toLong().coerceIn(0, duration)
                    val delta = target - startPosition
                    hint.text = "${if (delta >= 0) "快进" else "快退"} ${time(abs(delta))}\n${time(target)} / ${time(duration)}"
                    hint.visibility = View.VISIBLE
                }
                return true
            }
            MotionEvent.ACTION_UP -> {
                main.removeCallbacks(hold)
                if (boosting) { cancel(); return true }
                if (tracking && dragging && path() == gesturePath) {
                    exo.seekTo(target)
                    AndroidFiles.log(context, "media-gesture", "Seek gesture committed: path=$gesturePath, from=$startPosition, to=$target, playing=${exo.playWhenReady}")
                } else if (tracking) view.performClick()
                tracking = false; dragging = false; hint.visibility = View.GONE
                return true
            }
        }
        return tracking
    }

    private fun time(value: Long): String = String.format(Locale.ROOT, "%d:%02d", value / 60000, value / 1000 % 60)
}
