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
  // Playback permission is deliberately independent from media loading. A late stream URL,
  // fallback, or canplay event must never undo an explicit user pause.
  const playbackIntent = useRef(false);
  const activeMediaRequest = useRef(0);
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
      writeClientLog("debug", "播放器进入空闲状态：当前没有选中视频");
      return;
    }
    writeClientLog("info", `播放器准备直连预览：${video.path}`);
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
    setDuration(video?.duration ?? 0);
    streamStartTime.current = 0;
    playbackIntent.current = Boolean(video && autoplay);
    activeMediaRequest.current = 0;
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
            activeMediaRequest.current = request;
            setStreamUrl(url);
            setIsTranscoded(nextIsTranscoded);
            setDuration(streamDuration ?? video.duration ?? 0);
            writeClientLog(
              "info",
              `播放器流地址创建完成：${video.path}，转码 ${nextIsTranscoded}，时长 ${streamDuration ?? video.duration ?? 0}`,
            );
          } else {
            writeClientLog("debug", `播放器流地址结果已过期，忽略 UI 更新：${video.path}，请求 ${request}`);
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
      writeClientLog("debug", `播放器视频发生切换或卸载，停止旧转码：${video.path}`);
      void invoke("stop_transcoded_preview", { path: video.path }).catch((error: unknown) => {
        writeClientLog("warn", `停止旧转码预览失败：${video.path}，${errorMessage(error)}`);
      });
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
      playbackIntent.current = true;
      writeClientLog("info", `请求播放视频：${video?.path ?? ""}`);
      void element.play().catch((error) => {
        const message = errorMessage(error);
        setPlayerError(message);
        writeClientLog("error", `播放预览失败：${video?.path ?? ""}，${message}`);
      });
    } else {
      playbackIntent.current = false;
      writeClientLog("info", `请求暂停视频：${video?.path ?? ""}`);
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
    playbackIntent.current = resume;
    activeMediaRequest.current = 0;
    setCurrentTime(targetTime);
    setPlayerError(null);
    setPlayerState("loading");
    setStreamUrl(null);
    writeClientLog(
      "info",
      `请求 FFmpeg 转码预览：${video.path}，位置 ${targetTime.toFixed(3)} 秒，恢复播放 ${resume}，请求 ${request}`,
    );
    void invoke<VideoStreamUrl>("get_video_stream_url", {
      path: video.path,
      startSeconds: targetTime,
      forceTranscode: true,
      knownDuration: duration > 0 ? duration : undefined,
    })
      .then(({ url, isTranscoded: nextIsTranscoded, duration: streamDuration }) => {
        if (request === streamRequest.current) {
          activeMediaRequest.current = request;
          setIsTranscoded(nextIsTranscoded);
          setDuration(streamDuration ?? duration);
          setStreamUrl(url);
          writeClientLog(
            "info",
            `FFmpeg 转码预览地址创建完成：${video.path}，位置 ${targetTime.toFixed(3)} 秒，请求 ${request}`,
          );
        } else {
          writeClientLog(
            "debug",
            `FFmpeg 转码预览结果已被更新的定位请求取代：${video.path}，位置 ${targetTime.toFixed(3)} 秒，请求 ${request}`,
          );
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
    if (!video || !Number.isFinite(nextTime)) {
      return;
    }
    const targetTime = Math.min(Math.max(0, nextTime), duration);
    if (!isTranscoded) {
      if (!element) {
        return;
      }
      element.currentTime = targetTime;
      setCurrentTime(targetTime);
      writeClientLog("info", `直连播放器定位：${video.path} -> ${targetTime.toFixed(3)} 秒`);
      return;
    }
    const resume = playbackIntent.current;
    writeClientLog("info", `转码播放器定位：${video.path} -> ${targetTime.toFixed(3)} 秒`);
    startTranscodedPreview(targetTime, resume);
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
    playbackIntent.current = false;
    const element = videoElement.current;
    if (element) {
      element.pause();
    }
    setIsPlaying(false);
    writeClientLog("debug", `播放器停止当前播放请求：${video?.path ?? "无视频"}`);
  };

  const releasePlayback = () => {
    playbackIntent.current = false;
    activeMediaRequest.current = 0;
    const element = videoElement.current;
    if (element) {
      element.removeAttribute("src");
      element.load();
    }
    setStreamUrl(null);
    setPlayerState("idle");
    if (video) {
      writeClientLog("info", `播放器释放媒体资源：${video.path}`);
      void invoke("stop_transcoded_preview", { path: video.path }).catch((error: unknown) => {
        writeClientLog("warn", `释放播放器资源时停止转码失败：${video.path}，${errorMessage(error)}`);
      });
    }
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
    writeClientLog("info", `播放器错误恢复：使用系统默认应用打开 ${video.path}`);
    void invoke("open_video_externally", { path: video.path })
      .then(() => writeClientLog("info", `已将视频交给系统默认应用：${video.path}`))
      .catch((error: unknown) => {
        writeClientLog("error", `使用外部播放器打开失败：${video.path}，${errorMessage(error)}`);
      });
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement === playerRoot.current) {
      writeClientLog("info", `退出播放器全屏：${video?.path ?? ""}`);
      void document.exitFullscreen?.().catch((error: unknown) => {
        writeClientLog("warn", `退出播放器全屏失败：${errorMessage(error)}`);
      });
    } else {
      writeClientLog("info", `进入播放器全屏：${video?.path ?? ""}`);
      void playerRoot.current?.requestFullscreen?.().catch((error: unknown) => {
        writeClientLog("warn", `进入播放器全屏失败：${errorMessage(error)}`);
      });
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
                  playbackIntent.current,
                );
                return;
              }
              if (activeMediaRequest.current !== streamRequest.current) {
                writeClientLog("debug", `忽略过期媒体源的 canplay 事件：${video.path}`);
                return;
              }
              setPlayerState("ready");
              writeClientLog(
                "info",
                `播放器可以播放：${video.path}，模式 ${isTranscoded ? "FFmpeg 转码" : "原文件直连"}，尺寸 ${event.currentTarget.videoWidth}×${event.currentTarget.videoHeight}`,
              );
              if (playbackIntent.current) {
                void videoElement.current?.play().catch((error) => {
                  writeClientLog("warn", `自动播放预览被阻止：${video.path}，${errorMessage(error)}`);
                });
              }
            }}
            onLoadedMetadata={(event) => {
              if (!isTranscoded && (event.currentTarget.videoWidth === 0 || event.currentTarget.videoHeight === 0)) {
                fallbackDirectPreview(
                  `loadedmetadata 时视频尺寸为 ${event.currentTarget.videoWidth}×${event.currentTarget.videoHeight}`,
                  playbackIntent.current,
                );
                return;
              }
              if (!isTranscoded && Number.isFinite(event.currentTarget.duration)) {
                setDuration(event.currentTarget.duration);
              }
              writeClientLog(
                "debug",
                `播放器元数据已加载：${video.path}，模式 ${isTranscoded ? "转码" : "直连"}，时长 ${event.currentTarget.duration}，尺寸 ${event.currentTarget.videoWidth}×${event.currentTarget.videoHeight}`,
              );
            }}
            onTimeUpdate={(event) => {
              if (!isScrubbing.current) {
                setCurrentTime(streamStartTime.current + event.currentTarget.currentTime);
              }
            }}
            onPlay={() => {
              if (!playbackIntent.current || activeMediaRequest.current !== streamRequest.current) {
                writeClientLog("warn", `播放器拒绝非预期播放事件：${video.path}`);
                videoElement.current?.pause();
                return;
              }
              setIsPlaying(true);
              writeClientLog("info", `播放器开始播放：${video.path}`);
            }}
            onPause={() => {
              setIsPlaying(false);
              writeClientLog("info", `播放器暂停：${video.path}`);
            }}
            onEnded={() => {
              playbackIntent.current = false;
              setIsPlaying(false);
              writeClientLog("info", `播放器播放结束：${video.path}`);
            }}
            onError={() => {
              if (!isTranscoded) {
                fallbackDirectPreview("浏览器报告媒体加载错误", playbackIntent.current);
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
          disabled={duration <= 0}
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
            writeClientLog("info", `播放器静音状态更新：${video.path}，静音 ${nextMuted}`);
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
          onPointerUp={() => writeClientLog("info", `播放器音量调整完成：${video.path}，音量 ${isMuted ? 0 : playerVolume}`)}
          onKeyUp={() => writeClientLog("debug", `播放器键盘调整音量：${video.path}，音量 ${isMuted ? 0 : playerVolume}`)}
        />
        <select
          aria-label="播放速率"
          value={rate}
          disabled={playerState !== "ready"}
          onChange={(event) => {
            const nextRate = Number(event.target.value);
            setRate(nextRate);
            writeClientLog("info", `播放器速率调整：${video.path}，${rate}x -> ${nextRate}x`);
          }}
        >
          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => <option key={value} value={value}>{value}×</option>)}
        </select>
        <button type="button" aria-label={isFullscreen ? "退出全屏" : "全屏"} title={isFullscreen ? "退出全屏" : "全屏"} disabled={playerState !== "ready"} onClick={toggleFullscreen}>
          {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>
    </section>
  );
});
