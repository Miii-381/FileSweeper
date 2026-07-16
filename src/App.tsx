import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { watch } from "@tauri-apps/plugin-fs";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  attachLogger,
  debug as logDebug,
  error as logErrorMessage,
  info as logInfo,
  LogLevel,
  warn as logWarn,
} from "@tauri-apps/plugin-log";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { colorModeTokens, themePresets, type ThemeId } from "./theme";
import {
  ArrowDown,
  ArrowUp,
  ClipboardCopy,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Grid2X2,
  HardDrive,
  List,
  LoaderCircle,
  Monitor,
  MonitorPlay,
  Moon,
  Maximize2,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  ScrollText,
  Star,
  StarOff,
  Sun,
  Trash2,
  Video,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  forwardRef,
  memo,
  startTransition,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

type ViewMode = "grid" | "list";
type ColorMode = "dark" | "light";
type SortKey = "createdAt" | "name" | "size" | "duration" | "resolution";
type ListColumnId = "name" | "size" | "duration" | "resolution" | "modifiedAt";
type ThumbnailCapturePosition = "opening" | "early" | "middle" | "late" | "ending";
type LogMinimumLevel = "warn" | "info" | "debug";

const MAX_THUMBNAIL_CONCURRENCY = 10;
const GRID_CARD_WIDTH = 220;
// 180px card height plus the 16px vertical track gap kept between virtual rows.
const GRID_ROW_HEIGHT = 196;
const LIST_ROW_HEIGHT = 40;

type DirectoryEntry = {
  path: string;
  name: string;
  hasChildren: boolean;
};

type VideoEntry = {
  path: string;
  name: string;
  extension: string;
  size: number;
  createdAt: number | null;
  modifiedAt: number | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  thumbnailPath: string | null;
};

type WorkspaceSelectionBox = {
  viewMode: ViewMode;
  left: number;
  top: number;
  width: number;
  height: number;
};

type WorkspaceSelectionGesture = {
  viewMode: ViewMode;
  pointerId: number;
  root: HTMLDivElement;
  startClientX: number;
  startClientY: number;
  lastClientX: number;
  lastClientY: number;
  initialSelection: Set<string>;
  intersectedPaths: Set<string>;
  additive: boolean;
  moved: boolean;
  hasAutoScrolled: boolean;
};

type FileDragGesture = {
  pointerId: number;
  root: HTMLDivElement;
  startClientX: number;
  startClientY: number;
  paths: string[];
  started: boolean;
};

type DirectoryListing = {
  path: string;
  folders: DirectoryEntry[];
  videos: VideoEntry[];
  mediaSuppressed: boolean;
};

type RecycleResult = {
  recycledPaths: string[];
  failedPaths: string[];
};

type RenameResult = {
  oldPath: string;
  newPath: string;
  name: string;
};

type CopyResult = {
  copiedPaths: string[];
  skippedPaths: string[];
  failedPaths: string[];
};

type WorkspaceContextMenu = {
  x: number;
  y: number;
  workspacePath: string;
  paths: string[];
  primaryPath: string | null;
};

type VideoStreamUrl = {
  url: string;
  isTranscoded: boolean;
  duration: number | null;
};

type VideoMetadata = {
  path: string;
  duration: number | null;
  width: number | null;
  height: number | null;
};

type MetadataBatchResult = {
  metadata: VideoMetadata[];
  failedPaths: string[];
};

type ThumbnailResult = {
  path: string;
  thumbnailPath: string;
};

type ThumbnailFailure = {
  path: string;
  error: string;
};

type ThumbnailBatchResult = {
  thumbnails: ThumbnailResult[];
  failures: ThumbnailFailure[];
};

type ThumbnailData = {
  path: string;
  thumbnailPath: string;
  dataUrl: string;
};

type ThumbnailTask = {
  video: VideoEntry;
};

type LogSnapshot = {
  path: string;
  content: string;
  size: number;
};

type LiveLogEntry = {
  id: number;
  level: LogLevel;
  message: string;
};

type Preferences = {
  appearance: "system" | ColorMode;
  accentTheme: ThemeId;
  thumbnailCacheGb: number;
  thumbnailCapturePosition: ThumbnailCapturePosition;
  autoplay: boolean;
  volume: number;
  muted: boolean;
  rememberWorkspaceFocus: boolean;
  showHiddenItems: boolean;
  showNomediaMedia: boolean;
  videoExtensions: string[];
  managedVideoExtensions: string[];
  openUnsupportedExternally: boolean;
  listColumns: ListColumn[];
};

type FavoriteFolder = {
  path: string;
  name: string;
};

type WorkspaceFocus = {
  videoPath: string;
};

type ListColumn = {
  id: ListColumnId;
  visible: boolean;
  width: number;
};

type AppConfig = {
  version: number;
  favorites: FavoriteFolder[];
  lastWorkspace: string | null;
  workspaceFocus: Record<string, WorkspaceFocus>;
  settings: Preferences;
};

type ApplicationState = {
  config: AppConfig;
  roots: DirectoryEntry[];
};

type TreeStatus = "idle" | "loading" | "loaded" | "error";
type TreeState = Record<string, { status: TreeStatus; folders: DirectoryEntry[] }>;

const thumbnailDataUrls = new Map<string, string>();
const thumbnailDataRequests = new Map<string, Promise<string>>();

const fallbackConfig: AppConfig = {
  version: 1,
  favorites: [],
  lastWorkspace: null,
  workspaceFocus: {},
  settings: {
    appearance: "dark",
    accentTheme: "teal",
    thumbnailCacheGb: 2,
    thumbnailCapturePosition: "middle",
    autoplay: true,
    volume: 100,
    muted: false,
    rememberWorkspaceFocus: true,
    showHiddenItems: false,
    showNomediaMedia: false,
    videoExtensions: [
      ".mp4",
      ".mkv",
      ".webm",
      ".avi",
      ".mov",
      ".wmv",
      ".flv",
      ".m4v",
      ".mpeg",
      ".mpg",
      ".3gp",
      ".rm",
      ".rmvb",
      ".ts",
    ],
    managedVideoExtensions: [
      ".mp4",
      ".mkv",
      ".webm",
      ".avi",
      ".mov",
      ".wmv",
      ".flv",
      ".m4v",
      ".mpeg",
      ".mpg",
      ".3gp",
      ".rm",
      ".rmvb",
      ".ts",
    ],
    openUnsupportedExternally: true,
    listColumns: [
      { id: "name", visible: true, width: 280 },
      { id: "size", visible: true, width: 112 },
      { id: "duration", visible: true, width: 94 },
      { id: "resolution", visible: true, width: 112 },
      { id: "modifiedAt", visible: true, width: 170 },
    ],
  },
};

const listColumnLabels: Record<ListColumnId, string> = {
  name: "名称",
  size: "大小",
  duration: "时长",
  resolution: "分辨率",
  modifiedAt: "最后修改时间",
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(size) / Math.log(1024)) - 1, units.length - 1);
  return `${(size / 1024 ** (unitIndex + 1)).toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDate(timestamp: number | null) {
  if (!timestamp) {
    return "-";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatDuration(duration: number | null) {
  return duration === null ? "-" : formatPlaybackTime(duration);
}

function formatResolution(video: VideoEntry) {
  return video.width && video.height ? `${video.width} × ${video.height}` : "-";
}

function formatPlaybackTime(value: number) {
  if (!Number.isFinite(value) || value < 0) {
    return "--:--";
  }
  const totalSeconds = Math.floor(value);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
    : `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function logLevelLabel(level: LogLevel) {
  return LogLevel[level]?.toUpperCase() ?? "LOG";
}

function logLevelRank(level: string) {
  if (level.includes("ERROR")) {
    return 4;
  }
  if (level.includes("WARN")) {
    return 3;
  }
  if (level.includes("INFO")) {
    return 2;
  }
  if (level.includes("DEBUG")) {
    return 1;
  }
  return 0;
}

function minimumLogLevelRank(level: LogMinimumLevel) {
  return level === "warn" ? 3 : level === "info" ? 2 : 1;
}

function filterLogContent(content: string, minimumLevel: LogMinimumLevel) {
  const requiredRank = minimumLogLevelRank(minimumLevel);
  return content
    .split("\n")
    .filter((line) => {
      const level = line.match(/\]\[(TRACE|DEBUG|INFO|WARN|ERROR)\]/i)?.[1];
      return level ? logLevelRank(level.toUpperCase()) >= requiredRank : false;
    })
    .join("\n");
}

function writeClientLog(level: "debug" | "info" | "warn" | "error", message: string) {
  const logger =
    level === "debug" ? logDebug : level === "info" ? logInfo : level === "warn" ? logWarn : logErrorMessage;
  void logger(message, { file: "src/App.tsx" }).catch(() => {
    // The Vite browser shell has no Tauri log plugin; ignore that path during local UI-only previews.
  });
}

function loadThumbnailData(video: VideoEntry, thumbnailPath: string | null) {
  if (!thumbnailPath) {
    return Promise.resolve<string | null>(null);
  }

  const cached = thumbnailDataUrls.get(thumbnailPath);
  if (cached) {
    return Promise.resolve(cached);
  }

  const pending = thumbnailDataRequests.get(thumbnailPath);
  if (pending) {
    return pending;
  }

  const request = invoke<ThumbnailData>("read_thumbnail", { path: video.path })
    .then((result) => {
      thumbnailDataUrls.set(result.thumbnailPath, result.dataUrl);
      return result.dataUrl;
    })
    .finally(() => {
      thumbnailDataRequests.delete(thumbnailPath);
    });
  thumbnailDataRequests.set(thumbnailPath, request);
  return request;
}

const VideoThumbnail = memo(function VideoThumbnail({
  video,
  thumbnailPath,
  visibilityRevision,
  compact = false,
  onVisible,
}: {
  video: VideoEntry;
  thumbnailPath: string | null;
  visibilityRevision: number;
  compact?: boolean;
  onVisible?: (video: VideoEntry) => void;
}) {
  const thumbnailElement = useRef<HTMLSpanElement>(null);
  const [failedPath, setFailedPath] = useState<string | null>(null);
  const [thumbnailSrc, setThumbnailSrc] = useState<string | null>(() =>
    thumbnailPath ? thumbnailDataUrls.get(thumbnailPath) ?? null : null,
  );

  useEffect(() => {
    let active = true;
    setFailedPath(null);

    if (!thumbnailPath) {
      setThumbnailSrc(null);
      return () => {
        active = false;
      };
    }

    const cached = thumbnailDataUrls.get(thumbnailPath);
    if (cached) {
      setThumbnailSrc(cached);
      return () => {
        active = false;
      };
    }

    setThumbnailSrc(null);
    void loadThumbnailData(video, thumbnailPath)
      .then((source) => {
        if (active) {
          setThumbnailSrc(source);
        }
      })
      .catch((error) => {
        if (active) {
          setFailedPath(thumbnailPath);
          writeClientLog("error", `读取缩略图缓存失败：${thumbnailPath}，${errorMessage(error)}`);
        }
      });

    return () => {
      active = false;
    };
  }, [thumbnailPath, video.path]);

  useEffect(() => {
    if (thumbnailPath || !onVisible) {
      return;
    }

    const element = thumbnailElement.current;
    if (!element) {
      return;
    }
    if (!("IntersectionObserver" in window)) {
      onVisible(video);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onVisible(video);
          observer.disconnect();
        }
      },
      { rootMargin: "240px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [onVisible, thumbnailPath, video, visibilityRevision]);

  const hasImage = thumbnailSrc !== null && thumbnailPath !== failedPath;

  return (
    <span
      ref={thumbnailElement}
      className={`video-thumbnail ${compact ? "compact-thumbnail" : ""} ${hasImage ? "has-image" : ""}`}
    >
      {hasImage ? (
        <img
          src={thumbnailSrc ?? ""}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => {
            setFailedPath(thumbnailPath);
            writeClientLog("error", `缩略图显示失败：${thumbnailPath}`);
          }}
        />
      ) : (
        <>
          <Video size={compact ? 15 : 26} />
          {!compact && <span>{video.extension.slice(1).toUpperCase()}</span>}
        </>
      )}
    </span>
  );
});

type PreviewPlayerHandle = {
  togglePlayback: () => void;
  skipPlayback: (seconds: number) => void;
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

const PreviewPlayer = forwardRef<PreviewPlayerHandle, PreviewPlayerProps>(function PreviewPlayer({
  video,
  thumbnailPath,
  autoplay,
  volume,
  muted,
  onEnsureThumbnail,
  onAudioPreferenceChange,
}, ref) {
  const videoElement = useRef<HTMLVideoElement>(null);
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
  const streamStartTime = useRef(0);
  const streamRequest = useRef(0);
  const resumeAfterSeek = useRef(false);
  const isScrubbing = useRef(false);
  const directFallbackRequested = useRef(false);

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

  useImperativeHandle(
    ref,
    () => ({
      togglePlayback,
      skipPlayback,
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
    <section className="preview-player" aria-label={`${video.name} 的视频预览`}>
      <div className="preview-media" ref={playerSurface}>
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
      <div className="player-controls" aria-label="播放器控制">
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
        <button type="button" aria-label="全屏" title="全屏" disabled={playerState !== "ready"} onClick={() => void playerSurface.current?.requestFullscreen?.()}>
          <Maximize2 size={16} />
        </button>
      </div>
    </section>
  );
});

function DirectoryTreeNode({
  entry,
  depth,
  selectedPath,
  expandedPaths,
  treeState,
  onSelect,
  onToggle,
  onContextMenu,
}: {
  entry: DirectoryEntry;
  depth: number;
  selectedPath: string | null;
  expandedPaths: Set<string>;
  treeState: TreeState;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>, path: string) => void;
}) {
  const isExpanded = expandedPaths.has(entry.path);
  const state = treeState[entry.path];
  const isRoot = depth === 0;

  return (
    <li className="tree-node">
      <div className={`tree-row ${selectedPath === entry.path ? "active" : ""}`} style={{ paddingLeft: 8 + depth * 16 }}>
        {entry.hasChildren ? (
          <button
            className="tree-disclosure"
            type="button"
            aria-label={isExpanded ? `收起 ${entry.name}` : `展开 ${entry.name}`}
            title={isExpanded ? "收起" : "展开"}
            onClick={() => onToggle(entry.path)}
          >
            {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
        ) : (
          <span className="tree-disclosure-spacer" aria-hidden="true" />
        )}
        <button
          className="tree-label"
          type="button"
          title={entry.path}
          aria-current={selectedPath === entry.path ? "page" : undefined}
          onClick={() => onSelect(entry.path)}
          onContextMenu={(event) => onContextMenu(event, entry.path)}
        >
          {isRoot ? <HardDrive size={16} /> : isExpanded ? <FolderOpen size={16} /> : <Folder size={16} />}
          <span>{entry.name}</span>
        </button>
      </div>

      {isExpanded && state?.status === "loading" && <div className="tree-status">正在读取…</div>}
      {isExpanded && state?.status === "error" && <div className="tree-status">无法读取</div>}
      {isExpanded && state?.status === "loaded" && state.folders.length > 0 && (
        <ul className="tree-children">
          {state.folders.map((child) => (
            <DirectoryTreeNode
              entry={child}
              depth={depth + 1}
              key={child.path}
              selectedPath={selectedPath}
              expandedPaths={expandedPaths}
              treeState={treeState}
              onSelect={onSelect}
              onToggle={onToggle}
              onContextMenu={onContextMenu}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export default function App() {
  const [config, setConfig] = useState<AppConfig>(fallbackConfig);
  const [roots, setRoots] = useState<DirectoryEntry[]>([]);
  const [treeState, setTreeState] = useState<TreeState>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [workspace, setWorkspace] = useState<DirectoryListing | null>(null);
  const [thumbnailPathOverrides, setThumbnailPathOverrides] = useState<Map<string, string>>(() => new Map());
  const [thumbnailVisibilityRevision, setThumbnailVisibilityRevision] = useState(0);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedVideos, setSelectedVideos] = useState<Set<string>>(new Set());
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [isPreviewOpen, setIsPreviewOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("createdAt");
  const [sortAscending, setSortAscending] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isLogPanelOpen, setIsLogPanelOpen] = useState(false);
  const [logMinimumLevel, setLogMinimumLevel] = useState<LogMinimumLevel>("warn");
  const [settingsDraft, setSettingsDraft] = useState<Preferences>(fallbackConfig.settings);
  const [newVideoExtension, setNewVideoExtension] = useState("");
  const [systemColorMode, setSystemColorMode] = useState<ColorMode>("dark");
  const [toast, setToast] = useState<string | null>(null);
  const [logSnapshot, setLogSnapshot] = useState<LogSnapshot | null>(null);
  const [logPanelError, setLogPanelError] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [liveLogs, setLiveLogs] = useState<LiveLogEntry[]>([]);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [selectedMetadataLoading, setSelectedMetadataLoading] = useState(false);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [isExternalDropActive, setIsExternalDropActive] = useState(false);
  const [workspaceSelectionBox, setWorkspaceSelectionBox] = useState<WorkspaceSelectionBox | null>(null);
  const [workspaceContextMenu, setWorkspaceContextMenu] = useState<WorkspaceContextMenu | null>(null);
  const [gridColumns, setGridColumns] = useState(1);
  const [gridViewport, setGridViewport] = useState<HTMLDivElement | null>(null);
  const [suppressPreviewAutoplay, setSuppressPreviewAutoplay] = useState(false);
  const [workspaceMinSize, setWorkspaceMinSize] = useState(34);
  const [draggedListColumn, setDraggedListColumn] = useState<ListColumnId | null>(null);
  const [listColumnDropTarget, setListColumnDropTarget] = useState<ListColumnId | null>(null);
  const [listColumnDropPosition, setListColumnDropPosition] = useState<"before" | "after" | null>(null);
  // A later folder click supersedes earlier scans that are still waiting for the Rust command.
  const workspaceRequest = useRef(0);
  const metadataRequest = useRef(0);
  const selectedMetadataRequest = useRef(0);
  const probedMetadataPaths = useRef<Set<string>>(new Set());
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameSubmitting = useRef(false);
  const renameCancelling = useRef(false);
  const workspaceSelectionGesture = useRef<WorkspaceSelectionGesture | null>(null);
  const workspaceSelectionAutoScrollFrame = useRef<number | null>(null);
  const workspaceFocusRestorePath = useRef<string | null>(null);
  const workspaceFocusRestorePending = useRef(false);
  const workspaceFocusByPath = useRef<Record<string, WorkspaceFocus>>({});
  const workspaceFocusPersistence = useRef<Promise<void>>(Promise.resolve());
  const suppressBackgroundSelectionClear = useRef(false);
  const fileDragGesture = useRef<FileDragGesture | null>(null);
  const previewPlayerRef = useRef<PreviewPlayerHandle>(null);
  const toastTimeout = useRef<number | null>(null);
  const panelGroupRef = useRef<HTMLDivElement>(null);
  const gridScrollElement = useRef<HTMLDivElement>(null);
  const listScrollElement = useRef<HTMLDivElement>(null);
  const workspaceVideoPaths = useRef<Set<string>>(new Set());
  const thumbnailRequests = useRef<Set<string>>(new Set());
  const thumbnailPathOverrideRef = useRef<Map<string, string>>(new Map());
  const queuedThumbnailPaths = useRef<Set<string>>(new Set());
  const thumbnailQueue = useRef<ThumbnailTask[]>([]);
  const runThumbnailQueue = useRef<() => void>(() => {});
  const thumbnailDispatchScheduled = useRef(false);
  const thumbnailScrollActive = useRef(false);
  const thumbnailScrollTimer = useRef<number | null>(null);
  const thumbnailFailures = useRef<Set<string>>(new Set());
  const liveLogCounter = useRef(0);
  const audioPreferenceTimer = useRef<number | null>(null);
  const pendingAudioConfig = useRef<AppConfig | null>(null);

  const persistWorkspaceFocus = useCallback(async (workspacePath: string, videoPath: string) => {
    if (workspaceFocusByPath.current[workspacePath]?.videoPath === videoPath) {
      writeClientLog("debug", `工作区焦点无需保存：工作区 ${workspacePath}，视频 ${videoPath}`);
      await workspaceFocusPersistence.current;
      return;
    }
    workspaceFocusByPath.current = {
      ...workspaceFocusByPath.current,
      [workspacePath]: { videoPath },
    };
    setConfig((current) => ({
      ...current,
      workspaceFocus: {
        ...current.workspaceFocus,
        [workspacePath]: { videoPath },
      },
    }));
    writeClientLog("debug", `开始保存工作区焦点：工作区 ${workspacePath}，视频 ${videoPath}`);
    const pending = workspaceFocusPersistence.current.then(async () => {
      try {
        await invoke("set_workspace_focus", { workspacePath, videoPath });
        writeClientLog("debug", `工作区焦点已写入配置：工作区 ${workspacePath}，视频 ${videoPath}`);
      } catch (error) {
        writeClientLog("warn", `保存工作区视频焦点失败：工作区 ${workspacePath}，视频 ${videoPath}，${errorMessage(error)}`);
      }
    });
    workspaceFocusPersistence.current = pending;
    await pending;
  }, []);
  const setGridScrollRef = useCallback((element: HTMLDivElement | null) => {
    gridScrollElement.current = element;
    setGridViewport(element);
  }, []);

  const effectiveColorMode: ColorMode =
    config.settings.appearance === "system" ? systemColorMode : config.settings.appearance;
  const activeTheme = themePresets.find((theme) => theme.id === config.settings.accentTheme) ?? themePresets[0];
  const selectedVideo = useMemo(
    () =>
      workspace?.videos.find((video) => video.path === selectionAnchor) ??
      workspace?.videos.find((video) => selectedVideos.has(video.path)) ??
      null,
    [selectedVideos, selectionAnchor, workspace],
  );
  const visibleListColumns = useMemo(
    () => config.settings.listColumns.filter((column) => column.visible),
    [config.settings.listColumns],
  );
  const listGridStyle = useMemo(
    () =>
      ({
        "--list-columns": visibleListColumns
          .map((column) => (column.id === "name" ? `minmax(180px, ${column.width}px)` : `${column.width}px`))
          .join(" "),
      }) as CSSProperties,
    [visibleListColumns],
  );
  const filteredFileLogs = useMemo(
    () => filterLogContent(logSnapshot?.content ?? "", logMinimumLevel),
    [logMinimumLevel, logSnapshot],
  );
  const filteredLiveLogs = useMemo(
    () =>
      liveLogs.filter(
        (entry) => logLevelRank(logLevelLabel(entry.level)) >= minimumLogLevelRank(logMinimumLevel),
      ),
    [liveLogs, logMinimumLevel],
  );

  // The visible ordering is also the source of truth for range selection.
  const visibleVideos = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    const videos = workspace?.videos.filter((video) => video.name.toLocaleLowerCase().includes(normalizedQuery)) ?? [];
    return videos.slice().sort((left, right) => {
      const comparison =
        sortKey === "name"
          ? left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" })
          : sortKey === "size"
            ? left.size - right.size
            : sortKey === "duration"
              ? (left.duration ?? -1) - (right.duration ?? -1)
              : sortKey === "resolution"
                ? (left.width ?? 0) * (left.height ?? 0) - (right.width ?? 0) * (right.height ?? 0)
                : (left.createdAt ?? 0) - (right.createdAt ?? 0);
      return sortAscending ? comparison : -comparison;
    });
  }, [searchQuery, sortAscending, sortKey, workspace]);

  const gridRowVirtualizer = useVirtualizer({
    count: Math.ceil(visibleVideos.length / gridColumns),
    getScrollElement: () => gridScrollElement.current,
    estimateSize: () => GRID_ROW_HEIGHT,
    overscan: 2,
  });
  const listRowVirtualizer = useVirtualizer({
    count: visibleVideos.length,
    getScrollElement: () => listScrollElement.current,
    estimateSize: () => LIST_ROW_HEIGHT,
    overscan: 8,
  });

  const themeStyle = {
    ...colorModeTokens[effectiveColorMode],
    "--accent": activeTheme.color,
    "--accent-soft": activeTheme.soft,
    "--accent-deep": effectiveColorMode === "light" ? activeTheme.lightDeep : activeTheme.deep,
    "--accent-border": activeTheme.border,
    "--accent-ink": activeTheme.ink,
    "--accent-focus": activeTheme.focus,
  } as CSSProperties;

  const handleThumbnailViewportScroll = useCallback(() => {
    thumbnailScrollActive.current = true;
    thumbnailQueue.current = [];
    queuedThumbnailPaths.current.clear();
    if (thumbnailScrollTimer.current) {
      window.clearTimeout(thumbnailScrollTimer.current);
    }
    thumbnailScrollTimer.current = window.setTimeout(() => {
      thumbnailScrollActive.current = false;
      thumbnailScrollTimer.current = null;
      setThumbnailVisibilityRevision((revision) => revision + 1);
    }, 180);
  }, []);

  useEffect(() => {
    workspaceVideoPaths.current = new Set(workspace?.videos.map((video) => video.path) ?? []);
  }, [workspace]);

  useEffect(() => {
    if (!config.settings.rememberWorkspaceFocus || !workspace || !selectionAnchor || !selectedVideos.has(selectionAnchor)) {
      return;
    }
    if (workspaceFocusByPath.current[workspace.path]?.videoPath === selectionAnchor) {
      return;
    }
    const workspacePath = workspace.path;
    const videoPath = selectionAnchor;
    writeClientLog("debug", `工作区焦点将在 350ms 后保存：工作区 ${workspacePath}，视频 ${videoPath}`);
    const timer = window.setTimeout(() => {
      void persistWorkspaceFocus(workspacePath, videoPath);
    }, 350);
    return () => {
      window.clearTimeout(timer);
      writeClientLog("debug", `取消延迟保存工作区焦点：工作区 ${workspacePath}，视频 ${videoPath}`);
    };
  }, [config.settings.rememberWorkspaceFocus, persistWorkspaceFocus, selectedVideos, selectionAnchor, workspace]);

  useLayoutEffect(() => {
    if (viewMode !== "grid" || !gridViewport) {
      return;
    }
    const updateColumnCount = (width = gridViewport.clientWidth) => {
      const availableWidth = Math.max(0, width - 32);
      setGridColumns(Math.max(1, Math.floor((availableWidth + 12) / (GRID_CARD_WIDTH + 12))));
    };
    const observer = new ResizeObserver(([entry]) => updateColumnCount(entry.contentRect.width));
    observer.observe(gridViewport);
    const frame = window.requestAnimationFrame(() => updateColumnCount());
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [gridViewport, viewMode]);

  useEffect(() => {
    if (!workspaceFocusRestorePending.current || !workspace) {
      return;
    }
    if (viewMode === "grid" && !gridViewport) {
      writeClientLog("debug", `等待网格视口挂载后恢复工作区焦点：${workspace.path}`);
      return;
    }
    if (viewMode === "grid" && gridViewport) {
      const availableWidth = Math.max(0, gridViewport.clientWidth - 32);
      const measuredColumns = Math.max(1, Math.floor((availableWidth + 12) / (GRID_CARD_WIDTH + 12)));
      if (gridColumns !== measuredColumns) {
        writeClientLog(
          "debug",
          `等待网格列数稳定后恢复工作区焦点：当前 ${gridColumns} 列，测得 ${measuredColumns} 列，工作区 ${workspace.path}`,
        );
        return;
      }
    }
    const focusPath = workspaceFocusRestorePath.current;
    const videoIndex = focusPath ? visibleVideos.findIndex((video) => video.path === focusPath) : -1;
    if (focusPath && videoIndex < 0) {
      writeClientLog(
        "warn",
        `无法恢复工作区焦点：视频不在当前可见列表中，工作区 ${workspace.path}，视频 ${focusPath}，可见视频 ${visibleVideos.length} 个`,
      );
    } else if (focusPath) {
      writeClientLog(
        "debug",
        `准备恢复工作区焦点：工作区 ${workspace.path}，视频 ${focusPath}，列表索引 ${videoIndex}，视图 ${viewMode}`,
      );
    }
    const restoreScroll = () => {
      if (viewMode === "grid") {
        if (!gridScrollElement.current) {
          writeClientLog("warn", `无法初始化工作区滚动位置：网格滚动容器尚未挂载，工作区 ${workspace.path}`);
          return;
        }
        if (videoIndex >= 0 && focusPath) {
          const rowIndex = Math.floor(videoIndex / gridColumns);
          gridRowVirtualizer.scrollToIndex(rowIndex, { align: "start" });
          writeClientLog("debug", `工作区焦点已定位网格行：视频 ${focusPath}，行 ${rowIndex}，列数 ${gridColumns}`);
        } else {
          gridRowVirtualizer.scrollToOffset(0);
          writeClientLog("debug", `工作区无可恢复焦点，网格滚动位置已重置：${workspace.path}`);
        }
      } else {
        if (!listScrollElement.current) {
          writeClientLog("warn", `无法初始化工作区滚动位置：列表滚动容器尚未挂载，工作区 ${workspace.path}`);
          return;
        }
        if (videoIndex >= 0 && focusPath) {
          listRowVirtualizer.scrollToIndex(videoIndex, { align: "start" });
          writeClientLog("debug", `工作区焦点已定位列表行：视频 ${focusPath}，行 ${videoIndex}`);
        } else {
          listRowVirtualizer.scrollToOffset(0);
          writeClientLog("debug", `工作区无可恢复焦点，列表滚动位置已重置：${workspace.path}`);
        }
      }
      workspaceFocusRestorePending.current = false;
      workspaceFocusRestorePath.current = null;
      if (focusPath && videoIndex >= 0) {
        writeClientLog("debug", `已恢复工作区视频焦点：${focusPath}`);
      }
    };
    const frame = window.requestAnimationFrame(restoreScroll);
    return () => window.cancelAnimationFrame(frame);
  }, [gridColumns, gridRowVirtualizer, gridViewport, listRowVirtualizer, viewMode, visibleVideos, workspace]);

  useEffect(
    () => () => {
      if (thumbnailScrollTimer.current) {
        window.clearTimeout(thumbnailScrollTimer.current);
      }
    },
    [],
  );

  const applyThumbnailResult = useCallback((thumbnail: ThumbnailResult) => {
    if (!workspaceVideoPaths.current.has(thumbnail.path)) {
      return;
    }
    thumbnailDataUrls.delete(thumbnail.thumbnailPath);
    thumbnailPathOverrideRef.current.set(thumbnail.path, thumbnail.thumbnailPath);
    startTransition(() => {
      setThumbnailPathOverrides(new Map(thumbnailPathOverrideRef.current));
    });
  }, []);

  runThumbnailQueue.current = () => {
    const tasks: ThumbnailTask[] = [];
    while (thumbnailRequests.current.size + tasks.length < MAX_THUMBNAIL_CONCURRENCY) {
      const task = thumbnailQueue.current.shift();
      if (!task) {
        break;
      }
      queuedThumbnailPaths.current.delete(task.video.path);
      if (
        task.video.thumbnailPath ||
        thumbnailPathOverrideRef.current.has(task.video.path) ||
        thumbnailRequests.current.has(task.video.path) ||
        thumbnailFailures.current.has(task.video.path)
      ) {
        continue;
      }
      tasks.push(task);
    }
    if (tasks.length === 0) {
      return;
    }

    tasks.forEach((task) => {
      thumbnailRequests.current.add(task.video.path);
    });
    void invoke<ThumbnailBatchResult>("generate_thumbnails", {
      paths: tasks.map((task) => task.video.path),
    })
      .then((result) => {
        // Events normally reach the UI as each JPEG completes; retain this path for event-delivery fallback.
        result.thumbnails.forEach((thumbnail) => {
          if (thumbnailPathOverrideRef.current.get(thumbnail.path) !== thumbnail.thumbnailPath) {
            applyThumbnailResult(thumbnail);
          }
        });
        result.failures.forEach((failure) => {
          thumbnailFailures.current.add(failure.path);
          writeClientLog("error", `缩略图生成失败：${failure.path}，${failure.error}`);
        });
      })
      .catch((error) => {
        const message = errorMessage(error);
        tasks.forEach((task) => {
          thumbnailFailures.current.add(task.video.path);
          writeClientLog("error", `缩略图生成失败：${task.video.path}，${message}`);
        })
      })
      .finally(() => {
        tasks.forEach((task) => thumbnailRequests.current.delete(task.video.path));
        runThumbnailQueue.current();
      });
  };

  const enqueueThumbnail = useCallback(
    (video: VideoEntry) => {
      if (
        !workspace?.path ||
        thumbnailScrollActive.current ||
        video.thumbnailPath ||
        thumbnailPathOverrideRef.current.has(video.path) ||
        thumbnailRequests.current.has(video.path) ||
        queuedThumbnailPaths.current.has(video.path) ||
        thumbnailFailures.current.has(video.path)
      ) {
        return;
      }

      queuedThumbnailPaths.current.add(video.path);
      thumbnailQueue.current.push({ video });
      if (!thumbnailDispatchScheduled.current) {
        thumbnailDispatchScheduled.current = true;
        queueMicrotask(() => {
          thumbnailDispatchScheduled.current = false;
          runThumbnailQueue.current();
        });
      }
    },
    [workspace?.path],
  );

  const updateAudioPreferences = useCallback(
    (volume: number, muted: boolean, persistImmediately = false) => {
      const nextConfig: AppConfig = {
        ...config,
        settings: {
          ...config.settings,
          volume: Math.round(Math.min(100, Math.max(0, volume))),
          muted,
        },
      };
      pendingAudioConfig.current = nextConfig;
      setConfig(nextConfig);

      const persist = () => {
        const pending = pendingAudioConfig.current;
        pendingAudioConfig.current = null;
        if (!pending) {
          return;
        }
        void invoke<AppConfig>("save_configuration", { config: pending })
          .then((saved) => setConfig(saved))
          .catch((error) => {
            writeClientLog("error", `保存播放器音量失败：${errorMessage(error)}`);
          });
      };

      if (audioPreferenceTimer.current) {
        window.clearTimeout(audioPreferenceTimer.current);
        audioPreferenceTimer.current = null;
      }
      if (persistImmediately) {
        persist();
      } else {
        audioPreferenceTimer.current = window.setTimeout(() => {
          audioPreferenceTimer.current = null;
          persist();
        }, 400);
      }
    },
    [config],
  );

  const notify = (message: string) => {
    setToast(message);
    if (toastTimeout.current) {
      window.clearTimeout(toastTimeout.current);
    }
    toastTimeout.current = window.setTimeout(() => setToast(null), 3600);
  };

  const appendLiveLog = (level: LogLevel, message: string) => {
    setLiveLogs((current) => [
      ...current.slice(-199),
      {
        id: ++liveLogCounter.current,
        level,
        message,
      },
    ]);
  };

  const loadLogs = async () => {
    setLogLoading(true);
    setLogPanelError(null);
    try {
      const snapshot = await invoke<LogSnapshot>("read_recent_logs", { maxBytes: 512 * 1024 });
      setLogSnapshot(snapshot);
    } catch (error) {
      const message = errorMessage(error);
      setLogPanelError(message);
      writeClientLog("error", `读取日志失败：${message}`);
    } finally {
      setLogLoading(false);
    }
  };

  const openLogs = () => {
    setLiveLogs([]);
    setLogSnapshot(null);
    setLogPanelError(null);
    setIsLogPanelOpen(true);
    writeClientLog("info", "打开日志面板");
    void loadLogs();
  };

  const closeLogs = () => {
    setIsLogPanelOpen(false);
    setLiveLogs([]);
    setLogSnapshot(null);
    setLogPanelError(null);
  };

  const copyLogs = async () => {
    const content = filteredFileLogs.trim();
    if (!content) {
      notify("暂无日志内容可复制");
      return;
    }
    try {
      await navigator.clipboard.writeText(content);
      notify("日志内容已复制");
      writeClientLog("info", "复制日志内容");
    } catch (error) {
      const message = errorMessage(error);
      notify(message);
      writeClientLog("error", `复制日志失败：${message}`);
    }
  };

  const loadTreeChildren = async (path: string) => {
    writeClientLog("debug", `读取目录树：${path}`);
    setTreeState((current) => ({
      ...current,
      [path]: { status: "loading", folders: current[path]?.folders ?? [] },
    }));
    try {
      const listing = await invoke<DirectoryListing>("list_directory", { path });
      setTreeState((current) => ({
        ...current,
        [path]: { status: "loaded", folders: listing.folders },
      }));
      writeClientLog("info", `目录树读取完成：${path}，子目录 ${listing.folders.length} 个`);
    } catch (error) {
      setTreeState((current) => ({
        ...current,
        [path]: { status: "error", folders: [] },
      }));
      writeClientLog("warn", `目录树读取失败：${path}，${errorMessage(error)}`);
    }
  };

  const activateWorkspace = async (
    requestedPath: string,
    persist = true,
    focusMemoryEnabled = config.settings.rememberWorkspaceFocus,
  ) => {
    if (focusMemoryEnabled && workspace && selectionAnchor && selectedVideos.has(selectionAnchor)) {
      writeClientLog("debug", `切换工作区前保存当前焦点：工作区 ${workspace.path}，视频 ${selectionAnchor}`);
      await persistWorkspaceFocus(workspace.path, selectionAnchor);
    }
    const requestId = ++workspaceRequest.current;
    metadataRequest.current += 1;
    probedMetadataPaths.current.clear();
    setMetadataLoading(false);
    setWorkspaceLoading(true);
    writeClientLog("info", `打开工作区：${requestedPath}`);
    try {
      const listing = await invoke<DirectoryListing>("list_directory", { path: requestedPath });
      if (requestId !== workspaceRequest.current) {
        // Ignore stale responses so rapid directory navigation cannot overwrite the latest workspace.
        return;
      }
      thumbnailQueue.current = [];
      queuedThumbnailPaths.current.clear();
      thumbnailFailures.current.clear();
      thumbnailPathOverrideRef.current.clear();
      setThumbnailPathOverrides(new Map());
      workspaceVideoPaths.current = new Set(listing.videos.map((video) => video.path));
      const rememberedPath = focusMemoryEnabled ? workspaceFocusByPath.current[listing.path]?.videoPath : undefined;
      const rememberedVideo = rememberedPath ? listing.videos.find((video) => video.path === rememberedPath) : null;
      workspaceFocusRestorePath.current = rememberedVideo?.path ?? null;
      workspaceFocusRestorePending.current = true;
      setSuppressPreviewAutoplay(Boolean(rememberedVideo));
      if (rememberedVideo) {
        writeClientLog(
          "debug",
          `工作区焦点命中：工作区 ${listing.path}，视频 ${rememberedVideo.path}，共 ${listing.videos.length} 个视频`,
        );
      } else if (rememberedPath) {
        writeClientLog(
          "warn",
          `工作区焦点未命中：工作区 ${listing.path}，已记录 ${rememberedPath}，当前视频 ${listing.videos.length} 个`,
        );
      } else if (focusMemoryEnabled) {
        writeClientLog("debug", `工作区没有已保存焦点：${listing.path}`);
      } else {
        writeClientLog("debug", `工作区焦点记忆已关闭，滚动位置将从顶部开始：${listing.path}`);
      }
      setWorkspace(listing);
      setSelectedPath(listing.path);
      setSelectedVideos(rememberedVideo ? new Set([rememberedVideo.path]) : new Set());
      setSelectionAnchor(rememberedVideo?.path ?? null);
      setSearchQuery("");
      writeClientLog("info", `工作区读取完成：${listing.path}，视频 ${listing.videos.length} 个`);
      if (persist) {
        const nextConfig = await invoke<AppConfig>("set_last_workspace", { path: listing.path });
        if (requestId === workspaceRequest.current) {
          setConfig(nextConfig);
        }
      }
    } catch (error) {
      if (requestId === workspaceRequest.current) {
        const message = errorMessage(error);
        notify(message);
        writeClientLog("error", `工作区读取失败：${requestedPath}，${message}`);
      }
    } finally {
      if (requestId === workspaceRequest.current) {
        setWorkspaceLoading(false);
      }
    }
  };

  const refreshWorkspace = async (path: string, reason = "目录变更") => {
    try {
      const listing = await invoke<DirectoryListing>("list_directory", { path });
      workspaceVideoPaths.current = new Set(listing.videos.map((video) => video.path));
      setWorkspace((current) => {
        if (!current || current.path !== listing.path) {
          return current;
        }
        const previousByPath = new Map(current.videos.map((video) => [video.path, video]));
        return {
          ...listing,
          videos: listing.videos.map((video) => {
            const previous = previousByPath.get(video.path);
            return previous
              ? {
                  ...video,
                  duration: previous.duration,
                  width: previous.width,
                  height: previous.height,
                }
              : video;
          }),
        };
      });
      const nextPaths = new Set(listing.videos.map((video) => video.path));
      setSelectedVideos((current) => new Set([...current].filter((selectedPath) => nextPaths.has(selectedPath))));
      setSelectionAnchor((current) => (current && nextPaths.has(current) ? current : null));
      writeClientLog("debug", `工作区已刷新：${reason}，视频 ${listing.videos.length} 个`);
    } catch (error) {
      writeClientLog("warn", `刷新工作区失败：${errorMessage(error)}`);
    }
  };

  const loadWorkspaceMetadata = async () => {
    if (!workspace || metadataLoading) {
      return;
    }
    const paths = workspace.videos
      .map((video) => video.path)
      .filter((path) => !probedMetadataPaths.current.has(path));
    if (paths.length === 0) {
      return;
    }
    const requestId = ++metadataRequest.current;
    const workspacePath = workspace.path;
    const metadataByPath = new Map<string, VideoMetadata>();
    setMetadataLoading(true);
    writeClientLog("info", `开始读取媒体信息：${paths.length} 个视频`);
    try {
      for (let start = 0; start < paths.length; start += MAX_THUMBNAIL_CONCURRENCY) {
        const result = await invoke<MetadataBatchResult>("probe_video_metadata_batch_command", {
          paths: paths.slice(start, start + MAX_THUMBNAIL_CONCURRENCY),
        });
        if (requestId !== metadataRequest.current) {
          return;
        }
        result.metadata.forEach((metadata) => {
          metadataByPath.set(metadata.path, metadata);
          probedMetadataPaths.current.add(metadata.path);
        });
        result.failedPaths.forEach((path) => probedMetadataPaths.current.add(path));
      }
      if (requestId === metadataRequest.current) {
        setWorkspace((current) => {
          if (!current || current.path !== workspacePath) {
            return current;
          }
          return {
            ...current,
            videos: current.videos.map((video) => {
              const metadata = metadataByPath.get(video.path);
              return metadata
                ? { ...video, duration: metadata.duration, width: metadata.width, height: metadata.height }
                : video;
            }),
          };
        });
        writeClientLog("info", `媒体信息读取完成：${paths.length} 个视频`);
      }
    } catch (error) {
      if (requestId === metadataRequest.current) {
        const message = errorMessage(error);
        notify(message);
        writeClientLog("warn", `媒体信息读取失败：${message}`);
      }
    } finally {
      if (requestId === metadataRequest.current) {
        setMetadataLoading(false);
      }
    }
  };

  useEffect(() => {
    const requestId = ++selectedMetadataRequest.current;
    const currentVideo = selectedVideo;
    const currentWorkspacePath = workspace?.path;
    const requiresProbe = currentVideo && (
      currentVideo.duration === null ||
      currentVideo.width === null ||
      currentVideo.height === null
    );
    if (!currentVideo || !currentWorkspacePath || !requiresProbe || probedMetadataPaths.current.has(currentVideo.path)) {
      setSelectedMetadataLoading(false);
      return;
    }

    setSelectedMetadataLoading(true);
    writeClientLog("debug", `补充读取右栏媒体信息：${currentVideo.path}`);
    void invoke<MetadataBatchResult>("probe_video_metadata_batch_command", { paths: [currentVideo.path] })
      .then((result) => {
        if (requestId !== selectedMetadataRequest.current) {
          return;
        }
        probedMetadataPaths.current.add(currentVideo.path);
        const metadata = result.metadata.find((item) => item.path === currentVideo.path);
        if (!metadata) {
          writeClientLog("warn", `无法读取右栏媒体信息：${currentVideo.path}`);
          return;
        }
        setWorkspace((current) => {
          if (!current || current.path !== currentWorkspacePath) {
            return current;
          }
          return {
            ...current,
            videos: current.videos.map((video) => (
              video.path === currentVideo.path
                ? {
                    ...video,
                    duration: metadata.duration ?? video.duration,
                    width: metadata.width ?? video.width,
                    height: metadata.height ?? video.height,
                  }
                : video
            )),
          };
        });
        writeClientLog("debug", `右栏媒体信息读取完成：${currentVideo.path}`);
      })
      .catch((error: unknown) => {
        if (requestId === selectedMetadataRequest.current) {
          probedMetadataPaths.current.add(currentVideo.path);
          writeClientLog("warn", `右栏媒体信息读取失败：${currentVideo.path}，${errorMessage(error)}`);
        }
      })
      .finally(() => {
        if (requestId === selectedMetadataRequest.current) {
          setSelectedMetadataLoading(false);
        }
      });
  }, [selectedVideo?.duration, selectedVideo?.height, selectedVideo?.path, selectedVideo?.width, workspace?.path]);

  const toggleTreeNode = (path: string) => {
    const nextExpanded = !expandedPaths.has(path);
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (nextExpanded) {
        next.add(path);
      } else {
        next.delete(path);
      }
      return next;
    });
    if (nextExpanded && treeState[path]?.status !== "loaded") {
      void loadTreeChildren(path);
    }
  };

  const chooseFolder = async (target: "workspace" | "favorite") => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: target === "workspace" ? "打开文件夹" : "添加收藏夹",
      });
      if (typeof selected !== "string") {
        return;
      }
      if (target === "favorite") {
        const nextConfig = await invoke<AppConfig>("toggle_favorite", { path: selected });
        setConfig(nextConfig);
        await activateWorkspace(selected);
      } else {
        await activateWorkspace(selected);
      }
    } catch (error) {
      const message = errorMessage(error);
      notify(message);
      writeClientLog("error", `选择文件夹失败：${message}`);
    }
  };

  const toggleFavorite = async () => {
    if (!workspace) {
      return;
    }
    try {
      const nextConfig = await invoke<AppConfig>("toggle_favorite", { path: workspace.path });
      setConfig(nextConfig);
    } catch (error) {
      const message = errorMessage(error);
      notify(message);
      writeClientLog("error", `更新收藏夹失败：${message}`);
    }
  };

  const selectVideo = (event: ReactMouseEvent<HTMLElement>, path: string) => {
    setSuppressPreviewAutoplay(false);
    if (event.shiftKey && selectionAnchor) {
      const start = visibleVideos.findIndex((video) => video.path === selectionAnchor);
      const end = visibleVideos.findIndex((video) => video.path === path);
      if (start !== -1 && end !== -1) {
        const range = visibleVideos.slice(Math.min(start, end), Math.max(start, end) + 1).map((video) => video.path);
        setSelectedVideos(new Set(range));
        return;
      }
    }

    if (event.ctrlKey || event.metaKey) {
      setSelectedVideos((current) => {
        const next = new Set(current);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        return next;
      });
    } else {
      setSelectedVideos(new Set([path]));
    }
    setSelectionAnchor(path);
  };

  const clearWorkspaceSelection = () => {
    setSelectedVideos(new Set());
    setSelectionAnchor(null);
  };

  const clearSelectionFromBackground = (event: ReactMouseEvent<HTMLElement>) => {
    if (suppressBackgroundSelectionClear.current) {
      suppressBackgroundSelectionClear.current = false;
      return;
    }
    const target = event.target;
    if (!(target instanceof Element) || target.closest(".video-card, .video-list-row, .video-list-header")) {
      return;
    }
    clearWorkspaceSelection();
  };

  const selectionPathsIntersecting = (root: HTMLDivElement, selectionRect: DOMRect) => {
    const paths = new Set<string>();
    root.querySelectorAll<HTMLElement>(".video-card[data-video-path], .video-list-row[data-video-path]").forEach((item) => {
      const itemRect = item.getBoundingClientRect();
      const intersects =
        itemRect.left < selectionRect.right &&
        itemRect.right > selectionRect.left &&
        itemRect.top < selectionRect.bottom &&
        itemRect.bottom > selectionRect.top;
      if (intersects) {
        const path = item.dataset.videoPath;
        if (path) {
          paths.add(path);
        }
      }
    });
    return paths;
  };

  const startWorkspaceRectangleSelection = (event: ReactPointerEvent<HTMLDivElement>, mode: ViewMode) => {
    if (event.button !== 0 || !workspace || visibleVideos.length === 0) {
      return;
    }
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(".video-card, .video-list-row, .video-list-header, input, button, select, a, [contenteditable='true']")
    ) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const rootRect = event.currentTarget.getBoundingClientRect();
    writeClientLog(
      "debug",
      `开始框选：${mode}，鼠标 (${event.clientX}, ${event.clientY})，容器 (${Math.round(rootRect.left)}, ${Math.round(rootRect.top)})，滚动 (${Math.round(event.currentTarget.scrollLeft)}, ${Math.round(event.currentTarget.scrollTop)})`,
    );
    workspaceSelectionGesture.current = {
      viewMode: mode,
      pointerId: event.pointerId,
      root: event.currentTarget,
      startClientX: event.clientX,
      startClientY: event.clientY,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      initialSelection: new Set(selectedVideos),
      intersectedPaths: new Set(),
      additive: event.ctrlKey || event.metaKey || event.shiftKey,
      moved: false,
      hasAutoScrolled: false,
    };
  };

  const stopWorkspaceSelectionAutoScroll = () => {
    if (workspaceSelectionAutoScrollFrame.current !== null) {
      window.cancelAnimationFrame(workspaceSelectionAutoScrollFrame.current);
      workspaceSelectionAutoScrollFrame.current = null;
    }
  };

  const applyWorkspaceRectangleSelection = (
    gesture: WorkspaceSelectionGesture,
    clientX: number,
    clientY: number,
  ) => {
    const width = Math.abs(clientX - gesture.startClientX);
    const height = Math.abs(clientY - gesture.startClientY);
    if (!gesture.moved && width < 4 && height < 4) {
      return;
    }
    gesture.moved = true;
    const leftClient = Math.min(gesture.startClientX, clientX);
    const topClient = Math.min(gesture.startClientY, clientY);
    const selectionRect = new DOMRect(leftClient, topClient, width, height);
    const rootRect = gesture.root.getBoundingClientRect();
    setWorkspaceSelectionBox({
      viewMode: gesture.viewMode,
      // Use viewport coordinates so a scrolling/virtualized container cannot shift the visual box.
      left: leftClient,
      top: topClient,
      width,
      height,
    });
    if (width < 8 && height < 8) {
      writeClientLog(
        "debug",
        `框选进入拖动：${gesture.viewMode}，视口 (${Math.round(leftClient)}, ${Math.round(topClient)})，容器内 (${Math.round(leftClient - rootRect.left + gesture.root.scrollLeft)}, ${Math.round(topClient - rootRect.top + gesture.root.scrollTop)})，尺寸 ${Math.round(width)}×${Math.round(height)}`,
      );
    }
    const intersectingPaths = selectionPathsIntersecting(gesture.root, selectionRect);
    if (gesture.hasAutoScrolled) {
      intersectingPaths.forEach((path) => gesture.intersectedPaths.add(path));
    } else {
      gesture.intersectedPaths = intersectingPaths;
    }
    const nextSelection = gesture.additive ? new Set(gesture.initialSelection) : new Set<string>();
    gesture.intersectedPaths.forEach((path) => nextSelection.add(path));
    setSelectedVideos(nextSelection);
    const nextAnchor = visibleVideos.find((video) => gesture.intersectedPaths.has(video.path))?.path;
    if (nextAnchor) {
      setSelectionAnchor(nextAnchor);
    } else if (nextSelection.size === 0) {
      setSelectionAnchor(null);
    }
  };

  const updateWorkspaceSelectionAutoScroll = (gesture: WorkspaceSelectionGesture) => {
    const edgeSize = 56;
    let scrollStep = 0;
    // Pointer capture keeps this gesture alive outside the workspace, so use the application viewport
    // rather than the scroll container's bounds. This allows a drag to reach the title bar or bottom edge.
    if (gesture.lastClientY <= edgeSize) {
      const proximity = Math.min(1, (edgeSize - gesture.lastClientY) / edgeSize);
      scrollStep = -Math.ceil(5 + proximity * 19);
    } else if (gesture.lastClientY >= window.innerHeight - edgeSize) {
      const proximity = Math.min(1, (gesture.lastClientY - (window.innerHeight - edgeSize)) / edgeSize);
      scrollStep = Math.ceil(5 + proximity * 19);
    }

    if (scrollStep === 0) {
      stopWorkspaceSelectionAutoScroll();
      return;
    }
    if (workspaceSelectionAutoScrollFrame.current !== null) {
      return;
    }

    const tick = () => {
      workspaceSelectionAutoScrollFrame.current = null;
      const activeGesture = workspaceSelectionGesture.current;
      if (!activeGesture || activeGesture !== gesture) {
        return;
      }
      const previousScrollTop = activeGesture.root.scrollTop;
      activeGesture.root.scrollTop = Math.max(0, previousScrollTop + scrollStep);
      if (activeGesture.root.scrollTop === previousScrollTop) {
        return;
      }
      if (!activeGesture.hasAutoScrolled) {
        activeGesture.hasAutoScrolled = true;
        writeClientLog("debug", `框选自动滚动开始：${activeGesture.viewMode}，方向 ${scrollStep > 0 ? "向下" : "向上"}`);
      }
      applyWorkspaceRectangleSelection(activeGesture, activeGesture.lastClientX, activeGesture.lastClientY);
      updateWorkspaceSelectionAutoScroll(activeGesture);
    };
    workspaceSelectionAutoScrollFrame.current = window.requestAnimationFrame(tick);
  };

  const updateWorkspaceRectangleSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = workspaceSelectionGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }
    gesture.lastClientX = event.clientX;
    gesture.lastClientY = event.clientY;
    applyWorkspaceRectangleSelection(gesture, event.clientX, event.clientY);
    updateWorkspaceSelectionAutoScroll(gesture);
  };

  const finishWorkspaceRectangleSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = workspaceSelectionGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }
    stopWorkspaceSelectionAutoScroll();
    workspaceSelectionGesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setWorkspaceSelectionBox(null);
    if (gesture.moved) {
      suppressBackgroundSelectionClear.current = true;
      window.setTimeout(() => {
        suppressBackgroundSelectionClear.current = false;
      }, 0);
      writeClientLog("debug", `完成框选：${gesture.viewMode}，当前选中 ${selectedVideos.size} 个视频`);
    } else {
      clearWorkspaceSelection();
    }
  };

  const startVideoFileDrag = (event: ReactPointerEvent<HTMLDivElement>, path: string) => {
    if (event.button !== 0 || renamingPath === path) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    fileDragGesture.current = {
      pointerId: event.pointerId,
      root: event.currentTarget,
      startClientX: event.clientX,
      startClientY: event.clientY,
      paths: selectedVideos.has(path) ? [...selectedVideos] : [path],
      started: false,
    };
    writeClientLog(
      "debug",
      `准备文件拖出：候选 ${selectedVideos.has(path) ? selectedVideos.size : 1} 个，起点 (${event.clientX}, ${event.clientY})，路径 ${path}`,
    );
  };

  const updateVideoFileDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = fileDragGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.started) {
      return;
    }
    if (Math.hypot(event.clientX - gesture.startClientX, event.clientY - gesture.startClientY) < 7) {
      return;
    }
    gesture.started = true;
    event.preventDefault();
    event.stopPropagation();
    if (gesture.root.hasPointerCapture(event.pointerId)) {
      gesture.root.releasePointerCapture(event.pointerId);
    }
    setSelectedVideos(new Set(gesture.paths));
    setSelectionAnchor(gesture.paths[0] ?? null);
    writeClientLog(
      "debug",
      `达到文件拖出阈值：${gesture.paths.length} 个，位移 ${Math.round(Math.hypot(event.clientX - gesture.startClientX, event.clientY - gesture.startClientY))}px，调用后端 OLE 拖放`,
    );
    void invoke("start_file_drag", { paths: gesture.paths })
      .then(() => writeClientLog("debug", "后端 OLE 拖放会话结束"))
      .catch((error: unknown) => {
        const message = errorMessage(error);
        notify(message);
        writeClientLog("warn", `无法开始或完成文件拖出：${message}`);
      });
  };

  const finishVideoFileDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = fileDragGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }
    fileDragGesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const applyRecycleResult = (result: RecycleResult) => {
    const recycledPaths = new Set(result.recycledPaths);
    recycledPaths.forEach((path) => workspaceVideoPaths.current.delete(path));
    setWorkspace((current) =>
      current ? { ...current, videos: current.videos.filter((video) => !recycledPaths.has(video.path)) } : current,
    );
    setSelectedVideos((current) => new Set([...current].filter((path) => !recycledPaths.has(path))));
    setSelectionAnchor((current) => (current && recycledPaths.has(current) ? null : current));
    if (result.failedPaths.length > 0) {
      notify(`已移到回收站 ${result.recycledPaths.length} 个视频，${result.failedPaths.length} 个失败`);
      writeClientLog(
        "warn",
        `回收站操作部分失败：成功 ${result.recycledPaths.length}，失败 ${result.failedPaths.length}`,
      );
    } else {
      notify(`已将 ${result.recycledPaths.length} 个视频移到回收站`);
      writeClientLog("info", `回收站操作完成：${result.recycledPaths.length} 个视频`);
    }
  };

  const recycleVideos = async (paths: string[]) => {
    if (paths.length === 0 || !window.confirm(`将 ${paths.length} 个视频移到回收站？`)) {
      return;
    }
    try {
      const result = await invoke<RecycleResult>("recycle_videos", { paths });
      applyRecycleResult(result);
    } catch (error) {
      const message = errorMessage(error);
      notify(message);
      writeClientLog("error", `回收站操作失败：${message}`);
    }
  };

  const recycleSelectedVideos = () => recycleVideos([...selectedVideos]);

  const startInlineRename = (path: string) => {
    if (selectedVideos.size !== 1 || !workspace) {
      return;
    }
    const selected = workspace.videos.find((video) => video.path === path);
    if (!selected) {
      return;
    }
    const extensionLength = selected.extension.length;
    const currentStem = extensionLength > 0 ? selected.name.slice(0, -extensionLength) : selected.name;
    renameCancelling.current = false;
    setRenameDraft(currentStem);
    setRenamingPath(selected.path);
  };

  const cancelInlineRename = () => {
    renameCancelling.current = true;
    setRenamingPath(null);
    setRenameDraft("");
    window.requestAnimationFrame(() => {
      renameCancelling.current = false;
    });
  };

  const submitInlineRename = async () => {
    if (renameCancelling.current || renameSubmitting.current || !renamingPath || !workspace) {
      return;
    }
    const selected = workspace.videos.find((video) => video.path === renamingPath);
    if (!selected) {
      cancelInlineRename();
      return;
    }
    const newStem = renameDraft.trim();
    const extensionLength = selected.extension.length;
    const currentStem = extensionLength > 0 ? selected.name.slice(0, -extensionLength) : selected.name;
    if (newStem === currentStem) {
      cancelInlineRename();
      return;
    }
    renameSubmitting.current = true;
    setRenamingPath(null);
    try {
      const result = await invoke<RenameResult>("rename_video", { path: selected.path, newStem });
      await refreshWorkspace(workspace.path, "重命名");
      setSelectedVideos(new Set([result.newPath]));
      setSelectionAnchor(result.newPath);
      notify(`已重命名为 ${result.name}`);
      writeClientLog("info", `重命名视频：${result.oldPath} -> ${result.newPath}`);
    } catch (error) {
      const message = errorMessage(error);
      notify(message);
      writeClientLog("error", `重命名视频失败：${selected.path}，${message}`);
    } finally {
      renameSubmitting.current = false;
      setRenameDraft("");
    }
  };

  const copyDroppedVideos = async (paths: string[], workspacePath: string) => {
    try {
      const result = await invoke<CopyResult>("copy_videos_to_workspace", { paths, workspacePath });
      if (result.copiedPaths.length > 0) {
        await refreshWorkspace(workspacePath, "拖入复制");
      }
      if (result.failedPaths.length > 0 || result.skippedPaths.length > 0) {
        notify(`已复制 ${result.copiedPaths.length} 个视频，跳过 ${result.skippedPaths.length} 个，失败 ${result.failedPaths.length} 个`);
      } else {
        notify(`已复制 ${result.copiedPaths.length} 个视频`);
      }
      writeClientLog(
        result.failedPaths.length > 0 ? "warn" : "info",
        `拖入复制完成：成功 ${result.copiedPaths.length}，跳过 ${result.skippedPaths.length}，失败 ${result.failedPaths.length}`,
      );
    } catch (error) {
      const message = errorMessage(error);
      notify(message);
      writeClientLog("error", `拖入复制失败：${message}`);
    }
  };

  const copyVideosToDirectory = async (paths: string[]) => {
    if (paths.length === 0) {
      return;
    }
    try {
      const destination = await open({ directory: true, multiple: false, title: "复制视频到" });
      if (typeof destination !== "string") {
        return;
      }
      const result = await invoke<CopyResult>("copy_videos_to_workspace", { paths, workspacePath: destination });
      if (result.copiedPaths.length > 0 && workspace?.path === destination) {
        await refreshWorkspace(destination, "复制到当前工作区");
      }
      notify(`已复制 ${result.copiedPaths.length} 个视频，跳过 ${result.skippedPaths.length} 个，失败 ${result.failedPaths.length} 个`);
      writeClientLog(
        result.failedPaths.length > 0 ? "warn" : "info",
        `复制到目录完成：成功 ${result.copiedPaths.length}，跳过 ${result.skippedPaths.length}，失败 ${result.failedPaths.length}`,
      );
    } catch (error) {
      const message = errorMessage(error);
      notify(message);
      writeClientLog("error", `复制到目录失败：${message}`);
    }
  };

  const showPathContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    path: string,
    isDirectory: boolean,
    paths?: string[],
  ) => {
    event.preventDefault();
    void invoke("show_file_context_menu", {
      path,
      paths,
      x: event.clientX,
      y: event.clientY,
      isDirectory,
    }).catch((error: unknown) => {
      const message = errorMessage(error);
      notify(message);
      writeClientLog("error", `打开上下文菜单失败：${message}`);
    });
  };

  const showWorkspaceContextMenu = (event: ReactMouseEvent<HTMLElement>, paths: string[] = []) => {
    if (!workspace) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const primaryPath = paths[0] ?? null;
    setWorkspaceContextMenu({
      x: Math.max(12, Math.min(event.clientX, window.innerWidth - 252)),
      y: Math.max(12, Math.min(event.clientY, window.innerHeight - (paths.length > 0 ? 252 : 146))),
      workspacePath: workspace.path,
      paths,
      primaryPath,
    });
  };

  const runWorkspaceContextMenuAction = async (action: "open" | "reveal" | "copy" | "delete" | "refresh") => {
    const menu = workspaceContextMenu;
    setWorkspaceContextMenu(null);
    if (!menu) {
      return;
    }
    try {
      if (action === "refresh") {
        await refreshWorkspace(menu.workspacePath, "右键手动刷新");
      } else if (action === "open" && menu.primaryPath) {
        await invoke("open_video_externally", { path: menu.primaryPath });
      } else if (action === "reveal") {
        await invoke("reveal_path", { path: menu.primaryPath ?? menu.workspacePath });
      } else if (action === "copy" && menu.paths.length > 0) {
        await copyVideosToDirectory(menu.paths);
      } else if (action === "delete" && menu.paths.length > 0) {
        await recycleVideos(menu.paths);
      }
    } catch (error) {
      const message = errorMessage(error);
      notify(message);
      writeClientLog("error", `执行工作区右键菜单操作失败：${message}`);
    }
  };

  const openSettings = () => {
    setSettingsDraft({
      ...config.settings,
      videoExtensions: [...config.settings.videoExtensions],
      managedVideoExtensions: [...config.settings.managedVideoExtensions],
    });
    setNewVideoExtension("");
    setIsSettingsOpen(true);
  };

  const normalizeVideoExtension = (value: string) => {
    const extension = value.trim().toLocaleLowerCase();
    if (!extension || /[\\/:*?"<>|\s]/.test(extension)) {
      return null;
    }
    return extension.startsWith(".") ? extension : `.${extension}`;
  };

  const toggleVideoExtension = (extension: string) => {
    setSettingsDraft((draft) => {
      const enabled = draft.videoExtensions.includes(extension);
      if (enabled && draft.videoExtensions.length === 1) {
        notify("至少保留一种已启用的视频格式");
        return draft;
      }
      return {
        ...draft,
        videoExtensions: enabled
          ? draft.videoExtensions.filter((item) => item !== extension)
          : [...draft.videoExtensions, extension].sort(),
      };
    });
  };

  const addVideoExtension = () => {
    const extension = normalizeVideoExtension(newVideoExtension);
    if (!extension) {
      notify("请输入有效的扩展名，例如 .mp4");
      return;
    }
    setSettingsDraft((draft) => {
      if (draft.managedVideoExtensions.includes(extension)) {
        return {
          ...draft,
          videoExtensions: draft.videoExtensions.includes(extension)
            ? draft.videoExtensions
            : [...draft.videoExtensions, extension].sort(),
        };
      }
      return {
        ...draft,
        managedVideoExtensions: [...draft.managedVideoExtensions, extension].sort(),
        videoExtensions: [...draft.videoExtensions, extension].sort(),
      };
    });
    setNewVideoExtension("");
  };

  const removeVideoExtension = (extension: string) => {
    setSettingsDraft((draft) => {
      const enabled = draft.videoExtensions.includes(extension);
      if (enabled && draft.videoExtensions.length === 1) {
        notify("至少保留一种已启用的视频格式");
        return draft;
      }
      return {
        ...draft,
        managedVideoExtensions: draft.managedVideoExtensions.filter((item) => item !== extension),
        videoExtensions: draft.videoExtensions.filter((item) => item !== extension),
      };
    });
  };

  const settingsDirty = JSON.stringify(settingsDraft) !== JSON.stringify(config.settings);

  const closeSettings = () => {
    if (settingsDirty && !window.confirm("偏好设置尚未应用，确定放弃这些改动吗？")) {
      return;
    }
    setIsSettingsOpen(false);
  };

  const applySettings = async () => {
    const thumbnailPositionChanged =
      config.settings.thumbnailCapturePosition !== settingsDraft.thumbnailCapturePosition;
    try {
      const nextConfig = await invoke<AppConfig>("save_configuration", {
        config: { ...config, settings: settingsDraft },
      });
      setConfig(nextConfig);
      setIsSettingsOpen(false);
      if (thumbnailPositionChanged && workspace) {
        thumbnailDataUrls.clear();
        thumbnailDataRequests.clear();
        thumbnailQueue.current = [];
        queuedThumbnailPaths.current.clear();
        thumbnailFailures.current.clear();
        thumbnailPathOverrideRef.current.clear();
        setThumbnailPathOverrides(new Map());
      }
      if (workspace) {
        await activateWorkspace(workspace.path, false, nextConfig.settings.rememberWorkspaceFocus);
      }
    } catch (error) {
      const message = errorMessage(error);
      notify(message);
      writeClientLog("error", `保存设置失败：${message}`);
    }
  };

  const updateListColumn = (columnId: ListColumnId, update: Partial<ListColumn>) => {
    setSettingsDraft((draft) => ({
      ...draft,
      listColumns: draft.listColumns.map((column) => (column.id === columnId ? { ...column, ...update } : column)),
    }));
  };

  const moveListColumn = (index: number, direction: -1 | 1) => {
    setSettingsDraft((draft) => {
      const targetIndex = index + direction;
      if (index === 0 || targetIndex < 1 || targetIndex >= draft.listColumns.length) {
        return draft;
      }
      const nextColumns = [...draft.listColumns];
      [nextColumns[index], nextColumns[targetIndex]] = [nextColumns[targetIndex], nextColumns[index]];
      return { ...draft, listColumns: nextColumns };
    });
  };

  const setListColumns = (listColumns: ListColumn[]) => {
    setConfig((current) => ({ ...current, settings: { ...current.settings, listColumns } }));
  };

  const persistListColumns = async (listColumns: ListColumn[]) => {
    try {
      const nextConfig = await invoke<AppConfig>("save_configuration", {
        config: { ...config, settings: { ...config.settings, listColumns } },
      });
      setConfig(nextConfig);
    } catch (error) {
      const message = errorMessage(error);
      notify(message);
      writeClientLog("error", `保存列表列设置失败：${message}`);
    }
  };

  const reorderListColumns = (sourceId: ListColumnId, targetId: ListColumnId, dropPosition: "before" | "after") => {
    if (sourceId === "name" || targetId === "name" || sourceId === targetId) {
      return;
    }
    const nextColumns = [...config.settings.listColumns];
    const sourceIndex = nextColumns.findIndex((column) => column.id === sourceId);
    const targetIndex = nextColumns.findIndex((column) => column.id === targetId);
    if (sourceIndex < 1 || targetIndex < 1) {
      return;
    }
    const [source] = nextColumns.splice(sourceIndex, 1);
    // Resolve the target after removing the source so adjacent columns cannot reinsert in place.
    const adjustedTargetIndex = nextColumns.findIndex((column) => column.id === targetId);
    const insertionIndex = dropPosition === "after" ? adjustedTargetIndex + 1 : adjustedTargetIndex;
    nextColumns.splice(insertionIndex, 0, source);
    setListColumns(nextColumns);
    void persistListColumns(nextColumns);
  };

  const startListColumnReorder = (event: ReactMouseEvent<HTMLSpanElement>, columnId: ListColumnId) => {
    if (columnId === "name" || event.button !== 0) {
      return;
    }
    event.preventDefault();
    setDraggedListColumn(columnId);
    let dropTarget: ListColumnId | null = null;
    let dropPosition: "before" | "after" | null = null;
    // Pointer events avoid WebView's unreliable HTML5 drag-and-drop behavior for nested header controls.
    const onPointerMove = (moveEvent: PointerEvent) => {
      const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest<HTMLElement>("[data-list-column-id]");
      const targetId = target?.dataset.listColumnId as ListColumnId | undefined;
      if (target && targetId && targetId !== "name" && targetId !== columnId) {
        const bounds = target.getBoundingClientRect();
        dropTarget = targetId;
        dropPosition = moveEvent.clientX < bounds.left + bounds.width / 2 ? "before" : "after";
      } else {
        dropTarget = null;
        dropPosition = null;
      }
      setListColumnDropTarget(dropTarget);
      setListColumnDropPosition(dropPosition);
    };
    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      if (dropTarget && dropPosition) {
        reorderListColumns(columnId, dropTarget, dropPosition);
      }
      setDraggedListColumn(null);
      setListColumnDropTarget(null);
      setListColumnDropPosition(null);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  };

  const startListColumnResize = (event: ReactMouseEvent<HTMLSpanElement>, columnId: ListColumnId) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startColumn = config.settings.listColumns.find((column) => column.id === columnId);
    if (!startColumn) {
      return;
    }
    let nextColumns = config.settings.listColumns;
    const onPointerMove = (moveEvent: PointerEvent) => {
      const width = Math.round(Math.max(80, Math.min(520, startColumn.width + moveEvent.clientX - startX)) / 4) * 4;
      nextColumns = config.settings.listColumns.map((column) => (column.id === columnId ? { ...column, width } : column));
      setListColumns(nextColumns);
    };
    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      void persistListColumns(nextColumns);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  };

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const syncSystemTheme = () => setSystemColorMode(mediaQuery.matches ? "dark" : "light");
    syncSystemTheme();
    mediaQuery.addEventListener("change", syncSystemTheme);
    return () => mediaQuery.removeEventListener("change", syncSystemTheme);
  }, []);

  useEffect(() => {
    const group = panelGroupRef.current;
    if (!group) {
      return;
    }
    const syncWorkspaceMinimum = () => {
      // Preserve enough room for one fixed card and the grid's horizontal padding.
      setWorkspaceMinSize(Math.min(100, (252 / Math.max(group.clientWidth, 1)) * 100));
    };
    const observer = new ResizeObserver(syncWorkspaceMinimum);
    observer.observe(group);
    syncWorkspaceMinimum();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<RecycleResult>("files-recycled", (event) => applyRecycleResult(event.payload)).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<ThumbnailResult>("thumbnail-generated", (event) => applyThumbnailResult(event.payload)).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => unlisten?.();
  }, [applyThumbnailResult]);

  useEffect(() => {
    if (!isLogPanelOpen) {
      return;
    }
    let unlisten: (() => void) | undefined;
    let active = true;
    void attachLogger(({ level, message }) => {
      if (active && logLevelRank(logLevelLabel(level)) >= minimumLogLevelRank(logMinimumLevel)) {
        appendLiveLog(level, message);
      }
    })
      .then((cleanup) => {
        if (active) {
          unlisten = cleanup;
        } else {
          cleanup();
        }
      })
      .catch(() => {
        // Browser-only Vite previews do not provide the Tauri log event bridge.
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [isLogPanelOpen, logMinimumLevel]);

  useEffect(() => {
    const handleWorkspaceKeyboard = (event: KeyboardEvent) => {
      if (metadataLoading) {
        return;
      }
      const target = event.target;
      const isEditing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
      if (isEditing || isSettingsOpen) {
        return;
      }
      if (event.key === "Delete" && selectedVideos.size > 0) {
        event.preventDefault();
        void recycleSelectedVideos();
        return;
      }
      if (event.key === "F2" && selectedVideos.size === 1) {
        event.preventDefault();
        const path = selectionAnchor && selectedVideos.has(selectionAnchor) ? selectionAnchor : [...selectedVideos][0];
        startInlineRename(path);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && visibleVideos.length > 0) {
        event.preventDefault();
        setSelectedVideos(new Set(visibleVideos.map((video) => video.path)));
        setSelectionAnchor(visibleVideos[visibleVideos.length - 1]?.path ?? null);
        return;
      }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && visibleVideos.length > 0) {
        event.preventDefault();
        const currentIndex = selectionAnchor ? visibleVideos.findIndex((video) => video.path === selectionAnchor) : -1;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex = Math.min(visibleVideos.length - 1, Math.max(0, currentIndex === -1 ? (delta > 0 ? 0 : visibleVideos.length - 1) : currentIndex + delta));
        const nextPath = visibleVideos[nextIndex].path;
        setSuppressPreviewAutoplay(false);
        setSelectedVideos(new Set([nextPath]));
        setSelectionAnchor(nextPath);
        return;
      }
      if (event.key === " " && selectionAnchor && !(target instanceof Element && target.closest(".preview-player"))) {
        event.preventDefault();
        setSelectedVideos((current) => {
          const next = new Set(current);
          if (next.has(selectionAnchor)) {
            next.delete(selectionAnchor);
          } else {
            next.add(selectionAnchor);
          }
          return next;
        });
      }
    };
    window.addEventListener("keydown", handleWorkspaceKeyboard);
    return () => window.removeEventListener("keydown", handleWorkspaceKeyboard);
  }, [isSettingsOpen, metadataLoading, selectedVideos, selectionAnchor, visibleVideos]);

  useEffect(() => {
    if (!renamingPath) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [renamingPath]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<string[]>("copy-to-request", (event) => {
      if (Array.isArray(event.payload)) {
        void copyVideosToDirectory(event.payload);
      }
    })
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch((error: unknown) => writeClientLog("warn", `复制到菜单监听不可用：${errorMessage(error)}`));
    return () => unlisten?.();
  }, [workspace?.path]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen("workspace-refresh-request", () => {
      if (!workspace) {
        return;
      }
      writeClientLog("info", `右键请求刷新工作区：${workspace.path}`);
      void refreshWorkspace(workspace.path, "右键手动刷新");
    })
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch((error: unknown) => writeClientLog("warn", `刷新菜单监听不可用：${errorMessage(error)}`));
    return () => unlisten?.();
  }, [workspace?.path]);

  useEffect(() => {
    if (!workspace) {
      return;
    }
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setIsExternalDropActive(true);
        } else if (event.payload.type === "leave") {
          setIsExternalDropActive(false);
        } else if (event.payload.type === "drop") {
          setIsExternalDropActive(false);
          writeClientLog("info", `接收拖入文件：${event.payload.paths.length} 个`);
          void copyDroppedVideos(event.payload.paths, workspace.path);
        }
      })
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch((error: unknown) => {
        writeClientLog("warn", `原生拖入监听不可用：${errorMessage(error)}`);
      });
    return () => {
      setIsExternalDropActive(false);
      unlisten?.();
    };
  }, [workspace?.path]);

  useEffect(() => {
    if (!workspace) {
      return;
    }
    let unwatch: (() => void) | undefined;
    let refreshTimer: number | undefined;
    let active = true;
    void watch(
      workspace.path,
      () => {
        if (refreshTimer) {
          window.clearTimeout(refreshTimer);
        }
        refreshTimer = window.setTimeout(() => {
          if (active) {
            void refreshWorkspace(workspace.path);
          }
        }, 300);
      },
      { recursive: false },
    )
      .then((cleanup) => {
        if (active) {
          unwatch = cleanup;
          writeClientLog("debug", `工作区监听已启动：${workspace.path}`);
        } else {
          cleanup();
        }
      })
      .catch((error: unknown) => writeClientLog("warn", `工作区监听不可用：${errorMessage(error)}`));
    return () => {
      active = false;
      if (refreshTimer) {
        window.clearTimeout(refreshTimer);
      }
      unwatch?.();
    };
  }, [workspace?.path]);

  useEffect(() => {
    // Native menus are provided for selectable file-system items; suppress WebView's browser menu elsewhere.
    const preventBrowserContextMenu = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", preventBrowserContextMenu);
    return () => document.removeEventListener("contextmenu", preventBrowserContextMenu);
  }, []);

  useEffect(() => {
    if (!workspaceContextMenu) {
      return;
    }
    const dismiss = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".workspace-context-menu")) {
        setWorkspaceContextMenu(null);
      }
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setWorkspaceContextMenu(null);
      }
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", dismissOnEscape);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", dismissOnEscape);
    };
  }, [workspaceContextMenu]);

  useEffect(() => {
    let isCurrent = true;
    const initialize = async () => {
      try {
        const state = await invoke<ApplicationState>("load_application_state");
        if (!isCurrent) {
          return;
        }
        workspaceFocusByPath.current = state.config.workspaceFocus ?? {};
        writeClientLog(
          "debug",
          `加载工作区焦点配置：共 ${Object.keys(workspaceFocusByPath.current).length} 个工作区记录`,
        );
        setConfig(state.config);
        setRoots(state.roots);
        const elevated = await invoke<boolean>("is_running_as_administrator").catch(() => false);
        if (elevated) {
          notify("当前应用以管理员权限运行，Windows 会拒绝从普通资源管理器窗口拖入文件。请以普通权限重新启动应用。");
          writeClientLog("warn", "检测到管理员权限：普通资源管理器的文件拖入会被 Windows 阻止");
        }
        if (state.config.lastWorkspace) {
          await activateWorkspace(state.config.lastWorkspace, false);
        } else {
          setWorkspaceLoading(false);
        }
      } catch (error) {
        if (isCurrent) {
          setWorkspaceLoading(false);
          const message = errorMessage(error);
          notify(message);
          writeClientLog("error", `应用初始化失败：${message}`);
        }
      }
    };
    void initialize();
    return () => {
      isCurrent = false;
    };
  }, []);

  useEffect(
    () => () => {
      if (toastTimeout.current) {
        window.clearTimeout(toastTimeout.current);
      }
    },
    [],
  );

  const isFavorite = Boolean(workspace && config.favorites.some((favorite) => favorite.path === workspace.path));

  return (
    <main
      className={`app-shell ${effectiveColorMode === "light" ? "light-theme" : ""} ${
        isPreviewOpen ? "" : "preview-collapsed"
      }`}
      style={themeStyle}
    >
      <header className="titlebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <Video size={17} strokeWidth={2.2} />
          </div>
          <span>VideoSweeper</span>
        </div>
        <div className="titlebar-actions">
          <button className="command-button" type="button" onClick={() => void chooseFolder("workspace")}>
            <FolderOpen size={16} />
            打开文件夹
          </button>
          <button
            className={`icon-button ${isFavorite ? "active" : ""}`}
            type="button"
            disabled={!workspace}
            aria-label={isFavorite ? "取消收藏当前文件夹" : "收藏当前文件夹"}
            title={isFavorite ? "取消收藏当前文件夹" : "收藏当前文件夹"}
            onClick={() => void toggleFavorite()}
          >
            {isFavorite ? <StarOff size={17} /> : <Star size={17} />}
          </button>
          <button className="icon-button" type="button" aria-label="偏好设置" title="偏好设置" onClick={openSettings}>
            <Settings size={17} />
          </button>
          <button className="icon-button" type="button" aria-label="日志" title="日志" onClick={openLogs}>
            <ScrollText size={17} />
          </button>
        </div>
      </header>

      <div className="application-panels" ref={panelGroupRef}>
      <PanelGroup
        className="panel-group"
        autoSaveId={isPreviewOpen ? "video-sweeper-three-panels" : "video-sweeper-two-panels"}
        direction="horizontal"
      >
      <Panel defaultSize={20} minSize={0}>
      <aside className="navigation-panel">
        <section className="nav-section favorites-section">
          <div className="section-heading">
            <span>收藏夹</span>
            <button
              className="quiet-icon-button"
              type="button"
              aria-label="添加收藏夹"
              title="添加收藏夹"
              onClick={() => void chooseFolder("favorite")}
            >
              <Plus size={16} />
            </button>
          </div>
          {config.favorites.length === 0 ? (
            <div className="nav-empty">尚无收藏</div>
          ) : (
            <div className="nav-list">
              {config.favorites.map((favorite) => (
                <button
                  className={`nav-row ${selectedPath === favorite.path ? "active" : ""}`}
                  type="button"
                  key={favorite.path}
                  title={favorite.path}
                  onClick={() => void activateWorkspace(favorite.path)}
                  onContextMenu={(event) => showPathContextMenu(event, favorite.path, true)}
                >
                  <Star size={16} />
                  <span>{favorite.name}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="nav-section tree-section">
          <div className="section-heading">
            <span>此电脑</span>
          </div>
          <ul className="directory-tree">
            {roots.map((root) => (
              <DirectoryTreeNode
                entry={root}
                depth={0}
                key={root.path}
                selectedPath={selectedPath}
                expandedPaths={expandedPaths}
                treeState={treeState}
                onSelect={(path) => void activateWorkspace(path)}
                onToggle={toggleTreeNode}
                onContextMenu={(event, path) => showPathContextMenu(event, path, true)}
              />
            ))}
          </ul>
        </section>

        <div className="navigation-footer">
          <button className="nav-row" type="button" onClick={openSettings}>
            <SlidersHorizontal size={16} />
            <span>偏好设置</span>
          </button>
        </div>
      </aside>
      </Panel>

      <PanelResizeHandle className="panel-resize-handle" aria-label="调整左栏宽度" />

      <Panel defaultSize={isPreviewOpen ? 54 : 80} minSize={workspaceMinSize}>

      <section className="workspace">
        <div className="workspace-toolbar">
          <label className="search-field">
            <Search size={16} />
            <input
              type="search"
              value={searchQuery}
              disabled={!workspace}
              placeholder="搜索当前文件夹"
              aria-label="搜索当前文件夹"
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </label>
          <span className="workspace-path" title={workspace?.path}>
            {workspace?.path ?? "未选择工作区"}
          </span>
          <div className="toolbar-divider" />
          <label className="sort-select">
            <span className="sr-only">排序字段</span>
            <select
              value={sortKey}
              onChange={(event) => {
                const nextSortKey = event.target.value as SortKey;
                setSortKey(nextSortKey);
                if (nextSortKey === "duration" || nextSortKey === "resolution") {
                  void loadWorkspaceMetadata();
                }
              }}
              disabled={!workspace || metadataLoading}
            >
              <option value="createdAt">创建日期</option>
              <option value="name">名称</option>
              <option value="size">大小</option>
              <option value="duration">时长</option>
              <option value="resolution">分辨率</option>
            </select>
          </label>
          <button
            className="sort-button"
            type="button"
            disabled={!workspace}
            aria-label={sortAscending ? "改为降序" : "改为升序"}
            title={sortAscending ? "降序" : "升序"}
            onClick={() => setSortAscending((ascending) => !ascending)}
          >
            <ChevronDown size={16} className={sortAscending ? "sort-ascending" : ""} />
          </button>
          <div className="view-toggle" aria-label="视图模式">
            <button
              className={viewMode === "grid" ? "active" : ""}
              type="button"
              aria-label="网格视图"
              title="网格视图"
              onClick={() => setViewMode("grid")}
            >
              <Grid2X2 size={16} />
            </button>
            <button
              className={viewMode === "list" ? "active" : ""}
              type="button"
              aria-label="列表视图"
              title="列表视图"
              onClick={() => setViewMode("list")}
            >
              <List size={17} />
            </button>
          </div>
          <button
            className="quiet-icon-button preview-toggle"
            type="button"
            aria-label={isPreviewOpen ? "折叠预览面板" : "展开预览面板"}
            title={isPreviewOpen ? "折叠预览面板" : "展开预览面板"}
            onClick={() => setIsPreviewOpen((isOpen) => !isOpen)}
          >
            {isPreviewOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
          </button>
        </div>

        {!workspace || workspaceLoading ? (
          <div className="empty-workspace">
            <div className="empty-symbol" aria-hidden="true">
              <Folder size={28} />
            </div>
            <h1>{workspaceLoading ? "正在读取工作区" : "选择一个文件夹以开始"}</h1>
            {!workspaceLoading && (
              <button className="command-button primary-command" type="button" onClick={() => void chooseFolder("workspace")}>
                <FolderOpen size={16} />
                打开文件夹
              </button>
            )}
          </div>
        ) : visibleVideos.length === 0 ? (
          <div
            className="empty-workspace compact-empty"
            onClick={clearWorkspaceSelection}
            onContextMenu={(event) => showWorkspaceContextMenu(event)}
          >
            <div className="empty-symbol" aria-hidden="true">
              <Video size={28} />
            </div>
            <h1>
              {workspace.mediaSuppressed
                ? "此目录的媒体已被 .nomedia 隐藏"
                : searchQuery
                  ? "没有匹配的视频"
                  : workspace.folders.length > 0
                    ? "此目录未直接包含视频，请选择下级文件夹浏览"
                    : "此目录没有受支持的视频"}
            </h1>
          </div>
        ) : viewMode === "grid" ? (
          <div
            ref={setGridScrollRef}
            className="video-grid"
            role="list"
            aria-label="视频文件"
            onScroll={handleThumbnailViewportScroll}
            onClick={clearSelectionFromBackground}
            onContextMenu={(event) => showWorkspaceContextMenu(event)}
            onPointerDown={(event) => startWorkspaceRectangleSelection(event, "grid")}
            onPointerMove={updateWorkspaceRectangleSelection}
            onPointerUp={finishWorkspaceRectangleSelection}
            onPointerCancel={finishWorkspaceRectangleSelection}
          >
            <div className="video-grid-virtualizer" style={{ height: gridRowVirtualizer.getTotalSize() }}>
              {gridRowVirtualizer.getVirtualItems().map((virtualRow) => (
                <div
                  className="video-grid-row"
                  key={virtualRow.key}
                  style={{
                    "--grid-columns": String(gridColumns),
                    transform: `translateY(${virtualRow.start}px)`,
                  } as CSSProperties}
                >
                  {visibleVideos
                    .slice(virtualRow.index * gridColumns, (virtualRow.index + 1) * gridColumns)
                    .map((video) => (
                      <div
                        className={`video-card ${selectedVideos.has(video.path) ? "selected" : ""}`}
                        key={video.path}
                        data-video-path={video.path}
                        draggable={false}
                        role="listitem"
                        tabIndex={0}
                        title={renamingPath === video.path ? undefined : video.name}
                        onPointerDown={(event) => startVideoFileDrag(event, video.path)}
                        onPointerMove={updateVideoFileDrag}
                        onPointerUp={finishVideoFileDrag}
                        onPointerCancel={finishVideoFileDrag}
                        onDragStart={(event) => {
                          event.preventDefault();
                          writeClientLog("debug", `已阻止浏览器原生缩略图拖拽：${video.path}`);
                        }}
                        onClick={(event) => selectVideo(event, video.path)}
                        onContextMenu={(event) => {
                          const operationPaths = selectedVideos.has(video.path) ? [...selectedVideos] : [video.path];
                          setSelectedVideos(new Set(operationPaths));
                          setSelectionAnchor(video.path);
                          showWorkspaceContextMenu(event, operationPaths);
                        }}
                      >
                        <VideoThumbnail
                          video={video}
                          thumbnailPath={thumbnailPathOverrides.get(video.path) ?? video.thumbnailPath}
                          visibilityRevision={thumbnailVisibilityRevision}
                          onVisible={enqueueThumbnail}
                        />
                        {renamingPath === video.path ? (
                          <span className="inline-rename" onClick={(event) => event.stopPropagation()}>
                            <input
                              ref={renameInputRef}
                              value={renameDraft}
                              aria-label="新文件名"
                              onChange={(event) => setRenameDraft(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  void submitInlineRename();
                                } else if (event.key === "Escape") {
                                  event.preventDefault();
                                  cancelInlineRename();
                                }
                              }}
                              onBlur={() => void submitInlineRename()}
                            />
                            <span className="rename-extension">{video.extension}</span>
                          </span>
                        ) : (
                          <span className="video-name">{video.name}</span>
                        )}
                        <span className="video-meta">
                          {formatBytes(video.size)} · {formatDate(video.createdAt)}
                        </span>
                      </div>
                    ))}
                </div>
              ))}
            </div>
            {workspaceSelectionBox?.viewMode === "grid" && (
              <div
                className="workspace-selection-box"
                aria-hidden="true"
                style={{
                  left: workspaceSelectionBox.left,
                  top: workspaceSelectionBox.top,
                  width: workspaceSelectionBox.width,
                  height: workspaceSelectionBox.height,
                }}
              />
            )}
          </div>
        ) : (
          <div
            ref={listScrollElement}
            className="video-list"
            role="table"
            aria-label="视频文件"
            style={listGridStyle}
            onScroll={handleThumbnailViewportScroll}
            onClick={clearSelectionFromBackground}
            onContextMenu={(event) => showWorkspaceContextMenu(event)}
            onPointerDown={(event) => startWorkspaceRectangleSelection(event, "list")}
            onPointerMove={updateWorkspaceRectangleSelection}
            onPointerUp={finishWorkspaceRectangleSelection}
            onPointerCancel={finishWorkspaceRectangleSelection}
          >
            <div className="video-list-header" role="row">
              {visibleListColumns.map((column) => (
                <span
                  className={`list-header-cell ${draggedListColumn === column.id ? "dragging" : ""} ${
                    listColumnDropTarget === column.id ? "drop-target" : ""
                  } ${
                    listColumnDropTarget === column.id && listColumnDropPosition ? `drop-${listColumnDropPosition}` : ""
                  }`}
                  data-list-column-id={column.id}
                  key={column.id}
                  onPointerDown={(event) => startListColumnReorder(event, column.id)}
                >
                  <span>{listColumnLabels[column.id]}</span>
                  <span
                    className="column-resize-handle"
                    role="separator"
                    aria-label={`调整${listColumnLabels[column.id]}列宽`}
                    onPointerDown={(event) => startListColumnResize(event, column.id)}
                  />
                </span>
              ))}
            </div>
            <div className="video-list-virtualizer" style={{ height: listRowVirtualizer.getTotalSize() }}>
              {listRowVirtualizer.getVirtualItems().map((virtualRow) => {
                const video = visibleVideos[virtualRow.index];
                return (
                  <div
                    className={`video-list-row ${selectedVideos.has(video.path) ? "selected" : ""}`}
                    role="row"
                    key={video.path}
                    data-video-path={video.path}
                    draggable={false}
                    tabIndex={0}
                    style={{ ...listGridStyle, transform: `translateY(${virtualRow.start}px)` }}
                    onPointerDown={(event) => startVideoFileDrag(event, video.path)}
                    onPointerMove={updateVideoFileDrag}
                    onPointerUp={finishVideoFileDrag}
                    onPointerCancel={finishVideoFileDrag}
                    onDragStart={(event) => {
                      event.preventDefault();
                      writeClientLog("debug", `已阻止浏览器原生缩略图拖拽：${video.path}`);
                    }}
                    onClick={(event) => selectVideo(event, video.path)}
                    onContextMenu={(event) => {
                      const operationPaths = selectedVideos.has(video.path) ? [...selectedVideos] : [video.path];
                      setSelectedVideos(new Set(operationPaths));
                      setSelectionAnchor(video.path);
                      showWorkspaceContextMenu(event, operationPaths);
                    }}
                  >
                    {visibleListColumns.map((column) => {
                      if (column.id === "name") {
                        return (
                          <span className="list-name" key={column.id}>
                            <VideoThumbnail
                              video={video}
                              thumbnailPath={thumbnailPathOverrides.get(video.path) ?? video.thumbnailPath}
                              visibilityRevision={thumbnailVisibilityRevision}
                              compact
                              onVisible={enqueueThumbnail}
                            />
                            {renamingPath === video.path ? (
                              <span className="inline-rename" onClick={(event) => event.stopPropagation()}>
                                <input
                                  ref={renameInputRef}
                                  value={renameDraft}
                                  aria-label="新文件名"
                                  onChange={(event) => setRenameDraft(event.target.value)}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                      event.preventDefault();
                                      void submitInlineRename();
                                    } else if (event.key === "Escape") {
                                      event.preventDefault();
                                      cancelInlineRename();
                                    }
                                  }}
                                  onBlur={() => void submitInlineRename()}
                                />
                                <span className="rename-extension">{video.extension}</span>
                              </span>
                            ) : (
                              <span title={video.name}>{video.name}</span>
                            )}
                          </span>
                        );
                      }
                      if (column.id === "size") {
                        return <span key={column.id}>{formatBytes(video.size)}</span>;
                      }
                      if (column.id === "modifiedAt") {
                        return <span key={column.id}>{formatDate(video.modifiedAt)}</span>;
                      }
                      if (column.id === "duration") {
                        return <span key={column.id}>{formatDuration(video.duration)}</span>;
                      }
                      if (column.id === "resolution") {
                        return <span key={column.id}>{formatResolution(video)}</span>;
                      }
                      return <span key={column.id}>-</span>;
                    })}
                  </div>
                );
              })}
            </div>
            {workspaceSelectionBox?.viewMode === "list" && (
              <div
                className="workspace-selection-box"
                aria-hidden="true"
                style={{
                  left: workspaceSelectionBox.left,
                  top: workspaceSelectionBox.top,
                  width: workspaceSelectionBox.width,
                  height: workspaceSelectionBox.height,
                }}
              />
            )}
          </div>
        )}
        {isExternalDropActive && workspace && (
          <div className="workspace-drop-indicator" aria-hidden="true">
            <FolderOpen size={26} />
            <span>松开以复制视频到当前工作区</span>
          </div>
        )}
      </section>
      </Panel>

      {isPreviewOpen && (
        <>
          <PanelResizeHandle className="panel-resize-handle" aria-label="调整预览栏宽度" />
          <Panel defaultSize={26} minSize={0}>
        <aside
          className="preview-panel"
          tabIndex={0}
          aria-label="视频预览和文件信息"
          onMouseDown={(event) => {
            if (event.target instanceof Element && !event.target.closest("button, input, select, a, [contenteditable='true']")) {
              event.currentTarget.focus();
            }
          }}
          onKeyDown={(event) => {
            if (event.target instanceof Element && event.target.closest("button, input, select, a, [contenteditable='true']")) {
              return;
            }
            if (event.key === " " || event.key === "Spacebar") {
              event.preventDefault();
              event.stopPropagation();
              previewPlayerRef.current?.togglePlayback();
            } else if (event.key === "ArrowLeft") {
              event.preventDefault();
              event.stopPropagation();
              previewPlayerRef.current?.skipPlayback(-5);
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              event.stopPropagation();
              previewPlayerRef.current?.skipPlayback(5);
            }
          }}
        >
          <PreviewPlayer
            ref={previewPlayerRef}
            key={selectedVideo?.path ?? "empty-preview"}
            video={selectedVideo}
            thumbnailPath={selectedVideo ? thumbnailPathOverrides.get(selectedVideo.path) ?? selectedVideo.thumbnailPath : null}
            autoplay={config.settings.autoplay && selectedVideos.size === 1 && !suppressPreviewAutoplay}
            volume={config.settings.volume}
            muted={config.settings.muted}
            onEnsureThumbnail={enqueueThumbnail}
            onAudioPreferenceChange={updateAudioPreferences}
          />
          <section className="details-panel">
            <div className="section-heading">
              <span>文件信息</span>
            </div>
            <dl>
              <div>
                <dt>名称</dt>
                <dd title={selectedVideo?.name}>{selectedVideo?.name ?? "-"}</dd>
              </div>
              <div>
                <dt>大小</dt>
                <dd>{selectedVideo ? formatBytes(selectedVideo.size) : "-"}</dd>
              </div>
              <div>
                <dt>创建日期</dt>
                <dd>{selectedVideo ? formatDate(selectedVideo.createdAt) : "-"}</dd>
              </div>
              <div>
                <dt>格式</dt>
                <dd>{selectedVideo?.extension.toUpperCase() ?? "-"}</dd>
              </div>
              <div>
                <dt>时长</dt>
                <dd>{selectedVideo ? selectedVideo.duration === null && selectedMetadataLoading ? "读取中…" : formatDuration(selectedVideo.duration) : "-"}</dd>
              </div>
              <div>
                <dt>分辨率</dt>
                <dd>{selectedVideo ? (!selectedVideo.width || !selectedVideo.height) && selectedMetadataLoading ? "读取中…" : formatResolution(selectedVideo) : "-"}</dd>
              </div>
            </dl>
          </section>
        </aside>
          </Panel>
        </>
      )}
      </PanelGroup>
      </div>

      {toast && <div className="toast" role="status">{toast}</div>}

      {workspaceContextMenu && (
        <div
          className="workspace-context-menu"
          role="menu"
          aria-label="工作区菜单"
          style={{ left: workspaceContextMenu.x, top: workspaceContextMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {workspaceContextMenu.paths.length > 0 ? (
            <>
              <div className="workspace-context-menu-title">已选择 {workspaceContextMenu.paths.length} 个视频</div>
              <button type="button" role="menuitem" onClick={() => void runWorkspaceContextMenuAction("open")}>
                <Play size={16} />
                使用默认应用打开
              </button>
              <button type="button" role="menuitem" onClick={() => void runWorkspaceContextMenuAction("reveal")}>
                <FolderOpen size={16} />
                在资源管理器中显示
              </button>
              <button type="button" role="menuitem" onClick={() => void runWorkspaceContextMenuAction("copy")}>
                <ClipboardCopy size={16} />
                复制到…
              </button>
              <div className="workspace-context-menu-separator" />
              <button className="danger" type="button" role="menuitem" onClick={() => void runWorkspaceContextMenuAction("delete")}>
                <Trash2 size={16} />
                移到回收站
              </button>
            </>
          ) : (
            <>
              <div className="workspace-context-menu-title">当前工作区</div>
              <button type="button" role="menuitem" onClick={() => void runWorkspaceContextMenuAction("reveal")}>
                <FolderOpen size={16} />
                在资源管理器中打开
              </button>
            </>
          )}
          <div className="workspace-context-menu-separator" />
          <button type="button" role="menuitem" onClick={() => void runWorkspaceContextMenuAction("refresh")}>
            <RefreshCw size={16} />
            刷新
          </button>
        </div>
      )}

      {metadataLoading && (
        <div className="metadata-loading-overlay" role="alertdialog" aria-modal="true" aria-live="assertive">
          <div className="metadata-loading-dialog">
            <LoaderCircle size={20} className="spinning" aria-hidden="true" />
            <div>
              <strong>正在读取媒体信息</strong>
              <span>完成后将按所选字段统一排序</span>
            </div>
          </div>
        </div>
      )}

      {isLogPanelOpen && (
        <div className="settings-backdrop" role="presentation" onMouseDown={closeLogs}>
          <section
            className="logs-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="logs-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="settings-header">
              <div>
                <span>诊断</span>
                <h2 id="logs-title">运行日志</h2>
              </div>
              <div className="logs-actions">
                <select
                  className="logs-level-select"
                  aria-label="日志最低级别"
                  value={logMinimumLevel}
                  onChange={(event) => setLogMinimumLevel(event.target.value as LogMinimumLevel)}
                >
                  <option value="warn">警告及以上</option>
                  <option value="info">信息及以上</option>
                  <option value="debug">调试及以上</option>
                </select>
                <button
                  className="quiet-icon-button"
                  type="button"
                  aria-label="刷新日志"
                  title="刷新"
                  disabled={logLoading}
                  onClick={() => void loadLogs()}
                >
                  <RefreshCw size={17} />
                </button>
                <button
                  className="quiet-icon-button"
                  type="button"
                  aria-label="复制日志"
                  title="复制"
                  disabled={!filteredFileLogs.trim()}
                  onClick={() => void copyLogs()}
                >
                  <ClipboardCopy size={17} />
                </button>
                <button
                  className="quiet-icon-button"
                  type="button"
                  aria-label="关闭日志"
                  title="关闭"
                  onClick={closeLogs}
                >
                  <X size={18} />
                </button>
              </div>
            </header>

            <div className="logs-body">
              <div className="log-meta">
                <span title={logSnapshot?.path}>{logSnapshot?.path ?? "日志文件尚未创建"}</span>
                <span>{logSnapshot ? formatBytes(logSnapshot.size) : "-"}</span>
              </div>
              {logPanelError && <div className="log-error">{logPanelError}</div>}
              <section className="log-section">
                <h3>文件日志</h3>
                <pre className="log-output">{logLoading ? "正在读取日志..." : filteredFileLogs.trim() || "当前级别下暂无日志"}</pre>
              </section>
              <section className="log-section">
                <h3>本次运行</h3>
                <div className="live-log-list">
                  {filteredLiveLogs.length === 0 ? (
                    <span className="log-empty">当前级别下暂无实时日志</span>
                  ) : (
                    filteredLiveLogs.map((entry) => (
                      <div className={`live-log-entry level-${logLevelLabel(entry.level).toLowerCase()}`} key={entry.id}>
                        <span>{logLevelLabel(entry.level)}</span>
                        <p>{entry.message}</p>
                      </div>
                    ))
                  )}
                </div>
              </section>
            </div>
          </section>
        </div>
      )}

      {isSettingsOpen && (
        <div className="settings-backdrop" role="presentation" onMouseDown={closeSettings}>
          <section
            className="settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="settings-header">
              <div>
                <span>偏好设置</span>
                <h2 id="settings-title">应用与工作区</h2>
              </div>
              <button className="quiet-icon-button" type="button" aria-label="关闭偏好设置" title="关闭" onClick={closeSettings}>
                <X size={18} />
              </button>
            </header>

            <div className="settings-body">
              <section className="settings-section">
                <h3>外观</h3>
                <div className="setting-row">
                  <span>显示模式</span>
                  <div className="appearance-switch" role="radiogroup" aria-label="显示模式">
                    <button
                      className={settingsDraft.appearance === "system" ? "active" : ""}
                      type="button"
                      aria-label="跟随系统"
                      title="跟随系统"
                      onClick={() => setSettingsDraft((draft) => ({ ...draft, appearance: "system" }))}
                    >
                      <Monitor size={16} />
                    </button>
                    <button
                      className={settingsDraft.appearance === "dark" ? "active" : ""}
                      type="button"
                      aria-label="深色模式"
                      title="深色模式"
                      onClick={() => setSettingsDraft((draft) => ({ ...draft, appearance: "dark" }))}
                    >
                      <Moon size={16} />
                    </button>
                    <button
                      className={settingsDraft.appearance === "light" ? "active" : ""}
                      type="button"
                      aria-label="浅色模式"
                      title="浅色模式"
                      onClick={() => setSettingsDraft((draft) => ({ ...draft, appearance: "light" }))}
                    >
                      <Sun size={16} />
                    </button>
                  </div>
                </div>
                <div className="setting-row">
                  <span>主题色</span>
                  <div className="theme-swatch-grid" aria-label="主题色">
                    {themePresets.map((theme) => (
                      <button
                        className={`theme-swatch ${settingsDraft.accentTheme === theme.id ? "selected" : ""}`}
                        type="button"
                        key={theme.id}
                        aria-label={theme.name}
                        title={theme.name}
                        style={{ backgroundColor: theme.color }}
                        onClick={() => setSettingsDraft((draft) => ({ ...draft, accentTheme: theme.id }))}
                      />
                    ))}
                  </div>
                </div>
              </section>

              <section className="settings-section">
                <h3>媒体</h3>
                <label className="setting-row">
                  <span>缩略图缓存上限</span>
                  <span className="number-input">
                    <input
                      type="number"
                      min="0.25"
                      max="100"
                      step="0.25"
                      value={settingsDraft.thumbnailCacheGb}
                      onChange={(event) =>
                        setSettingsDraft((draft) => ({ ...draft, thumbnailCacheGb: Number(event.target.value) }))
                      }
                    />
                    <em>GB</em>
                  </span>
                </label>
                <label className="setting-row">
                  <span>缩略图取帧位置</span>
                  <select
                    className="thumbnail-position-select"
                    value={settingsDraft.thumbnailCapturePosition}
                    onChange={(event) =>
                      setSettingsDraft((draft) => ({
                        ...draft,
                        thumbnailCapturePosition: event.target.value as ThumbnailCapturePosition,
                      }))
                    }
                  >
                    <option value="opening">开头 1 秒（快速）</option>
                    <option value="early">前段 25%</option>
                    <option value="middle">正中 50%</option>
                    <option value="late">后段 75%</option>
                    <option value="ending">结尾 90%</option>
                  </select>
                </label>
                <label className="setting-row">
                  <span>默认音量</span>
                  <span className="volume-input">
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={settingsDraft.volume}
                      onChange={(event) => setSettingsDraft((draft) => ({ ...draft, volume: Number(event.target.value) }))}
                    />
                    <output>{settingsDraft.volume}%</output>
                  </span>
                </label>
                <div className="setting-row extension-setting">
                  <span>支持的视频格式</span>
                  <div className="extension-manager">
                    <div className="extension-add">
                      <input
                        className="extension-input"
                        type="text"
                        value={newVideoExtension}
                        placeholder="例如 .mp4"
                        aria-label="添加视频扩展名"
                        onChange={(event) => setNewVideoExtension(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            addVideoExtension();
                          }
                        }}
                      />
                      <button type="button" className="extension-add-button" onClick={addVideoExtension}>
                        <Plus size={14} />
                        添加
                      </button>
                    </div>
                    <ul className="extension-list" aria-label="视频格式列表">
                      {settingsDraft.managedVideoExtensions.map((extension) => {
                        const enabled = settingsDraft.videoExtensions.includes(extension);
                        return (
                          <li key={extension}>
                            <label>
                              <input
                                type="checkbox"
                                checked={enabled}
                                onChange={() => toggleVideoExtension(extension)}
                              />
                              <span>{extension}</span>
                            </label>
                            <button
                              type="button"
                              className="quiet-icon-button"
                              aria-label={`删除 ${extension}`}
                              title="删除格式"
                              onClick={() => removeVideoExtension(extension)}
                            >
                              <X size={14} />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </div>
              </section>

              <section className="settings-section">
                <h3>行为</h3>
                <div className="setting-row">
                  <span>选择视频后自动播放</span>
                  <button
                    className={`switch ${settingsDraft.autoplay ? "on" : ""}`}
                    type="button"
                    role="switch"
                    aria-checked={settingsDraft.autoplay}
                    onClick={() => setSettingsDraft((draft) => ({ ...draft, autoplay: !draft.autoplay }))}
                  >
                    <span />
                  </button>
                </div>
                <div className="setting-row">
                  <span>记忆工作区视频焦点</span>
                  <button
                    className={`switch ${settingsDraft.rememberWorkspaceFocus ? "on" : ""}`}
                    type="button"
                    role="switch"
                    aria-checked={settingsDraft.rememberWorkspaceFocus}
                    aria-label="记忆工作区视频焦点"
                    onClick={() =>
                      setSettingsDraft((draft) => ({
                        ...draft,
                        rememberWorkspaceFocus: !draft.rememberWorkspaceFocus,
                      }))
                    }
                  >
                    <span />
                  </button>
                </div>
                <div className="setting-row">
                  <span>显示隐藏和系统项目</span>
                  <button
                    className={`switch ${settingsDraft.showHiddenItems ? "on" : ""}`}
                    type="button"
                    role="switch"
                    aria-checked={settingsDraft.showHiddenItems}
                    onClick={() => setSettingsDraft((draft) => ({ ...draft, showHiddenItems: !draft.showHiddenItems }))}
                  >
                    <span />
                  </button>
                </div>
                <div className="setting-row">
                  <span>显示 .nomedia 中的媒体</span>
                  <button
                    className={`switch ${settingsDraft.showNomediaMedia ? "on" : ""}`}
                    type="button"
                    role="switch"
                    aria-checked={settingsDraft.showNomediaMedia}
                    onClick={() => setSettingsDraft((draft) => ({ ...draft, showNomediaMedia: !draft.showNomediaMedia }))}
                  >
                    <span />
                  </button>
                </div>
                <div className="setting-row">
                  <span>不支持的格式调用外部播放器</span>
                  <button
                    className={`switch ${settingsDraft.openUnsupportedExternally ? "on" : ""}`}
                    type="button"
                    role="switch"
                    aria-checked={settingsDraft.openUnsupportedExternally}
                    onClick={() =>
                      setSettingsDraft((draft) => ({
                        ...draft,
                        openUnsupportedExternally: !draft.openUnsupportedExternally,
                      }))
                    }
                  >
                    <span />
                  </button>
                </div>
              </section>

              <section className="settings-section">
                <h3>列表列</h3>
                {settingsDraft.listColumns.map((column, index) => (
                  <div className="list-column-row" key={column.id}>
                    {column.id === "name" ? (
                      <span className="fixed-column-name">{listColumnLabels[column.id]}</span>
                    ) : (
                      <label className="check-control">
                        <input
                          type="checkbox"
                          checked={column.visible}
                          onChange={(event) => updateListColumn(column.id, { visible: event.target.checked })}
                        />
                        <span aria-hidden="true" />
                        <em>{listColumnLabels[column.id]}</em>
                      </label>
                    )}
                    <div className="list-column-actions">
                      <button
                        className="mini-icon-button"
                        type="button"
                        disabled={index <= 1}
                        aria-label={`上移${listColumnLabels[column.id]}`}
                        title="上移"
                        onClick={() => moveListColumn(index, -1)}
                      >
                        <ArrowUp size={15} />
                      </button>
                      <button
                        className="mini-icon-button"
                        type="button"
                        disabled={index === 0 || index === settingsDraft.listColumns.length - 1}
                        aria-label={`下移${listColumnLabels[column.id]}`}
                        title="下移"
                        onClick={() => moveListColumn(index, 1)}
                      >
                        <ArrowDown size={15} />
                      </button>
                      <label className="column-width-input">
                        <span className="sr-only">{listColumnLabels[column.id]}列宽</span>
                        <input
                          type="number"
                          min="80"
                          max="520"
                          step="4"
                          value={column.width}
                          onChange={(event) => updateListColumn(column.id, { width: Number(event.target.value) })}
                        />
                        <em>px</em>
                      </label>
                    </div>
                  </div>
                ))}
              </section>
            </div>

            <footer className="settings-footer">
              <button className="command-button" type="button" onClick={closeSettings}>
                取消
              </button>
              <button className="command-button primary-command" type="button" disabled={!settingsDirty} onClick={() => void applySettings()}>
                应用
              </button>
            </footer>
          </section>
        </div>
      )}
    </main>
  );
}
