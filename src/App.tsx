import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { useVirtualizer } from "@tanstack/react-virtual";
import { attachLogger, LogLevel } from "@tauri-apps/plugin-log";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { colorModeTokens, themePresets } from "./theme";
import {
  clearThumbnailDataCache,
  invalidateThumbnailData,
  VideoThumbnail,
} from "./components/VideoThumbnail";
import { PreviewPlayer, type PreviewPlayerHandle } from "./components/PreviewPlayer";
import { DirectoryTreeNode } from "./components/DirectoryTreeNode";
import {
  fallbackConfig,
  GRID_CARD_WIDTH,
  GRID_ROW_HEIGHT,
  LIST_ROW_HEIGHT,
  listColumnLabels,
  MAX_THUMBNAIL_CONCURRENCY,
  type AppConfig,
  type ApplicationState,
  type ColorMode,
  type DirectoryEntry,
  type DirectoryChildren,
  type FileDragGesture,
  type FileTaskOperation,
  type FileTaskSnapshot,
  type ListColumn,
  type ListColumnId,
  type LiveLogEntry,
  type LogSnapshot,
  type MetadataBatchResult,
  type Preferences,
  type RecycleResult,
  type RenameResult,
  type SortKey,
  type ThumbnailBatchResult,
  type ThumbnailCapturePosition,
  type ThumbnailResult,
  type ThumbnailTask,
  type TreeState,
  type VideoEntry,
  type VideoMetadata,
  type ViewMode,
  type WorkspaceContextMenu,
  type WorkspaceFocus,
  type WorkspaceListing,
  type WorkspaceSort,
  type WorkspaceSelectionBox,
  type WorkspaceSelectionGesture,
} from "./app-types";
import {
  errorMessage,
  filterLogContent,
  formatBytes,
  formatDate,
  formatDuration,
  formatResolution,
  logLevelLabel,
  logLevelRank,
  minimumLogLevelRank,
  type LogMinimumLevel,
  writeClientLog,
} from "./app-utils";
import {
  ArrowDown,
  ArrowUp,
  ClipboardCopy,
  ClipboardPaste,
  ChevronDown,
  Folder,
  FolderOpen,
  Grid2X2,
  List,
  LoaderCircle,
  Monitor,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  RefreshCw,
  Search,
  Scissors,
  Settings,
  SlidersHorizontal,
  ScrollText,
  Star,
  StarOff,
  Sun,
  Trash2,
  Video,
  X,
} from "lucide-react";
import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";




export default function App() {
  const [config, setConfig] = useState<AppConfig>(fallbackConfig);
  const [roots, setRoots] = useState<DirectoryEntry[]>([]);
  const [treeState, setTreeState] = useState<TreeState>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [workspace, setWorkspace] = useState<WorkspaceListing | null>(null);
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
  const [activeFileTask, setActiveFileTask] = useState<FileTaskSnapshot | null>(null);
  const [gridColumns, setGridColumns] = useState(1);
  const [gridViewport, setGridViewport] = useState<HTMLDivElement | null>(null);
  const [suppressPreviewAutoplay, setSuppressPreviewAutoplay] = useState(false);
  const [workspaceMinSize, setWorkspaceMinSize] = useState(34);
  const [draggedListColumn, setDraggedListColumn] = useState<ListColumnId | null>(null);
  const [listColumnDropTarget, setListColumnDropTarget] = useState<ListColumnId | null>(null);
  const [listColumnDropPosition, setListColumnDropPosition] = useState<"before" | "after" | null>(null);
  // A later folder click supersedes earlier scans that are still waiting for the Rust command.
  const workspaceRequest = useRef(0);
  const workspaceScanRequest = useRef(0);
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
  const workspaceSortByPath = useRef<Record<string, WorkspaceSort>>({});
  const activeWorkspaceSort = useRef<WorkspaceSort>({ key: "createdAt", ascending: false });
  const workspaceStatePersistence = useRef<Promise<void>>(Promise.resolve());
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
  const fileTaskDismissTimer = useRef<number | null>(null);
  const completedFileTasks = useRef<Set<number>>(new Set());
  const pendingAudioConfig = useRef<{ volume: number; muted: boolean } | null>(null);

  const persistWorkspaceFocus = useCallback(async (workspacePath: string, videoPath: string) => {
    if (workspaceFocusByPath.current[workspacePath]?.videoPath === videoPath) {
      writeClientLog("debug", `工作区焦点无需保存：工作区 ${workspacePath}，视频 ${videoPath}`);
      await workspaceStatePersistence.current;
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
    const pending = workspaceStatePersistence.current.then(async () => {
      try {
        await invoke("set_workspace_focus", { workspacePath, videoPath });
        writeClientLog("debug", `工作区焦点已写入独立状态文件：工作区 ${workspacePath}，视频 ${videoPath}`);
      } catch (error) {
        writeClientLog("warn", `保存工作区视频焦点失败：工作区 ${workspacePath}，视频 ${videoPath}，${errorMessage(error)}`);
      }
    });
    workspaceStatePersistence.current = pending;
    await pending;
  }, []);
  const persistWorkspaceSort = useCallback(async (workspacePath: string, key: SortKey, ascending: boolean) => {
    const previous = workspaceSortByPath.current[workspacePath];
    if (previous?.key === key && previous.ascending === ascending) {
      await workspaceStatePersistence.current;
      return;
    }
    const sort = { key, ascending };
    workspaceSortByPath.current = {
      ...workspaceSortByPath.current,
      [workspacePath]: sort,
    };
    setConfig((current) => ({
      ...current,
      workspaceSort: {
        ...current.workspaceSort,
        [workspacePath]: sort,
      },
    }));
    writeClientLog("debug", `开始保存工作区排序：工作区 ${workspacePath}，字段 ${key}，升序 ${ascending}`);
    const pending = workspaceStatePersistence.current.then(async () => {
      try {
        await invoke("set_workspace_sort", { workspacePath, sortKey: key, sortAscending: ascending });
        writeClientLog("debug", `工作区排序已写入独立状态文件：工作区 ${workspacePath}，字段 ${key}，升序 ${ascending}`);
      } catch (error) {
        writeClientLog("warn", `保存工作区排序失败：工作区 ${workspacePath}，${errorMessage(error)}`);
      }
    });
    workspaceStatePersistence.current = pending;
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
    if (
      (sortKey === "duration" || sortKey === "resolution") &&
      workspace.videos.some(
        (video) =>
          (video.duration === null || video.width === null || video.height === null) &&
          !probedMetadataPaths.current.has(video.path),
      )
    ) {
      writeClientLog("debug", `等待媒体信息完成后恢复工作区焦点：${workspace.path}`);
      return;
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
  }, [gridColumns, gridRowVirtualizer, gridViewport, listRowVirtualizer, sortKey, viewMode, visibleVideos, workspace]);

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
    invalidateThumbnailData(thumbnail.thumbnailPath);
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
      const nextVolume = Math.round(Math.min(100, Math.max(0, volume)));
      pendingAudioConfig.current = {
        volume: nextVolume,
        muted,
      };
      setConfig((current) => ({
        ...current,
        settings: {
          ...current.settings,
          volume: nextVolume,
          muted,
        },
      }));

      const persist = () => {
        const pending = pendingAudioConfig.current;
        pendingAudioConfig.current = null;
        if (!pending) {
          return;
        }
        void invoke<AppConfig>("set_audio_preferences", pending)
          .then((saved) => {
            setConfig((current) => ({
              ...current,
              version: saved.version,
              settings: {
                ...current.settings,
                volume: saved.settings.volume,
                muted: saved.settings.muted,
              },
            }));
          })
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
    [],
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
      const listing = await invoke<DirectoryChildren>("list_subdirectories", { path });
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
    workspaceMemoryEnabled = config.settings.rememberWorkspaceFocus,
  ) => {
    if (workspaceMemoryEnabled && workspace) {
      if (selectionAnchor && selectedVideos.has(selectionAnchor)) {
        writeClientLog("debug", `切换工作区前保存当前焦点：工作区 ${workspace.path}，视频 ${selectionAnchor}`);
        await persistWorkspaceFocus(workspace.path, selectionAnchor);
      }
      await persistWorkspaceSort(
        workspace.path,
        activeWorkspaceSort.current.key,
        activeWorkspaceSort.current.ascending,
      );
    }
    const requestId = ++workspaceRequest.current;
    const scanRequestId = ++workspaceScanRequest.current;
    metadataRequest.current += 1;
    probedMetadataPaths.current.clear();
    setMetadataLoading(false);
    setWorkspaceLoading(true);
    writeClientLog("info", `打开工作区：${requestedPath}`);
    try {
      const listing = await invoke<WorkspaceListing>("scan_workspace", {
        path: requestedPath,
        requestId: scanRequestId,
      });
      if (requestId !== workspaceRequest.current || scanRequestId !== workspaceScanRequest.current) {
        // Ignore stale responses so rapid directory navigation cannot overwrite the latest workspace.
        return;
      }
      thumbnailQueue.current = [];
      queuedThumbnailPaths.current.clear();
      thumbnailFailures.current.clear();
      thumbnailPathOverrideRef.current.clear();
      setThumbnailPathOverrides(new Map());
      workspaceVideoPaths.current = new Set(listing.videos.map((video) => video.path));
      const rememberedSort = workspaceMemoryEnabled ? workspaceSortByPath.current[listing.path] : undefined;
      if (workspaceMemoryEnabled) {
        const restoredSort = rememberedSort ?? { key: "createdAt" as const, ascending: false };
        activeWorkspaceSort.current = restoredSort;
        setSortKey(restoredSort.key);
        setSortAscending(restoredSort.ascending);
      }
      if (rememberedSort) {
        writeClientLog(
          "debug",
          `工作区排序命中：工作区 ${listing.path}，字段 ${rememberedSort.key}，升序 ${rememberedSort.ascending}`,
        );
      } else if (workspaceMemoryEnabled) {
        writeClientLog("debug", `工作区没有已保存排序，使用创建日期降序：${listing.path}`);
      }
      const rememberedPath = workspaceMemoryEnabled ? workspaceFocusByPath.current[listing.path]?.videoPath : undefined;
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
      } else if (workspaceMemoryEnabled) {
        writeClientLog("debug", `工作区没有已保存焦点：${listing.path}`);
      } else {
        writeClientLog("debug", `工作区排序与焦点记忆已关闭，滚动位置将从顶部开始：${listing.path}`);
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
          setConfig((current) => ({
            ...current,
            version: nextConfig.version,
            lastWorkspace: nextConfig.lastWorkspace,
          }));
        }
      }
    } catch (error) {
      if (requestId === workspaceRequest.current && scanRequestId === workspaceScanRequest.current) {
        const message = errorMessage(error);
        workspaceVideoPaths.current.clear();
        setWorkspace({
          path: requestedPath,
          videos: [],
          mediaSuppressed: false,
          isAvailable: false,
        });
        setSelectedPath(requestedPath);
        setSelectedVideos(new Set());
        setSelectionAnchor(null);
        notify(message);
        writeClientLog("warn", `工作区暂不可用，已保留位置等待恢复：${requestedPath}，${message}`);
      }
    } finally {
      if (requestId === workspaceRequest.current) {
        setWorkspaceLoading(false);
      }
    }
  };

  const markWorkspaceUnavailable = (path: string, reason: string) => {
    workspaceVideoPaths.current.clear();
    setWorkspace((current) =>
      current && current.path.toLocaleLowerCase() === path.toLocaleLowerCase()
        ? { ...current, videos: [], mediaSuppressed: false, isAvailable: false }
        : current,
    );
    setSelectedVideos(new Set());
    setSelectionAnchor(null);
    writeClientLog("warn", `工作区连接中断，已停止预览并等待恢复：${reason}`);
  };

  const refreshWorkspace = async (path: string, reason = "目录变更") => {
    const scanRequestId = ++workspaceScanRequest.current;
    try {
      const listing = await invoke<WorkspaceListing>("scan_workspace", { path, requestId: scanRequestId });
      if (scanRequestId !== workspaceScanRequest.current) {
        return;
      }
      workspaceVideoPaths.current = new Set(listing.videos.map((video) => video.path));
      setWorkspace((current) => {
        if (!current || current.path.toLocaleLowerCase() !== path.toLocaleLowerCase()) {
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
      if (scanRequestId !== workspaceScanRequest.current) {
        return;
      }
      markWorkspaceUnavailable(path, errorMessage(error));
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
    if (workspace && (sortKey === "duration" || sortKey === "resolution")) {
      void loadWorkspaceMetadata();
    }
  }, [sortKey, workspace?.path]);

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
        setConfig((current) => ({
          ...current,
          version: nextConfig.version,
          favorites: nextConfig.favorites,
        }));
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
    if (!workspace?.isAvailable) {
      return;
    }
    try {
      const nextConfig = await invoke<AppConfig>("toggle_favorite", { path: workspace.path });
      setConfig((current) => ({
        ...current,
        version: nextConfig.version,
        favorites: nextConfig.favorites,
      }));
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
      const focusedVideoPath = selectedVideo && paths.includes(selectedVideo.path) ? selectedVideo.path : null;
      if (focusedVideoPath) {
        previewPlayerRef.current?.stopPlayback();
        await invoke("stop_transcoded_preview", { path: focusedVideoPath });
        previewPlayerRef.current?.releasePlayback();
      }
      const result = await invoke<RecycleResult>("recycle_videos", { paths, focusedVideoPath });
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

  const startTransferTask = async (
    paths: string[],
    destinationPath: string,
    operation: FileTaskOperation = "copy",
  ) => {
    if (paths.length === 0) {
      return null;
    }
    try {
      if (fileTaskDismissTimer.current !== null) {
        window.clearTimeout(fileTaskDismissTimer.current);
        fileTaskDismissTimer.current = null;
      }
      const task = await invoke<FileTaskSnapshot>("start_file_task", { paths, destinationPath, operation });
      setActiveFileTask(task);
      notify(`${operation === "move" ? "移动" : "复制"}任务 #${task.id} 已加入队列`);
      writeClientLog("info", `文件任务 #${task.id} 已创建：${operation} ${paths.length} 个项目到 ${destinationPath}`);
      return task;
    } catch (error) {
      const message = errorMessage(error);
      notify(message);
      writeClientLog("error", `创建文件任务失败：${message}`);
      return null;
    }
  };

  const copyDroppedVideos = async (paths: string[], workspacePath: string) => {
    await startTransferTask(paths, workspacePath, "copy");
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
      await startTransferTask(paths, destination, "copy");
    } catch (error) {
      const message = errorMessage(error);
      notify(message);
      writeClientLog("error", `复制到目录失败：${message}`);
    }
  };

  const writeSelectionToFileClipboard = async (operation: FileTaskOperation) => {
    const paths = [...selectedVideos];
    if (paths.length === 0) {
      return;
    }
    try {
      await invoke("write_files_to_clipboard", { paths, operation });
      notify(`已${operation === "move" ? "剪切" : "复制"} ${paths.length} 个视频，可粘贴到本应用或资源管理器`);
      writeClientLog("info", `写入系统文件剪贴板：${operation} ${paths.length} 个视频`);
    } catch (error) {
      const message = errorMessage(error);
      notify(message);
      writeClientLog("error", `写入系统文件剪贴板失败：${message}`);
    }
  };

  const pasteFileClipboard = async () => {
    if (!workspace?.isAvailable) {
      return;
    }
    try {
      if (fileTaskDismissTimer.current !== null) {
        window.clearTimeout(fileTaskDismissTimer.current);
        fileTaskDismissTimer.current = null;
      }
      const task = await invoke<FileTaskSnapshot>("paste_files_from_clipboard", {
        destinationPath: workspace.path,
      });
      setActiveFileTask(task);
      notify(`${task.operation === "move" ? "移动" : "复制"}任务 #${task.id} 已加入队列`);
      writeClientLog("info", `从系统文件剪贴板创建任务 #${task.id}，目标 ${workspace.path}`);
    } catch (error) {
      const message = errorMessage(error);
      notify(message);
      writeClientLog("error", `粘贴系统文件剪贴板失败：${message}`);
    }
  };

  const cancelActiveFileTask = async () => {
    if (!activeFileTask || !["queued", "running"].includes(activeFileTask.state)) {
      return;
    }
    try {
      const accepted = await invoke<boolean>("cancel_file_task", { taskId: activeFileTask.id });
      notify(accepted ? `正在取消任务 #${activeFileTask.id} 的未开始项目` : `任务 #${activeFileTask.id} 已无法取消`);
    } catch (error) {
      notify(errorMessage(error));
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
      y: Math.max(12, Math.min(event.clientY, window.innerHeight - (paths.length > 0 ? 342 : 190))),
      workspacePath: workspace.path,
      paths,
      primaryPath,
    });
  };

  const runWorkspaceContextMenuAction = async (
    action: "open" | "reveal" | "copyTo" | "clipboardCopy" | "clipboardCut" | "paste" | "delete" | "refresh",
  ) => {
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
      } else if (action === "copyTo" && menu.paths.length > 0) {
        await copyVideosToDirectory(menu.paths);
      } else if (action === "clipboardCopy" && menu.paths.length > 0) {
        await invoke("write_files_to_clipboard", { paths: menu.paths, operation: "copy" });
        notify(`已复制 ${menu.paths.length} 个视频到系统文件剪贴板`);
      } else if (action === "clipboardCut" && menu.paths.length > 0) {
        await invoke("write_files_to_clipboard", { paths: menu.paths, operation: "move" });
        notify(`已剪切 ${menu.paths.length} 个视频到系统文件剪贴板`);
      } else if (action === "paste") {
        await pasteFileClipboard();
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
        settings: settingsDraft,
      });
      setConfig((current) => ({
        ...current,
        version: nextConfig.version,
        settings: nextConfig.settings,
      }));
      setIsSettingsOpen(false);
      if (thumbnailPositionChanged && workspace) {
        clearThumbnailDataCache();
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
      const nextConfig = await invoke<AppConfig>("set_list_columns", { listColumns });
      setConfig((current) => ({
        ...current,
        version: nextConfig.version,
        settings: {
          ...current.settings,
          listColumns: nextConfig.settings.listColumns,
        },
      }));
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
    void listen<FileTaskSnapshot>("file-task-progress", (event) => {
      const task = event.payload;
      setActiveFileTask((current) => (!current || current.id === task.id || task.id > current.id ? task : current));
      if (!["completed", "cancelled"].includes(task.state) || completedFileTasks.current.has(task.id)) {
        return;
      }
      completedFileTasks.current.add(task.id);
      const completed = task.results.filter((result) => result.status === "completed").length;
      const skipped = task.results.filter((result) => result.status === "skipped").length;
      const failed = task.results.filter((result) => result.status === "failed").length;
      const cancelled = task.results.filter((result) => result.status === "cancelled").length;
      const verb = task.operation === "move" ? "移动" : "复制";
      notify(`${verb}任务 #${task.id}：成功 ${completed}，跳过 ${skipped}，失败 ${failed}${cancelled ? `，取消 ${cancelled}` : ""}`);
      writeClientLog(
        failed > 0 ? "warn" : "info",
        `文件任务 #${task.id} 完成：${verb}成功 ${completed}，跳过 ${skipped}，失败 ${failed}，取消 ${cancelled}`,
      );
      if (workspace?.path) {
        void refreshWorkspace(workspace.path, `文件任务 #${task.id} 完成`);
      }
      if (fileTaskDismissTimer.current !== null) {
        window.clearTimeout(fileTaskDismissTimer.current);
      }
      fileTaskDismissTimer.current = window.setTimeout(() => {
        setActiveFileTask((current) => (current?.id === task.id ? null : current));
        fileTaskDismissTimer.current = null;
      }, 5000);
    })
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch((error: unknown) => writeClientLog("warn", `文件任务监听不可用：${errorMessage(error)}`));
    return () => unlisten?.();
  }, [workspace?.path]);

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
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (modifier && key === "c" && selectedVideos.size > 0) {
        event.preventDefault();
        if (!event.repeat) {
          void writeSelectionToFileClipboard("copy");
        }
        return;
      }
      if (modifier && key === "x" && selectedVideos.size > 0) {
        event.preventDefault();
        if (!event.repeat) {
          void writeSelectionToFileClipboard("move");
        }
        return;
      }
      if (modifier && key === "v" && workspace?.isAvailable) {
        event.preventDefault();
        if (!event.repeat) {
          void pasteFileClipboard();
        }
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
      if (modifier && key === "a" && visibleVideos.length > 0) {
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
  }, [isSettingsOpen, metadataLoading, selectedVideos, selectionAnchor, visibleVideos, workspace?.isAvailable, workspace?.path]);

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
    if (!workspace?.isAvailable) {
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
  }, [workspace?.isAvailable, workspace?.path]);

  useEffect(() => {
    if (!workspace?.isAvailable) {
      return;
    }
    let unlisten: (() => void) | undefined;
    let refreshTimer: number | undefined;
    let active = true;
    void listen<string>("workspace-file-event", (event) => {
      if (event.payload.toLocaleLowerCase() !== workspace.path.toLocaleLowerCase()) {
        return;
      }
      if (refreshTimer) {
        window.clearTimeout(refreshTimer);
      }
      refreshTimer = window.setTimeout(() => {
        if (active) {
          void refreshWorkspace(workspace.path);
        }
      }, 300);
    })
      .then((cleanup) => {
        if (active) {
          unlisten = cleanup;
          writeClientLog("debug", `工作区后端监听已启动：${workspace.path}`);
        } else {
          cleanup();
        }
      })
      .catch((error: unknown) => writeClientLog("warn", `工作区监听事件不可用：${errorMessage(error)}`));
    return () => {
      active = false;
      if (refreshTimer) {
        window.clearTimeout(refreshTimer);
      }
      unlisten?.();
    };
  }, [workspace?.isAvailable, workspace?.path]);

  useEffect(() => {
    if (!workspace) {
      return;
    }
    const path = workspace.path;
    const expectedAvailability = workspace.isAvailable;
    let checking = false;
    let active = true;
    const recoveryTimer = window.setInterval(() => {
      if (checking) {
        return;
      }
      checking = true;
      void invoke<boolean>("workspace_is_accessible", { path })
        .then((accessible) => {
          if (!active) {
            return;
          }
          if (accessible && !expectedAvailability) {
            void refreshWorkspace(path, "目录恢复探测");
          } else if (!accessible && expectedAvailability) {
            markWorkspaceUnavailable(path, "目录已无法访问");
            void refreshWorkspace(path, "目录断连确认");
          }
        })
        .catch((error: unknown) => writeClientLog("warn", `工作区可访问性探测失败：${errorMessage(error)}`))
        .finally(() => {
          checking = false;
        });
    }, 2500);
    return () => {
      active = false;
      window.clearInterval(recoveryTimer);
    };
  }, [workspace?.isAvailable, workspace?.path]);

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
        workspaceSortByPath.current = state.config.workspaceSort ?? {};
        writeClientLog(
          "debug",
          `加载工作区记忆配置：焦点 ${Object.keys(workspaceFocusByPath.current).length} 个，排序 ${Object.keys(workspaceSortByPath.current).length} 个工作区记录`,
        );
        setConfig(state.config);
        setRoots(state.roots);
        const elevated = await invoke<boolean>("is_running_as_administrator").catch(() => false);
        if (elevated) {
          notify("当前应用以管理员权限运行，Windows 会拒绝从普通资源管理器窗口拖入文件。请以普通权限重新启动应用。");
          writeClientLog("warn", "检测到管理员权限：普通资源管理器的文件拖入会被 Windows 阻止");
        }
        if (state.config.lastWorkspace) {
          await activateWorkspace(
            state.config.lastWorkspace,
            false,
            state.config.settings.rememberWorkspaceFocus,
          );
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
                activeWorkspaceSort.current = { key: nextSortKey, ascending: sortAscending };
                setSortKey(nextSortKey);
                if (workspace && config.settings.rememberWorkspaceFocus) {
                  void persistWorkspaceSort(workspace.path, nextSortKey, sortAscending);
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
            onClick={() => {
              const nextAscending = !sortAscending;
              activeWorkspaceSort.current = { key: sortKey, ascending: nextAscending };
              setSortAscending(nextAscending);
              if (workspace && config.settings.rememberWorkspaceFocus) {
                void persistWorkspaceSort(workspace.path, sortKey, nextAscending);
              }
            }}
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
              {!workspace.isAvailable
                ? "此位置暂不可用，正在等待设备或网络位置恢复"
                : workspace.mediaSuppressed
                ? "此目录的媒体已被 .nomedia 隐藏"
                : searchQuery
                  ? "没有匹配的视频"
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

      {activeFileTask && (
        <section className="file-task-card" aria-label={`文件任务 ${activeFileTask.id}`}>
          <div className="file-task-heading">
            <div>
              <strong>{activeFileTask.operation === "move" ? "移动" : "复制"}任务 #{activeFileTask.id}</strong>
              <span>
                {activeFileTask.state === "queued" && "等待开始"}
                {activeFileTask.state === "running" && `正在处理 ${Math.min(activeFileTask.totalItems, activeFileTask.completedItems + 1)} / ${activeFileTask.totalItems}`}
                {activeFileTask.state === "completed" && "已完成"}
                {activeFileTask.state === "cancelled" && "已取消未开始项目"}
              </span>
            </div>
            {["queued", "running"].includes(activeFileTask.state) && (
              <button type="button" onClick={() => void cancelActiveFileTask()}>取消</button>
            )}
          </div>
          <progress max={Math.max(1, activeFileTask.totalItems)} value={activeFileTask.completedItems} />
          <div className="file-task-summary" title={activeFileTask.results.find((result) => result.error)?.error ?? undefined}>
            <span>成功 {activeFileTask.results.filter((result) => result.status === "completed").length}</span>
            <span>跳过 {activeFileTask.results.filter((result) => result.status === "skipped").length}</span>
            <span>失败 {activeFileTask.results.filter((result) => result.status === "failed").length}</span>
          </div>
        </section>
      )}
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
              <button type="button" role="menuitem" onClick={() => void runWorkspaceContextMenuAction("clipboardCopy")}>
                <ClipboardCopy size={16} />
                复制 <span className="menu-shortcut">Ctrl+C</span>
              </button>
              <button type="button" role="menuitem" onClick={() => void runWorkspaceContextMenuAction("clipboardCut")}>
                <Scissors size={16} />
                剪切 <span className="menu-shortcut">Ctrl+X</span>
              </button>
              <button type="button" role="menuitem" onClick={() => void runWorkspaceContextMenuAction("copyTo")}>
                <FolderOpen size={16} />
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
          <button type="button" role="menuitem" onClick={() => void runWorkspaceContextMenuAction("paste")}>
            <ClipboardPaste size={16} />
            粘贴 <span className="menu-shortcut">Ctrl+V</span>
          </button>
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
                  <span>记忆工作区排序与视频焦点</span>
                  <button
                    className={`switch ${settingsDraft.rememberWorkspaceFocus ? "on" : ""}`}
                    type="button"
                    role="switch"
                    aria-checked={settingsDraft.rememberWorkspaceFocus}
                    aria-label="记忆工作区排序与视频焦点"
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
