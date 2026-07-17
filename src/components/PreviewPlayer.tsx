import { invoke } from "@tauri-apps/api/core";
import { Maximize2, Minimize2, MonitorPlay, Pause, Play, Video, Volume2, VolumeX } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

import type { VideoEntry, VideoStreamUrl } from "../app-types";
import { errorMessage, formatPlaybackTime, writeClientLog } from "../app-utils";
import { loadThumbnailData } from "./VideoThumbnail";

export type PreviewPlayerHandle = {
  togglePlayback: () => void;
  skipPlayback: (seconds: number) => void;
  stopPlayback: () => void;
  releasePlayback: () => void;
};

type PreviewPlayerProps = {
  video: VideoEntry | null;
  thumbnailPath: string | null;
  autoplay: boolean;
  volume: number;
  muted: boolean;
  onEnsureThumbnail: (video: VideoEntry) => void;
  onAudioPreferenceChange: (volume: number, muted: boolean, persistImmediately?: boolean) => void;
};

export const PreviewPlayer = forwardRef<PreviewPlayerHandle, PreviewPlayerProps>(function PreviewPlayer({
  video,
  thumbnailPath,
  autoplay,
  volume,
  muted,
  onEnsureThumbnail,
  onAudioPreferenceChange,
}, ref) {
  const videoElement = useRef<HTMLVideoElement>(null);
  const playerRoot = useRef<HTMLElement>(null);
  const playerSurface = useRef<HTMLDivElement>(null);
  const [thumbnailSrc, setThumbnailSrc] = useState<string | null>(null);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [isTranscoded, setIsTranscoded] = useState(false);
  const [playerState, setPlayerState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(muted);
  const [playerVolume, setPlayerVolume] = useState(volume);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenControlsVisible, setFullscreenControlsVisible] = useState(true);
  const streamStartTime = useRef(0);
  const streamRequest = useRef(0);
  const resumeAfterSeek = useRef(false);
  const isScrubbing = useRef(false);
  const directFallbackRequested = useRef(false);
  const fullscreenControlsTimer = useRef<number | null>(null);

  const showFullscreenControls = () => {
    setFullscreenControlsVisible(true);
    if (fullscreenControlsTimer.current !== null) {
      window.clearTimeout(fullscreenControlsTimer.current);
    }
    if (isFullscreen && isPlaying) {
      fullscreenControlsTimer.current = window.setTimeout(() => {
        setFullscreenControlsVisible(false);
        fullscreenControlsTimer.current = null;
      }, 2200);
    }
  };

  const keepFullscreenControlsVisible = () => {
    setFullscreenControlsVisible(true);
    if (fullscreenControlsTimer.current !== null) {
      window.clearTimeout(fullscreenControlsTimer.current);
      fullscreenControlsTimer.current = null;
    }
  };

  useEffect(() => {
    const syncFullscreen = () => {
      const active = document.fullscreenElement === playerRoot.current;
      setIsFullscreen(active);
      setFullscreenControlsVisible(true);
      if (!active && fullscreenControlsTimer.current !== null) {
        window.clearTimeout(fullscreenControlsTimer.current);
        fullscreenControlsTimer.current = null;
      }
    };
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreen);
      if (fullscreenControlsTimer.current !== null) {
        window.clearTimeout(fullscreenControlsTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    showFullscreenControls();
  }, [isFullscreen, isPlaying]);

  useEffect(() => {
    setThumbnailSrc(null);
    if (!video) {
      return;
    }
    if (!thumbnailPath) {
      onEnsureThumbnail(video);
      return;
    }
    let active = true;
    void loadThumbnailData(video, thumbnailPath)
      .then((source) => {
        if (active) {
          setThumbnailSrc(source);
        }
      })
      .catch((error) => {
        if (active) {
          writeClientLog("error", `读取预览缩略图失败：${thumbnailPath}，${errorMessage(error)}`);
        }
      });
    return () => {
      active = false;
    };
  }, [onEnsureThumbnail, thumbnailPath, video]);

  useEffect(() => {
    setStreamUrl(null);
    setIsTranscoded(false);
    setPlayerError(null);
    setPlayerState(video ? "loading" : "idle");
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    streamStartTime.current = 0;
    resumeAfterSeek.current = false;
    directFallbackRequested.current = false;
    const request = ++streamRequest.current;
    if (!video) {
      return;
    }
    let active = true;
    // A short stable-selection delay prevents rapid range selection from opening a stream per item.
    const timer = window.setTimeout(() => {
      void invoke<VideoStreamUrl>("get_video_stream_url", { path: video.path })
        .then(({ url, isTranscoded: nextIsTranscoded, duration: streamDuration }) => {
          if (active && request === streamRequest.current) {
            setStreamUrl(url);
            setIsTranscoded(nextIsTranscoded);
            setDuration(streamDuration ?? 0);
          }
        })
        .catch((error) => {
          if (active) {
            const message = errorMessage(error);
            setPlayerError(message);
            setPlayerState("error");
            writeClientLog("error", `创建预览流失败：${video.path}，${message}`);
          }
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [video]);

  useEffect(() => {
    const element = videoElement.current;
    if (!element) {
      return;
    }
    element.volume = Math.min(1, Math.max(0, playerVolume / 100));
    element.muted = isMuted;
    element.playbackRate = rate;
  }, [isMuted, playerVolume, rate, streamUrl]);

  useEffect(() => {
    setPlayerVolume(volume);
    setIsMuted(muted);
  }, [muted, volume]);

  const togglePlayback = () => {
    const element = videoElement.current;
    if (!element || playerState !== "ready") {
      return;
    }
    if (element.paused) {
      void element.play().catch((error) => {
        const message = errorMessage(error);
        setPlayerError(message);
        writeClientLog("error", `播放预览失败：${video?.path ?? ""}，${message}`);
      });
    } else {
      element.pause();
    }
  };

  const startTranscodedPreview = (startTime: number, resume: boolean) => {
    if (!video || !Number.isFinite(startTime)) {
      return;
    }
    const targetTime = duration > 0 ? Math.min(Math.max(0, startTime), duration) : Math.max(0, startTime);
    const request = ++streamRequest.current;
    streamStartTime.current = targetTime;
    resumeAfterSeek.current = resume;
    setCurrentTime(targetTime);
    setPlayerError(null);
    setPlayerState("loading");
    setStreamUrl(null);
    void invoke<VideoStreamUrl>("get_video_stream_url", {
      path: video.path,
      startSeconds: targetTime,
      forceTranscode: true,
    })
      .then(({ url, isTranscoded: nextIsTranscoded, duration: streamDuration }) => {
        if (request === streamRequest.current) {
          setIsTranscoded(nextIsTranscoded);
          setDuration(streamDuration ?? duration);
          setStreamUrl(url);
        }
      })
      .catch((error) => {
        if (request === streamRequest.current) {
          const message = errorMessage(error);
          setPlayerError(message);
          setPlayerState("error");
          writeClientLog("error", `创建转码预览失败：${video.path}，${message}`);
        }
      });
  };

  const fallbackDirectPreview = (reason: string, resume: boolean) => {
    if (isTranscoded || directFallbackRequested.current) {
      return;
    }
    directFallbackRequested.current = true;
    writeClientLog("warn", `原文件内嵌预览缺少可用视频轨，回退到 FFmpeg 转码：${reason}，${video?.path ?? ""}`);
    startTranscodedPreview(0, resume);
  };

  const seek = (nextTime: number) => {
    const element = videoElement.current;
    if (!element || !video || !Number.isFinite(nextTime)) {
      return;
    }
    const targetTime = Math.min(Math.max(0, nextTime), duration);
    if (!isTranscoded) {
      element.currentTime = targetTime;
      setCurrentTime(targetTime);
      return;
    }
    startTranscodedPreview(targetTime, !element.paused);
  };

  const skipPlayback = (seconds: number) => {
    const element = videoElement.current;
    if (!element || playerState !== "ready") {
      return;
    }
    seek(currentTime + seconds);
  };

  const stopPlayback = () => {
    streamRequest.current += 1;
    const element = videoElement.current;
    if (element) {
      element.pause();
    }
    setIsPlaying(false);
  };

  const releasePlayback = () => {
    const element = videoElement.current;
    if (element) {
      element.removeAttribute("src");
      element.load();
    }
    setStreamUrl(null);
    setPlayerState("idle");
  };

  useImperativeHandle(
    ref,
    () => ({
      togglePlayback,
      skipPlayback,
      stopPlayback,
      releasePlayback,
    }),
    [currentTime, duration, isTranscoded, playerState, video],
  );

  const openExternally = () => {
    if (!video) {
      return;
    }
    void invoke("open_video_externally", { path: video.path }).catch((error: unknown) => {
      writeClientLog("error", `使用外部播放器打开失败：${video.path}，${errorMessage(error)}`);
    });
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement === playerRoot.current) {
      void document.exitFullscreen?.();
    } else {
      void playerRoot.current?.requestFullscreen?.();
    }
  };

  if (!video) {
    return (
      <section className="player-placeholder">
        <div className="player-icon" aria-hidden="true">
          <MonitorPlay size={28} />
        </div>
        <p>选择一个视频后显示预览</p>
      </section>
    );
  }

  return (
    <section
      className={`preview-player ${isFullscreen && !fullscreenControlsVisible ? "controls-hidden" : ""}`}
      aria-label={`${video.name} 的视频预览`}
      ref={playerRoot}
      onPointerMove={showFullscreenControls}
      onPointerDown={showFullscreenControls}
    >
      <div
        className="preview-media"
        ref={playerSurface}
        onClick={(event) => {
          if (!(event.target instanceof Element && event.target.closest("button"))) {
            togglePlayback();
          }
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          toggleFullscreen();
        }}
      >
        {thumbnailSrc ? <img className="preview-thumbnail" src={thumbnailSrc} alt="" /> : <div className="preview-thumbnail-fallback"><Video size={30} /></div>}
        {streamUrl && (
          <video
            ref={videoElement}
            className={`preview-video ${playerState === "ready" ? "is-ready" : ""}`}
            src={streamUrl}
            preload="metadata"
            playsInline
            onCanPlay={(event) => {
              if (!isTranscoded && (event.currentTarget.videoWidth === 0 || event.currentTarget.videoHeight === 0)) {
                fallbackDirectPreview(
                  `canplay 时视频尺寸为 ${event.currentTarget.videoWidth}×${event.currentTarget.videoHeight}`,
                  autoplay || !event.currentTarget.paused,
                );
                return;
              }
              setPlayerState("ready");
              if (autoplay || resumeAfterSeek.current) {
                resumeAfterSeek.current = false;
                void videoElement.current?.play().catch((error) => {
                  writeClientLog("warn", `自动播放预览被阻止：${video.path}，${errorMessage(error)}`);
                });
              }
            }}
            onLoadedMetadata={(event) => {
              if (!isTranscoded && (event.currentTarget.videoWidth === 0 || event.currentTarget.videoHeight === 0)) {
                fallbackDirectPreview(
                  `loadedmetadata 时视频尺寸为 ${event.currentTarget.videoWidth}×${event.currentTarget.videoHeight}`,
                  autoplay || !event.currentTarget.paused,
                );
                return;
              }
              if (!isTranscoded && Number.isFinite(event.currentTarget.duration)) {
                setDuration(event.currentTarget.duration);
              }
            }}
            onTimeUpdate={(event) => {
              if (!isScrubbing.current) {
                setCurrentTime(streamStartTime.current + event.currentTarget.currentTime);
              }
            }}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={() => setIsPlaying(false)}
            onError={() => {
              if (!isTranscoded) {
                fallbackDirectPreview("浏览器报告媒体加载错误", autoplay);
                return;
              }
              const message = "此视频无法在内嵌播放器中播放";
              setPlayerError(message);
              setPlayerState("error");
              writeClientLog("error", `内嵌预览加载失败：${video.path}`);
            }}
          />
        )}
        {playerState === "loading" && <div className="preview-status">正在准备内嵌预览…</div>}
        {playerState === "error" && (
          <div className="preview-error">
            <span>{playerError ?? "预览不可用"}</span>
            <button type="button" onClick={openExternally}>使用外部播放器打开</button>
          </div>
        )}
      </div>
      {isTranscoded && <p className="transcode-notice">实时转码预览：拖动结束后会从目标位置重新开始转码</p>}
      <div
        className="player-controls"
        aria-label="播放器控制"
        onPointerEnter={keepFullscreenControlsVisible}
        onPointerLeave={showFullscreenControls}
      >
        <button type="button" aria-label={isPlaying ? "暂停" : "播放"} title={isPlaying ? "暂停" : "播放"} onClick={togglePlayback} disabled={playerState !== "ready"}>
          {isPlaying ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <span className="player-time">{formatPlaybackTime(currentTime)} / {formatPlaybackTime(duration)}</span>
        <input
          className="player-progress"
          type="range"
          min="0"
          max={duration || 0}
          step="0.1"
          value={Math.min(currentTime, duration || 0)}
          aria-label="播放进度"
          disabled={playerState !== "ready" || duration <= 0}
          onPointerDown={() => {
            isScrubbing.current = true;
          }}
          onInput={(event) => setCurrentTime(Number(event.currentTarget.value))}
          onPointerUp={(event) => {
            isScrubbing.current = false;
            seek(Number(event.currentTarget.value));
          }}
          onPointerCancel={() => {
            isScrubbing.current = false;
          }}
          onKeyUp={(event) => {
            if (["ArrowLeft", "ArrowRight", "Home", "End", "PageDown", "PageUp"].includes(event.key)) {
              seek(Number(event.currentTarget.value));
            }
          }}
        />
        <button
          type="button"
          aria-label={isMuted ? "取消静音" : "静音"}
          title={isMuted ? "取消静音" : "静音"}
          onClick={() => {
            const nextMuted = !isMuted;
            setIsMuted(nextMuted);
            onAudioPreferenceChange(playerVolume, nextMuted, true);
          }}
          disabled={playerState !== "ready"}
        >
          {isMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
        <input
          className="player-volume"
          type="range"
          min="0"
          max="100"
          value={isMuted ? 0 : playerVolume}
          aria-label="音量"
          disabled={playerState !== "ready"}
          onInput={(event) => {
            const nextVolume = Number(event.currentTarget.value);
            const element = videoElement.current;
            if (element) {
              element.volume = (nextVolume || playerVolume) / 100;
              element.muted = nextVolume === 0;
            }
            if (nextVolume > 0) {
              setPlayerVolume(nextVolume);
              setIsMuted(false);
              onAudioPreferenceChange(nextVolume, false);
            } else {
              setIsMuted(true);
              onAudioPreferenceChange(playerVolume, true);
            }
          }}
        />
        <select aria-label="播放速率" value={rate} disabled={playerState !== "ready"} onChange={(event) => setRate(Number(event.target.value))}>
          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => <option key={value} value={value}>{value}×</option>)}
        </select>
        <button type="button" aria-label={isFullscreen ? "退出全屏" : "全屏"} title={isFullscreen ? "退出全屏" : "全屏"} disabled={playerState !== "ready"} onClick={toggleFullscreen}>
          {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>
    </section>
  );
});
