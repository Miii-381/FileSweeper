import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { colorModeTokens, themePresets } from "./theme";
import type { PreviewPlayerHandle } from "./components/PreviewPlayer";
import { ThemedContextMenu } from "./components/ThemedContextMenu";
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
  type ColorMode,
  type DirectoryEntry,
  type DirectoryChildren,
  type SettingsLimits,
  type TreeState,
  type WorkspaceListing,
} from "./app-types";
import {
  errorMessage,
  writeClientLog,
} from "./app-utils";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";




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
    return <main className="app-loading-shell" aria-busy="true">正在加载 VideoSweeper…</main>;
  }
  return <VideoSweeperApp initialState={initialState} />;
}

function VideoSweeperApp({ initialState }: { initialState: ApplicationState }) {
  const [config, setConfig] = useState<AppConfig>(initialState.config);
  const [roots] = useState<DirectoryEntry[]>(initialState.roots);
  const settingsLimits: SettingsLimits = initialState.settingsLimits;
  const [treeState, setTreeState] = useState<TreeState>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [workspace, setWorkspace] = useState<WorkspaceListing | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedVideos, setSelectedVideos] = useState<Set<string>>(new Set());
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(true);
  const [systemColorMode, setSystemColorMode] = useState<ColorMode>("dark");
  const { toast, notify } = useToast();
  const [suppressPreviewAutoplay, setSuppressPreviewAutoplay] = useState(false);
  const [workspaceMinSize, setWorkspaceMinSize] = useState(34);
  const probedMetadataPaths = useRef<Set<string>>(new Set());
  const renameInputRef = useRef<HTMLInputElement>(null);
  const previewPlayerRef = useRef<PreviewPlayerHandle>(null);
  const panelGroupRef = useRef<HTMLDivElement>(null);

  const effectiveColorMode: ColorMode =
    config.settings.appearance === "system" ? systemColorMode : config.settings.appearance;
  const activeTheme = themePresets.find((theme) => theme.id === config.settings.accentTheme) ?? themePresets[0];
  const {
    viewMode,
    searchQuery,
    setSearchQuery,
    sortKey,
    sortAscending,
    gridColumns,
    selectedVideo,
    visibleVideos,
    visibleListColumns,
    listGridStyle,
    gridRowVirtualizer,
    listRowVirtualizer,
    setGridScrollRef,
    listScrollElement,
    scrollWorkspaceToStart,
    scrollWorkspaceToFocus,
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
    selectedVideos,
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
    videos: workspace?.videos ?? [],
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
  } as CSSProperties;


  const updateAudioPreferences = useAudioPreferences(setConfig);

  const {
    metadataLoading,
    selectedMetadataLoading,
    reset: resetMetadata,
  } = useMediaMetadata({
    workspace,
    setWorkspace,
    selectedVideo,
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

  const { activateWorkspace, refreshWorkspace, markWorkspaceUnavailable } = useWorkspaceController({
    config,
    setConfig,
    workspace,
    setWorkspace,
    selectedVideos,
    setSelectedVideos,
    selectionAnchor,
    setSelectionAnchor,
    setSelectedPath,
    setWorkspaceLoading,
    setSuppressPreviewAutoplay,
    resetMetadata,
    clearThumbnailDisplayOverrides,
    prepareWorkspaceView,
    persistWorkspaceFocus,
    persistWorkspaceSort,
    getActiveSort,
    notify,
  });


  const {
    renamingPath,
    renameDraft,
    setRenameDraft,
    activeFileTask,
    recycleVideos,
    recycleSelectedVideos,
    startInlineRename,
    cancelInlineRename,
    submitInlineRename,
    copyDroppedVideos,
    copyVideosToDirectory,
    writeSelectionToFileClipboard,
    pasteFileClipboard,
    cancelActiveFileTask,
  } = useFileTasks({
    workspace,
    setWorkspace,
    selectedVideos,
    setSelectedVideos,
    setSelectionAnchor,
    selectedVideo,
    previewPlayerRef,
    refreshWorkspace,
    notify,
  });

  const {
    selectionBox: workspaceSelectionBox,
    selectVideo,
    clearSelection: clearWorkspaceSelection,
    clearSelectionFromBackground,
    startRectangleSelection: startWorkspaceRectangleSelection,
    updateRectangleSelection: updateWorkspaceRectangleSelection,
    finishRectangleSelection: finishWorkspaceRectangleSelection,
    startFileDrag: startVideoFileDrag,
    updateFileDrag: updateVideoFileDrag,
    finishFileDrag: finishVideoFileDrag,
  } = useWorkspaceGestures({
    hasWorkspace: Boolean(workspace),
    videos: visibleVideos,
    selectedVideos,
    setSelectedVideos,
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
    activateWorkspace,
    copyVideosToDirectory,
    pasteFileClipboard,
    recycleVideos,
    notify,
  });

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
    activateWorkspace,
    resetThumbnails: resetThumbnailsForCapturePosition,
    notify,
  });

  const isExternalDropActive = useWorkspaceMonitoring({
    workspace,
    refreshWorkspace,
    markUnavailable: markWorkspaceUnavailable,
    copyDroppedVideos,
  });

  useWorkspaceKeyboard({
    disabled: metadataLoading || isSettingsOpen,
    workspaceAvailable: Boolean(workspace?.isAvailable),
    videos: visibleVideos,
    selectedVideos,
    setSelectedVideos,
    selectionAnchor,
    setSelectionAnchor,
    setSuppressPreviewAutoplay,
    writeClipboard: writeSelectionToFileClipboard,
    pasteClipboard: pasteFileClipboard,
    recycleSelected: recycleSelectedVideos,
    startRename: startInlineRename,
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
      // Preserve enough room for one fixed card and the grid's horizontal padding.
      setWorkspaceMinSize(Math.min(100, (252 / Math.max(group.clientWidth, 1)) * 100));
    };
    const observer = new ResizeObserver(syncWorkspaceMinimum);
    observer.observe(group);
    syncWorkspaceMinimum();
    return () => observer.disconnect();
  }, []);



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
        await activateWorkspace(
          initialState.config.lastWorkspace,
          false,
          initialState.config.settings.rememberWorkspaceFocus,
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


  const showVideoContextMenu = (event: ReactMouseEvent<HTMLElement>, path: string) => {
    const operationPaths = selectedVideos.has(path) ? [...selectedVideos] : [path];
    setSelectedVideos(new Set(operationPaths));
    setSelectionAnchor(path);
    showWorkspaceContextMenu(event, operationPaths);
  };

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
        onChooseWorkspace={() => void chooseFolder("workspace")}
        onToggleFavorite={() => void toggleFavorite()}
        onOpenSettings={openSettings}
        onOpenLogs={openLogs}
      />

      <div className="application-panels" ref={panelGroupRef}>
      <PanelGroup
        className="panel-group"
        autoSaveId={isPreviewOpen ? "video-sweeper-three-panels" : "video-sweeper-two-panels"}
        direction="horizontal"
      >
      <Panel defaultSize={20} minSize={0}>
      <NavigationPanel
        config={config}
        roots={roots}
        selectedPath={selectedPath}
        expandedPaths={expandedPaths}
        treeState={treeState}
        onChooseFavorite={() => void chooseFolder("favorite")}
        onSelectPath={(path) => void activateWorkspace(path)}
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
        setSearchQuery={setSearchQuery}
        sortKey={sortKey}
        sortAscending={sortAscending}
        viewMode={viewMode}
        metadataLoading={metadataLoading}
        changeWorkspaceSortKey={changeWorkspaceSortKey}
        toggleWorkspaceSortDirection={toggleWorkspaceSortDirection}
        changeWorkspaceViewMode={changeWorkspaceViewMode}
        togglePreviewPanel={togglePreviewPanel}
        chooseWorkspaceFolder={() => void chooseFolder("workspace")}
        visibleVideos={visibleVideos}
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
        selectedVideos={selectedVideos}
        renamingPath={renamingPath}
        startVideoFileDrag={startVideoFileDrag}
        updateVideoFileDrag={updateVideoFileDrag}
        finishVideoFileDrag={finishVideoFileDrag}
        selectVideo={selectVideo}
        showVideoContextMenu={showVideoContextMenu}
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
          video={selectedVideo}
          thumbnailPath={selectedVideo ? thumbnailPathOverrides.get(selectedVideo.path) ?? selectedVideo.thumbnailPath : null}
          autoplay={config.settings.autoplay && selectedVideos.size === 1 && !suppressPreviewAutoplay}
          volume={config.settings.volume}
          muted={config.settings.muted}
          metadataLoading={selectedMetadataLoading}
          onEnsureThumbnail={enqueueThumbnail}
          onAudioPreferenceChange={updateAudioPreferences}
        />
      )}
      </PanelGroup>
      </div>

      {activeFileTask && <FileTaskCard task={activeFileTask} onCancel={() => void cancelActiveFileTask()} />}
      {toast && <div className="toast" role="status">{toast}</div>}

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
        />
      )}
    </main>
  );
}
