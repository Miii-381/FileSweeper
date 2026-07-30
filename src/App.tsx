import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { colorModeTokens, themePresets } from "./theme";
import type { PreviewPlayerHandle } from "./components/PreviewPlayer";
import { ThemedContextMenu } from "./components/ThemedContextMenu";
import { ThemedConfirmDialog } from "./components/ThemedConfirmDialog";
import { AppTitlebar } from "./features/navigation/AppTitlebar";
import { NavigationPanel } from "./features/navigation/NavigationPanel";
import { useToast } from "./features/useToast";
import { PreviewPanel } from "./features/preview/PreviewPanel";
import { useAudioPreferences } from "./features/preview/useAudioPreferences";
import { LogDialog } from "./features/settings/LogDialog";
import { SettingsDialog } from "./features/settings/SettingsDialog";
import { useLogViewer } from "./features/settings/useLogViewer";
import { useSettingsController } from "./features/settings/useSettingsController";
import { WorkspacePanel } from "./features/workspace/WorkspacePanel";
import { FileTaskCard } from "./features/workspace/FileTaskCard";
import { MetadataLoadingOverlay } from "./features/workspace/MetadataLoadingOverlay";
import { useThumbnailQueue } from "./features/workspace/useThumbnailQueue";
import { useFileTasks } from "./features/workspace/useFileTasks";
import { useWorkspaceGestures } from "./features/workspace/useWorkspaceGestures";
import { useWorkspaceMenu } from "./features/workspace/useWorkspaceMenu";
import { useMediaMetadata } from "./features/workspace/useMediaMetadata";
import { useWorkspaceKeyboard } from "./features/workspace/useWorkspaceKeyboard";
import { useWorkspaceMonitoring } from "./features/workspace/useWorkspaceMonitoring";
import { useWorkspaceViewState } from "./features/workspace/useWorkspaceViewState";
import { useWorkspaceController } from "./features/workspace/useWorkspaceController";
import {
  type AppConfig,
  type ApplicationState,
  type AboutInfo,
  type DataManagementSummary,
  type ColorMode,
  type DirectoryEntry,
  type DirectoryChildren,
  type DirectoryRecycleResult,
  type SettingsLimits,
  type TreeState,
  type WorkspaceListing,
  type WindowState,
} from "./app-types";
import {
  errorMessage,
  writeClientLog,
} from "./app-utils";
import {
  useEffect,
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";

const WORKSPACE_CARD_WIDTH = 240;
const WORKSPACE_GRID_HORIZONTAL_PADDING = 32;
const WORKSPACE_GRID_SCROLLBAR_GUTTER = 10;
const PANEL_RESIZE_HANDLE_WIDTH = 12;

function workspaceMinimumSize(groupWidth: number, previewOpen: boolean) {
  const handleCount = previewOpen ? 2 : 1;
  const panelWidth = Math.max(1, groupWidth - handleCount * PANEL_RESIZE_HANDLE_WIDTH);
  const minimumWidth = WORKSPACE_CARD_WIDTH + WORKSPACE_GRID_HORIZONTAL_PADDING + WORKSPACE_GRID_SCROLLBAR_GUTTER;
  return Math.min(100, (minimumWidth / panelWidth) * 100);
}

function isSameOrDescendantPath(path: string, parent: string) {
  const normalizedParent = parent.replace(/[\\/]+$/, "").toLocaleLowerCase();
  const normalizedPath = path.replace(/[\\/]+$/, "").toLocaleLowerCase();
  return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}\\`) || normalizedPath.startsWith(`${normalizedParent}/`);
}

function parentDirectoryPath(path: string) {
  const normalized = path.replace(/[\\/]+$/, "");
  if (/^[a-z]:$/i.test(normalized)) return null;
  const separator = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  if (separator < 0) return null;
  return separator <= 2 ? normalized.slice(0, separator + 1) : normalized.slice(0, separator);
}



export default function App() {
  const [initialState, setInitialState] = useState<ApplicationState | null>(null);
  const [initializationError, setInitializationError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    writeClientLog("info", "开始加载后端应用状态");
    void invoke<ApplicationState>("load_application_state")
      .then((state) => {
        if (active) {
          setInitialState(state);
          writeClientLog(
            "info",
            `后端应用状态加载完成：配置版本 ${state.config.version}，根目录 ${state.roots.length} 个，收藏 ${state.config.favorites.length} 个`,
          );
        }
      })
      .catch((error: unknown) => {
        if (active) {
          const message = errorMessage(error);
          setInitializationError(message);
          writeClientLog("error", `后端应用状态加载失败：${message}`);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  if (initializationError) {
    return <main className="app-loading-shell" role="alert">应用初始化失败：{initializationError}</main>;
  }
  if (!initialState) {
    return <main className="app-loading-shell" aria-busy="true">正在加载 FileSweeper…</main>;
  }
  return <FileSweeperApp initialState={initialState} />;
}

function FileSweeperApp({ initialState }: { initialState: ApplicationState }) {
  const [config, setConfig] = useState<AppConfig>(initialState.config);
  const [roots] = useState<DirectoryEntry[]>(initialState.roots);
  const settingsLimits: SettingsLimits = initialState.settingsLimits;
  const [treeState, setTreeState] = useState<TreeState>({});
  const treeStateRef = useRef<TreeState>(treeState);
  treeStateRef.current = treeState;
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [workspace, setWorkspace] = useState<WorkspaceListing | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [navigationHistory, setNavigationHistory] = useState<string[]>([]);
  const [navigationIndex, setNavigationIndex] = useState(-1);
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(true);
  const [leftPanelSize, setLeftPanelSize] = useState(20);
  const [windowStateReady, setWindowStateReady] = useState(false);
  const [confirmation, setConfirmation] = useState<{ title: string; message: string; confirmLabel: string; resolve: (confirmed: boolean) => void } | null>(null);
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null);
  const [dataSummary, setDataSummary] = useState<DataManagementSummary | null>(null);
  const [aboutInfo, setAboutInfo] = useState<AboutInfo | null>(null);
  const [systemColorMode, setSystemColorMode] = useState<ColorMode>("dark");
  const { toast, notify } = useToast();
  const [suppressPreviewAutoplay, setSuppressPreviewAutoplay] = useState(false);
  const [workspaceMinSize, setWorkspaceMinSize] = useState(() => workspaceMinimumSize(window.innerWidth, true));
  const probedMetadataPaths = useRef<Set<string>>(new Set());
  const renameInputRef = useRef<HTMLInputElement>(null);
  const previewPlayerRef = useRef<PreviewPlayerHandle>(null);
  const panelGroupRef = useRef<HTMLDivElement>(null);
  const initializationStarted = useRef(false);

  const effectiveColorMode: ColorMode =
    config.settings.appearance === "system" ? systemColorMode : config.settings.appearance;
  const activeTheme = themePresets.find((theme) => theme.id === config.settings.accentTheme) ?? themePresets[0];
  const wallpaperVisibility = Math.max(0, Math.min(100, config.settings.backgroundOpacity)) / 100;
  const wallpaperBlur = Math.max(0, Math.min(100, config.settings.backgroundBlur)) / 100;
  const neutralSurfaceRgb = effectiveColorMode === "light"
    ? { base: "242 242 247", raised: "255 255 255", control: "255 255 255", resize: "242 242 247", border: "209 209 214" }
    : { base: "28 28 30", raised: "36 36 38", control: "44 44 46", resize: "28 28 30", border: "72 72 74" };
  // Wallpaper visibility should never remove the content foundation entirely.
  // Keeping a role-specific opacity floor preserves contrast on detailed or bright images.
  const surfaceWithOpacityFloor = (rgb: string, minimumOpacity: number) =>
    `rgb(${rgb} / ${minimumOpacity + (1 - minimumOpacity) * (1 - wallpaperVisibility)})`;
  const wallpaperVeilOpacity = 0.04 + wallpaperVisibility * 0.16;
  const {
    viewMode,
    searchQuery,
    setSearchQuery,
    sortKey,
    sortAscending,
    gridColumns,
    selectedFile,
    visibleFiles,
    visibleListColumns,
    listGridStyle,
    gridRowVirtualizer,
    listRowVirtualizer,
    setGridScrollRef,
    listScrollElement,
    scrollWorkspaceToStart,
    scrollWorkspaceToFocus,
    captureWorkspaceScroll,
    persistWorkspaceFocus,
    persistWorkspaceSort,
    prepareWorkspace: prepareWorkspaceView,
    changeSortKey: changeWorkspaceSortKey,
    toggleSortDirection: toggleWorkspaceSortDirection,
    changeViewMode: changeWorkspaceViewMode,
    getActiveSort,
    memorySummary: workspaceMemorySummary,
  } = useWorkspaceViewState({
    initialConfig: initialState.config,
    config,
    setConfig,
    workspace,
    selectedFiles,
    selectionAnchor,
    probedMetadataPaths,
    notify,
  });

  const {
    pathOverrides: thumbnailPathOverrides,
    visibilityRevision: thumbnailVisibilityRevision,
    handleViewportScroll: handleThumbnailViewportScroll,
    enqueue: enqueueThumbnail,
    clearDisplayOverrides: clearThumbnailDisplayOverrides,
    resetForCapturePosition: resetThumbnailsForCapturePosition,
  } = useThumbnailQueue({
    workspacePath: workspace?.path ?? null,
    concurrency: config.settings.backgroundSidecarConcurrency,
  });

  const themeStyle = {
    ...colorModeTokens[effectiveColorMode],
    "--accent": activeTheme.color,
    "--accent-soft": activeTheme.soft,
    "--accent-deep": effectiveColorMode === "light" ? activeTheme.lightDeep : activeTheme.deep,
    "--accent-border": activeTheme.border,
    "--accent-ink": activeTheme.ink,
    "--accent-focus": activeTheme.focus,
    "--surface-base-rgba": surfaceWithOpacityFloor(neutralSurfaceRgb.base, 0.68),
    "--surface-raised-rgba": surfaceWithOpacityFloor(neutralSurfaceRgb.raised, 0.78),
    "--surface-control-rgba": surfaceWithOpacityFloor(neutralSurfaceRgb.control, 0.88),
    "--surface-resize-rgba": surfaceWithOpacityFloor(neutralSurfaceRgb.resize, 0.72),
    "--border-subtle-rgba": surfaceWithOpacityFloor(neutralSurfaceRgb.border, 0.6),
    "--wallpaper-veil": `rgb(${neutralSurfaceRgb.base} / ${wallpaperVeilOpacity})`,
    "--surface-backdrop-blur": `${(wallpaperVisibility * wallpaperBlur * 2).toFixed(2)}px`,
    "--background-opacity": `${config.settings.backgroundOpacity}%`,
    "--background-image": backgroundUrl ? `url("${backgroundUrl}")` : "none",
  } as CSSProperties;


  const updateAudioPreferences = useAudioPreferences(setConfig);

  const confirmRecycle = useCallback((message: string, title = "确认移到回收站", confirmLabel = "移到回收站") => new Promise<boolean>((resolve) => setConfirmation({ title, message, confirmLabel, resolve })), []);

  const {
    metadataLoading,
    selectedMetadataLoading,
    reset: resetMetadata,
  } = useMediaMetadata({
    workspace,
    setWorkspace,
    selectedFile,
    sortKey,
    concurrency: config.settings.backgroundSidecarConcurrency,
    probedPaths: probedMetadataPaths,
    notify,
  });

  const {
    isOpen: isLogPanelOpen,
    snapshot: logSnapshot,
    content: filteredFileLogs,
    error: logPanelError,
    loading: logLoading,
    minimumLevel: logMinimumLevel,
    setMinimumLevel: setLogMinimumLevel,
    pollLogs,
    open: openLogs,
    close: closeLogs,
    copy: copyLogs,
  } = useLogViewer(notify);


  const loadTreeChildren = useCallback(async (path: string) => {
    writeClientLog("debug", `读取目录树：${path}`);
    setTreeState((current) => ({
      ...current,
      [path]: { status: "loading", folders: current[path]?.folders ?? [] },
    }));
    try {
      const listing = await invoke<DirectoryChildren>("list_subdirectories", { path });
      const previousFolders = treeStateRef.current[path]?.folders ?? [];
      const nextFolderPaths = new Set(listing.folders.map((folder) => folder.path.toLocaleLowerCase()));
      const removedPaths = previousFolders
        .filter((folder) => !nextFolderPaths.has(folder.path.toLocaleLowerCase()))
        .map((folder) => folder.path);
      setTreeState((current) => ({
        ...current,
        [path]: { status: "loaded", folders: listing.folders },
      }));
      if (removedPaths.length > 0) {
        setTreeState((current) => Object.fromEntries(
          Object.entries(current).filter(([currentPath]) => !removedPaths.some((removed) => isSameOrDescendantPath(currentPath, removed))),
        ));
        setExpandedPaths((current) => new Set(
          [...current].filter((currentPath) => !removedPaths.some((removed) => isSameOrDescendantPath(currentPath, removed))),
        ));
        setSelectedPath((current) => current && removedPaths.some((removed) => isSameOrDescendantPath(current, removed)) ? null : current);
        writeClientLog("debug", `目录树刷新已清理 ${removedPaths.length} 个失效子树：${path}`);
      }
      writeClientLog("info", `目录树读取完成：${path}，子目录 ${listing.folders.length} 个`);
    } catch (error) {
      setTreeState((current) => ({
        ...current,
        [path]: { status: "error", folders: [] },
      }));
      writeClientLog("warn", `目录树读取失败：${path}，${errorMessage(error)}`);
    }
  }, []);

  const { activateWorkspace, refreshWorkspace, markWorkspaceUnavailable } = useWorkspaceController({
    config,
    setConfig,
    workspace,
    setWorkspace,
    selectedFiles,
    setSelectedFiles,
    selectionAnchor,
    setSelectionAnchor,
    setSelectedPath,
    setWorkspaceLoading,
    setSuppressPreviewAutoplay,
    resetMetadata,
    clearThumbnailDisplayOverrides,
    prepareWorkspaceView,
    captureWorkspaceScroll,
    persistWorkspaceFocus,
    persistWorkspaceSort,
    getActiveSort,
    notify,
  });

  const navigateDirectory = useCallback(async (path: string, historyIndex: number | null = null) => {
    const opened = await activateWorkspace(path);
    if (!opened) return;
    if (historyIndex !== null) {
      setNavigationIndex(historyIndex);
      return;
    }
    const base = navigationIndex >= 0 ? navigationHistory.slice(0, navigationIndex + 1) : [];
    if (base.at(-1)?.toLocaleLowerCase() !== path.toLocaleLowerCase()) {
      setNavigationHistory([...base, path]);
    }
    setNavigationIndex(Math.max(0, base.length - (base.at(-1)?.toLocaleLowerCase() === path.toLocaleLowerCase() ? 1 : 0)));
  }, [activateWorkspace, navigationHistory, navigationIndex]);

  const navigateBack = useCallback(() => {
    if (navigationIndex <= 0) return;
    void navigateDirectory(navigationHistory[navigationIndex - 1], navigationIndex - 1);
  }, [navigateDirectory, navigationHistory, navigationIndex]);

  const navigateForward = useCallback(() => {
    if (navigationIndex < 0 || navigationIndex >= navigationHistory.length - 1) return;
    void navigateDirectory(navigationHistory[navigationIndex + 1], navigationIndex + 1);
  }, [navigateDirectory, navigationHistory, navigationIndex]);

  const navigateUp = useCallback(() => {
    if (!workspace) return;
    const parent = parentDirectoryPath(workspace.path);
    if (parent && parent.toLocaleLowerCase() !== workspace.path.toLocaleLowerCase()) void navigateDirectory(parent);
  }, [navigateDirectory, workspace]);


  const {
    renamingPath,
    renameDraft,
    setRenameDraft,
    activeFileTask,
    recycleFiles,
    recycleSelectedFiles,
    startInlineRename,
    cancelInlineRename,
    submitInlineRename,
    copyDroppedFiles,
    copyFilesToDirectory,
    writeFilesToClipboard,
    writeSelectionToFileClipboard,
    pasteFileClipboard,
    cancelActiveFileTask,
  } = useFileTasks({
    workspace,
    setWorkspace,
    selectedFiles,
    setSelectedFiles,
    setSelectionAnchor,
    selectedFile,
    previewPlayerRef,
    refreshWorkspace,
    notify,
    confirmRecycle,
  });

  const recycleDirectory = useCallback(async (path: string) => {
    if (!await confirmRecycle(`将文件夹“${path}”及其内容移到回收站？`)) {
      writeClientLog("info", `用户取消目录回收站操作：${path}`);
      return;
    }
    writeClientLog("info", `开始目录回收站操作：${path}`);
    try {
      const result = await invoke<DirectoryRecycleResult>("recycle_directory", { path });
      const deletedPath = result.recycledPath;
      const removedCurrentWorkspace = Boolean(workspace && isSameOrDescendantPath(workspace.path, deletedPath));
      setConfig(result.config);
      setTreeState((current) => Object.fromEntries(
        Object.entries(current).filter(([currentPath]) => !isSameOrDescendantPath(currentPath, deletedPath)),
      ));
      setExpandedPaths((current) => new Set([...current].filter((currentPath) => !isSameOrDescendantPath(currentPath, deletedPath))));
      setSelectedPath((current) => current && isSameOrDescendantPath(current, deletedPath) ? null : current);
      if (removedCurrentWorkspace) {
        previewPlayerRef.current?.stopPlayback();
        previewPlayerRef.current?.releasePlayback();
        resetMetadata();
        setWorkspace(null);
        setWorkspaceLoading(false);
        setSelectedFiles(new Set());
        setSelectionAnchor(null);
        setSuppressPreviewAutoplay(true);
        writeClientLog("info", `已清空被删除目录中的当前工作区：${deletedPath}`);
      }
      const parent = parentDirectoryPath(deletedPath);
      if (parent) {
        await loadTreeChildren(parent);
        if (!removedCurrentWorkspace && workspace?.isAvailable && workspace.path.localeCompare(parent, undefined, { sensitivity: "accent" }) === 0) {
          await refreshWorkspace(workspace.path, "目录回收站删除后刷新");
        }
      }
      notify(`已将文件夹移到回收站：${deletedPath}`);
      writeClientLog("info", `目录回收站操作完成：${deletedPath}`);
    } catch (error) {
      const message = errorMessage(error);
      notify(message);
      writeClientLog("error", `目录回收站操作失败，已保留界面状态：${path}，${message}`);
    }
  }, [confirmRecycle, loadTreeChildren, notify, refreshWorkspace, resetMetadata, setConfig, setSelectedFiles, setSelectionAnchor, setSuppressPreviewAutoplay, setWorkspace, workspace]);

  const {
    selectionBox: workspaceSelectionBox,
    selectFile,
    clearSelection: clearWorkspaceSelection,
    clearSelectionFromBackground,
    startRectangleSelection: startWorkspaceRectangleSelection,
    updateRectangleSelection: updateWorkspaceRectangleSelection,
    finishRectangleSelection: finishWorkspaceRectangleSelection,
    startFileDrag: startWorkspaceFileDrag,
    updateFileDrag: updateWorkspaceFileDrag,
    finishFileDrag: finishWorkspaceFileDrag,
  } = useWorkspaceGestures({
    hasWorkspace: Boolean(workspace),
    files: visibleFiles,
    selectedFiles,
    setSelectedFiles,
    selectionAnchor,
    setSelectionAnchor,
    setSuppressPreviewAutoplay,
    renamingPath,
    notify,
  });

  const {
    menu: workspaceContextMenu,
    close: closeWorkspaceContextMenu,
    showPathMenu: showPathContextMenu,
    showWorkspaceMenu: showWorkspaceContextMenu,
    runAction: runWorkspaceContextMenuAction,
  } = useWorkspaceMenu({
    workspace,
    refreshWorkspace,
    activateWorkspace: navigateDirectory,
    copyFilesToDirectory,
    writeFilesToClipboard,
    pasteFileClipboard,
    recycleFiles,
    recycleDirectory,
    notify,
  });

  useEffect(() => {
    const paths = [...expandedPaths];
    void invoke("set_directory_tree_watch_paths", { paths }).catch((error: unknown) => {
      writeClientLog("warn", `更新目录树监听范围失败：${errorMessage(error)}`);
    });
  }, [expandedPaths]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    let refreshTimer: number | undefined;
    const pending = new Set<string>();
    void listen<string>("directory-tree-event", (event) => {
      if (!expandedPaths.has(event.payload)) return;
      pending.add(event.payload);
      if (refreshTimer) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        if (!active) return;
        for (const path of pending) void loadTreeChildren(path);
        pending.clear();
      }, 300);
    }).then((cleanup) => {
      if (active) {
        unlisten = cleanup;
      } else {
        cleanup();
      }
    }).catch((error: unknown) => writeClientLog("warn", `目录树监听事件不可用：${errorMessage(error)}`));
    return () => {
      active = false;
      if (refreshTimer) window.clearTimeout(refreshTimer);
      unlisten?.();
    };
  }, [expandedPaths, loadTreeChildren]);

  const {
    isOpen: isSettingsOpen,
    setIsOpen: setIsSettingsOpen,
    open: openSettings,
    apply: applySettings,
    draggedColumn: draggedListColumn,
    dropTarget: listColumnDropTarget,
    dropPosition: listColumnDropPosition,
    startColumnReorder: startListColumnReorder,
    startColumnResize: startListColumnResize,
  } = useSettingsController({
    config,
    setConfig,
    workspace,
    activateWorkspace: async (...args) => { await activateWorkspace(...args); },
    resetThumbnails: resetThumbnailsForCapturePosition,
    notify,
  });

  useEffect(() => {
    let active = true;
    const fileName = config.settings.backgroundImage;
    if (!fileName) {
      setBackgroundUrl(null);
      return () => { active = false; };
    }
    void invoke<string>("get_background_image_url", { fileName })
      .then((url) => { if (active) setBackgroundUrl(url); })
      .catch((error: unknown) => {
        if (active) setBackgroundUrl(null);
        writeClientLog("warn", `读取背景图失败：${errorMessage(error)}`);
      });
    return () => { active = false; };
  }, [config.settings.backgroundImage]);

  useEffect(() => {
    if (!isSettingsOpen) return;
    void Promise.all([
      invoke<DataManagementSummary>("get_data_management_summary"),
      invoke<AboutInfo>("get_about_info"),
    ]).then(([summary, about]) => {
      setDataSummary(summary);
      setAboutInfo(about);
    }).catch((error: unknown) => writeClientLog("warn", `读取数据管理信息失败：${errorMessage(error)}`));
  }, [isSettingsOpen]);

  useEffect(() => {
    let active = true;
    void invoke<WindowState>("get_window_state").then((state) => {
      if (!active) return;
      setLeftPanelSize(state.leftPanelSize);
      setIsPreviewOpen(state.previewOpen);
    }).catch((error: unknown) => writeClientLog("warn", `读取窗口布局失败：${errorMessage(error)}`)).finally(() => {
      if (active) setWindowStateReady(true);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void invoke("save_window_layout", { leftPanelSize: Math.round(leftPanelSize), previewOpen: isPreviewOpen })
        .catch((error: unknown) => writeClientLog("warn", `保存窗口布局失败：${errorMessage(error)}`));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [isPreviewOpen, leftPanelSize]);

  const chooseBackground = useCallback(async () => {
    const selected = await open({ multiple: false, title: "选择背景图", filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }] });
    return typeof selected === "string" ? selected : null;
  }, []);

  const importBackground = useCallback(async (sourcePath: string) => {
    const result = await invoke<{ fileName: string }>("import_background_image", { sourcePath });
    return result.fileName;
  }, []);

  const refreshMaintenance = useCallback(() => {
    void invoke<DataManagementSummary>("get_data_management_summary")
      .then(setDataSummary)
      .catch((error: unknown) => writeClientLog("warn", `刷新数据管理统计失败：${errorMessage(error)}`));
  }, []);

  const clearThumbnails = useCallback(async () => {
    if (!await confirmRecycle("清空全部缩略图缓存？下次浏览时会重新生成缩略图。", "清空缩略图缓存", "清空")) return;
    writeClientLog("info", "用户确认清空全部缩略图缓存");
    await invoke("clear_thumbnail_cache");
    refreshMaintenance();
    writeClientLog("info", "缩略图缓存清空命令已完成");
    notify("缩略图缓存已清空");
  }, [confirmRecycle, notify, refreshMaintenance]);

  const clearOldLogs = useCallback(async () => {
    if (!await confirmRecycle("删除 30 天前的应用日志？此操作不可恢复。", "清理旧日志", "清理")) return;
    writeClientLog("info", "用户确认清理 30 天前的应用日志");
    const removed = await invoke<number>("clear_old_logs");
    refreshMaintenance();
    writeClientLog("info", `旧日志清理命令已完成：删除 ${removed} 个文件`);
    notify(`已清理 ${removed} 个旧日志文件`);
  }, [confirmRecycle, notify, refreshMaintenance]);

  const openManagedPath = useCallback(async (path: string) => {
    writeClientLog("info", `请求在资源管理器中打开应用数据位置：${path}`);
    try {
      await invoke("reveal_path", { path });
      writeClientLog("info", `应用数据位置已交给资源管理器：${path}`);
    } catch (error) {
      writeClientLog("error", `打开应用数据位置失败：${path}，${errorMessage(error)}`);
      throw error;
    }
  }, []);

  const exportDiagnostics = useCallback(async () => {
    writeClientLog("info", "用户请求导出诊断信息");
    try {
      const path = await invoke<string>("export_diagnostics");
      writeClientLog("info", `诊断信息导出完成：${path}`);
      notify(`诊断信息已导出：${path}`);
    } catch (error) {
      writeClientLog("error", `导出诊断信息失败：${errorMessage(error)}`);
      throw error;
    }
  }, [notify]);

  const isExternalDropActive = useWorkspaceMonitoring({
    workspace,
    refreshWorkspace,
    markUnavailable: markWorkspaceUnavailable,
    copyDroppedFiles,
  });

  useWorkspaceKeyboard({
    disabled: metadataLoading || isSettingsOpen,
    workspaceAvailable: Boolean(workspace?.isAvailable),
    files: visibleFiles,
    selectedFiles,
    setSelectedFiles,
    selectionAnchor,
    setSelectionAnchor,
    setSuppressPreviewAutoplay,
    writeClipboard: writeSelectionToFileClipboard,
    pasteClipboard: pasteFileClipboard,
    recycleSelected: recycleSelectedFiles,
    startRename: startInlineRename,
    openFolder: (path) => void navigateDirectory(path),
  });

  const toggleTreeNode = (path: string) => {
    const nextExpanded = !expandedPaths.has(path);
    writeClientLog("debug", `目录树节点${nextExpanded ? "展开" : "折叠"}：${path}`);
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
    writeClientLog("info", `打开目录选择器：目标 ${target === "workspace" ? "工作区" : "收藏夹"}`);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: target === "workspace" ? "打开文件夹" : "添加收藏夹",
      });
      if (typeof selected !== "string") {
        writeClientLog("debug", `目录选择已取消：目标 ${target}`);
        return;
      }
      writeClientLog("info", `目录选择完成：目标 ${target}，路径 ${selected}`);
      if (target === "favorite") {
        const nextConfig = await invoke<AppConfig>("toggle_favorite", { path: selected });
        setConfig((current) => ({
          ...current,
          version: nextConfig.version,
          favorites: nextConfig.favorites,
        }));
        writeClientLog("info", `目录已加入收藏并准备打开：${selected}`);
        await navigateDirectory(selected);
      } else {
        await navigateDirectory(selected);
      }
    } catch (error) {
      const message = errorMessage(error);
      notify(message);
      writeClientLog("error", `选择文件夹失败：${message}`);
    }
  };

  const toggleFavorite = async () => {
    if (!workspace?.isAvailable) {
      writeClientLog("warn", "收藏操作被忽略：当前没有可用工作区");
      return;
    }
    const wasFavorite = config.favorites.some((favorite) => favorite.path === workspace.path);
    writeClientLog("info", `${wasFavorite ? "取消收藏" : "收藏"}当前工作区：${workspace.path}`);
    try {
      const nextConfig = await invoke<AppConfig>("toggle_favorite", { path: workspace.path });
      setConfig((current) => ({
        ...current,
        version: nextConfig.version,
        favorites: nextConfig.favorites,
      }));
      writeClientLog("info", `收藏状态更新完成：路径 ${workspace.path}，收藏 ${!wasFavorite}`);
    } catch (error) {
      const message = errorMessage(error);
      notify(message);
      writeClientLog("error", `更新收藏夹失败：${message}`);
    }
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
      setWorkspaceMinSize(workspaceMinimumSize(group.clientWidth, isPreviewOpen));
    };
    const observer = new ResizeObserver(syncWorkspaceMinimum);
    observer.observe(group);
    syncWorkspaceMinimum();
    return () => observer.disconnect();
  }, [isPreviewOpen]);



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
    // The application provides its own themed menus; suppress the browser menu elsewhere.
    const preventBrowserContextMenu = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", preventBrowserContextMenu);
    return () => document.removeEventListener("contextmenu", preventBrowserContextMenu);
  }, []);

  useEffect(() => {
    if (initializationStarted.current) {
      return;
    }
    initializationStarted.current = true;
    const initialize = async () => {
      const memory = workspaceMemorySummary();
      writeClientLog(
        "debug",
        `加载工作区记忆配置：焦点 ${memory.focus} 个，排序 ${memory.sort} 个工作区记录`,
      );
      const elevated = await invoke<boolean>("is_running_as_administrator").catch((error: unknown) => {
        writeClientLog("warn", `管理员权限检测失败，回退为普通权限提示策略：${errorMessage(error)}`);
        return false;
      });
      if (elevated) {
        notify("当前应用以管理员权限运行，Windows 会拒绝从普通资源管理器窗口拖入文件。请以普通权限重新启动应用。");
        writeClientLog("warn", "检测到管理员权限：普通资源管理器的文件拖入会被 Windows 阻止");
      }
      if (initialState.config.lastWorkspace) {
        writeClientLog("info", `恢复上次工作区：${initialState.config.lastWorkspace}`);
        await navigateDirectory(
          initialState.config.lastWorkspace,
        );
      } else {
        writeClientLog("info", "没有可恢复的上次工作区，显示空工作区界面");
        setWorkspaceLoading(false);
      }
    };
    void initialize();
  }, []);

  const isFavorite = Boolean(workspace && config.favorites.some((favorite) => favorite.path === workspace.path));

  const togglePreviewPanel = () => {
    setIsPreviewOpen((isOpen) => {
      writeClientLog("info", `${isOpen ? "折叠" : "展开"}预览面板`);
      return !isOpen;
    });
  };


  const showFileContextMenu = (event: ReactMouseEvent<HTMLElement>, path: string) => {
    const operationPaths = selectedFiles.has(path) ? [...selectedFiles] : [path];
    setSelectedFiles(new Set(operationPaths));
    setSelectionAnchor(path);
    showWorkspaceContextMenu(event, operationPaths);
  };

  if (!windowStateReady) {
    return <main className="app-loading-shell" aria-busy="true">正在恢复窗口布局…</main>;
  }

  return (
    <main
      className={`app-shell ${effectiveColorMode === "light" ? "light-theme" : ""} ${
        isPreviewOpen ? "" : "preview-collapsed"
      }`}
      style={themeStyle}
    >
      <AppTitlebar
        isFavorite={isFavorite}
        hasWorkspace={Boolean(workspace)}
        searchQuery={searchQuery}
        onChooseWorkspace={() => void chooseFolder("workspace")}
        onSearchChange={setSearchQuery}
        onToggleFavorite={() => void toggleFavorite()}
        onOpenSettings={openSettings}
        onOpenLogs={openLogs}
      />

      <div className="application-panels" ref={panelGroupRef}>
      <PanelGroup
        className="panel-group"
        autoSaveId={isPreviewOpen ? "file-sweeper-three-panels" : "file-sweeper-two-panels"}
        direction="horizontal"
        onLayout={(sizes) => setLeftPanelSize(sizes[0] ?? 20)}
      >
      <Panel defaultSize={leftPanelSize} minSize={0}>
      <NavigationPanel
        config={config}
        roots={roots}
        selectedPath={selectedPath}
        expandedPaths={expandedPaths}
        treeState={treeState}
        onChooseFavorite={() => void chooseFolder("favorite")}
        onSelectPath={(path) => void navigateDirectory(path)}
        onTogglePath={toggleTreeNode}
        onContextMenu={showPathContextMenu}
        onOpenSettings={openSettings}
      />
      </Panel>

      <PanelResizeHandle className="panel-resize-handle" aria-label="调整左栏宽度" />

      <WorkspacePanel
        isPreviewOpen={isPreviewOpen}
        workspaceMinSize={workspaceMinSize}
        workspace={workspace}
        workspaceLoading={workspaceLoading}
        searchQuery={searchQuery}
        sortKey={sortKey}
        sortAscending={sortAscending}
        viewMode={viewMode}
        metadataLoading={metadataLoading}
        changeWorkspaceSortKey={changeWorkspaceSortKey}
        toggleWorkspaceSortDirection={toggleWorkspaceSortDirection}
        changeWorkspaceViewMode={changeWorkspaceViewMode}
        togglePreviewPanel={togglePreviewPanel}
        canNavigateBack={navigationIndex > 0}
        canNavigateForward={navigationIndex >= 0 && navigationIndex < navigationHistory.length - 1}
        canNavigateUp={Boolean(workspace && parentDirectoryPath(workspace.path))}
        navigateBack={navigateBack}
        navigateForward={navigateForward}
        navigateUp={navigateUp}
        navigateTo={(path) => void navigateDirectory(path)}
        chooseWorkspaceFolder={() => void chooseFolder("workspace")}
        visibleFiles={visibleFiles}
        openFolder={(path) => void navigateDirectory(path)}
        clearWorkspaceSelection={clearWorkspaceSelection}
        showWorkspaceContextMenu={showWorkspaceContextMenu}
        setGridScrollRef={setGridScrollRef}
        handleThumbnailViewportScroll={handleThumbnailViewportScroll}
        clearSelectionFromBackground={clearSelectionFromBackground}
        startWorkspaceRectangleSelection={startWorkspaceRectangleSelection}
        updateWorkspaceRectangleSelection={updateWorkspaceRectangleSelection}
        finishWorkspaceRectangleSelection={finishWorkspaceRectangleSelection}
        gridRowVirtualizer={gridRowVirtualizer}
        gridColumns={gridColumns}
        selectedFiles={selectedFiles}
        renamingPath={renamingPath}
        startWorkspaceFileDrag={startWorkspaceFileDrag}
        updateWorkspaceFileDrag={updateWorkspaceFileDrag}
        finishWorkspaceFileDrag={finishWorkspaceFileDrag}
        selectFile={selectFile}
        showFileContextMenu={showFileContextMenu}
        thumbnailPathOverrides={thumbnailPathOverrides}
        thumbnailVisibilityRevision={thumbnailVisibilityRevision}
        enqueueThumbnail={enqueueThumbnail}
        renameInputRef={renameInputRef}
        renameDraft={renameDraft}
        setRenameDraft={setRenameDraft}
        submitInlineRename={submitInlineRename}
        cancelInlineRename={cancelInlineRename}
        workspaceSelectionBox={workspaceSelectionBox}
        listScrollElement={listScrollElement}
        listGridStyle={listGridStyle}
        visibleListColumns={visibleListColumns}
        draggedListColumn={draggedListColumn}
        listColumnDropTarget={listColumnDropTarget}
        listColumnDropPosition={listColumnDropPosition}
        startListColumnReorder={startListColumnReorder}
        startListColumnResize={startListColumnResize}
        listRowVirtualizer={listRowVirtualizer}
        scrollWorkspaceToFocus={scrollWorkspaceToFocus}
        scrollWorkspaceToStart={scrollWorkspaceToStart}
        isExternalDropActive={isExternalDropActive}
      />

      {isPreviewOpen && (
        <PreviewPanel
          playerRef={previewPlayerRef}
          selectedPath={selectionAnchor ?? [...selectedFiles][0] ?? null}
          items={workspace?.items ?? []}
          thumbnailPathOverrides={thumbnailPathOverrides}
          autoplay={config.settings.autoplay && selectedFiles.size === 1 && !suppressPreviewAutoplay}
          volume={config.settings.volume}
          muted={config.settings.muted}
          metadataLoading={selectedMetadataLoading}
          onEnsureThumbnail={enqueueThumbnail}
            onAudioPreferenceChange={updateAudioPreferences}
            textLanguageMap={config.settings.textLanguageMap}
            codeTheme={config.settings.codeTheme}
            textPreviewLatinFont={config.settings.textPreviewLatinFont}
            textPreviewCjkFont={config.settings.textPreviewCjkFont}
        />
      )}
      </PanelGroup>
      </div>

      {activeFileTask && <FileTaskCard task={activeFileTask} onCancel={() => void cancelActiveFileTask()} />}
      {toast && <div className="toast" role="status">{toast}</div>}

      {confirmation && <ThemedConfirmDialog title={confirmation.title} message={confirmation.message} confirmLabel={confirmation.confirmLabel} onCancel={() => { confirmation.resolve(false); setConfirmation(null); }} onConfirm={() => { confirmation.resolve(true); setConfirmation(null); }} />}

      {workspaceContextMenu && (
        <ThemedContextMenu
          menu={workspaceContextMenu}
          onAction={(action) => void runWorkspaceContextMenuAction(action)}
          onClose={closeWorkspaceContextMenu}
        />
      )}

      {metadataLoading && <MetadataLoadingOverlay />}

      {isLogPanelOpen && (
        <LogDialog
          snapshot={logSnapshot}
          content={filteredFileLogs}
          error={logPanelError}
          loading={logLoading}
          minimumLevel={logMinimumLevel}
          onMinimumLevelChange={setLogMinimumLevel}
          onRefresh={() => void pollLogs(true)}
          onCopy={() => void copyLogs()}
          onClose={closeLogs}
        />
      )}

      {isSettingsOpen && (
        <SettingsDialog
          settings={config.settings}
          limits={settingsLimits}
          onApply={applySettings}
          onClose={() => setIsSettingsOpen(false)}
          onNotify={notify}
          onChooseBackground={chooseBackground}
          onImportBackground={importBackground}
          dataSummary={dataSummary}
          aboutInfo={aboutInfo}
          onClearThumbnails={() => clearThumbnails().catch((error: unknown) => notify(errorMessage(error)))}
          onClearOldLogs={() => clearOldLogs().catch((error: unknown) => notify(errorMessage(error)))}
          onOpenPath={(path) => openManagedPath(path).catch((error: unknown) => notify(errorMessage(error)))}
          onExportDiagnostics={() => exportDiagnostics().catch((error: unknown) => notify(errorMessage(error)))}
        />
      )}
    </main>
  );
}
