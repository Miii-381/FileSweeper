import { invoke } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, Dispatch, RefObject, SetStateAction } from "react";

import { GRID_CARD_WIDTH, GRID_ROW_HEIGHT, LIST_ROW_HEIGHT, type AppConfig, type SortKey, type ViewMode, type WorkspaceFocus, type WorkspaceListing, type WorkspaceSort } from "../../app-types";
import { errorMessage, writeClientLog } from "../../app-utils";

function materialStandardEasing(progress: number) {
  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const parameter = (lower + upper) / 2;
    const inverse = 1 - parameter;
    const x = 3 * inverse * inverse * parameter * 0.2 + 3 * inverse * parameter * parameter * 0;
    if (x < progress) lower = parameter;
    else upper = parameter;
  }
  const parameter = (lower + upper) / 2;
  const inverse = 1 - parameter;
  return 3 * inverse * parameter * parameter + parameter * parameter * parameter;
}

export function useWorkspaceViewState({ initialConfig, config, setConfig, workspace, selectedVideos, selectionAnchor, probedMetadataPaths, notify }: {
  initialConfig: AppConfig;
  config: AppConfig;
  setConfig: Dispatch<SetStateAction<AppConfig>>;
  workspace: WorkspaceListing | null;
  selectedVideos: Set<string>;
  selectionAnchor: string | null;
  probedMetadataPaths: RefObject<Set<string>>;
  notify: (message: string) => void;
}) {
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("createdAt");
  const [sortAscending, setSortAscending] = useState(false);
  const [gridColumns, setGridColumns] = useState(1);
  const [gridViewport, setGridViewport] = useState<HTMLDivElement | null>(null);
  const gridScrollElement = useRef<HTMLDivElement>(null);
  const listScrollElement = useRef<HTMLDivElement>(null);
  const focusRestorePath = useRef<string | null>(null);
  const focusRestorePending = useRef(false);
  const focusByPath = useRef<Record<string, WorkspaceFocus>>(initialConfig.workspaceFocus ?? {});
  const sortByPath = useRef<Record<string, WorkspaceSort>>(initialConfig.workspaceSort ?? {});
  const activeSort = useRef<WorkspaceSort>({ key: "createdAt", ascending: false });
  const persistence = useRef<Promise<void>>(Promise.resolve());
  const scrollAnimation = useRef<number | null>(null);

  const selectedVideo = useMemo(() =>
    workspace?.videos.find((video) => video.path === selectionAnchor) ??
    workspace?.videos.find((video) => selectedVideos.has(video.path)) ?? null,
  [selectedVideos, selectionAnchor, workspace]);

  const visibleListColumns = useMemo(() => config.settings.listColumns.filter((column) => column.visible), [config.settings.listColumns]);
  const listGridStyle = useMemo(() => ({
    "--list-columns": visibleListColumns.map((column) => column.id === "name" ? `minmax(180px, ${column.width}px)` : `${column.width}px`).join(" "),
  }) as CSSProperties, [visibleListColumns]);

  const visibleVideos = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    const videos = workspace?.videos.filter((video) => video.name.toLocaleLowerCase().includes(normalizedQuery)) ?? [];
    return videos.slice().sort((left, right) => {
      const comparison = sortKey === "name"
        ? left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" })
        : sortKey === "size" ? left.size - right.size
        : sortKey === "duration" ? (left.duration ?? -1) - (right.duration ?? -1)
        : sortKey === "resolution" ? (left.width ?? 0) * (left.height ?? 0) - (right.width ?? 0) * (right.height ?? 0)
        : (left.createdAt ?? 0) - (right.createdAt ?? 0);
      return sortAscending ? comparison : -comparison;
    });
  }, [searchQuery, sortAscending, sortKey, workspace]);

  useEffect(() => {
    if (!workspace) return;
    const timer = window.setTimeout(() => writeClientLog("debug", `工作区筛选已应用：工作区 ${workspace.path}，查询“${searchQuery.trim()}”，结果 ${visibleVideos.length}/${workspace.videos.length}`), 300);
    return () => window.clearTimeout(timer);
  }, [searchQuery, visibleVideos.length, workspace?.path, workspace?.videos.length]);

  const gridRowVirtualizer = useVirtualizer({ count: Math.ceil(visibleVideos.length / gridColumns), getScrollElement: () => gridScrollElement.current, estimateSize: () => GRID_ROW_HEIGHT, overscan: 2 });
  const listRowVirtualizer = useVirtualizer({ count: visibleVideos.length, getScrollElement: () => listScrollElement.current, estimateSize: () => LIST_ROW_HEIGHT, overscan: 8 });
  const setGridScrollRef = useCallback((element: HTMLDivElement | null) => { gridScrollElement.current = element; setGridViewport(element); }, []);

  const persistWorkspaceFocus = useCallback(async (workspacePath: string, videoPath: string) => {
    if (focusByPath.current[workspacePath]?.videoPath === videoPath) {
      writeClientLog("debug", `工作区焦点无需保存：工作区 ${workspacePath}，视频 ${videoPath}`);
      await persistence.current;
      return;
    }
    focusByPath.current = { ...focusByPath.current, [workspacePath]: { videoPath } };
    setConfig((current) => ({ ...current, workspaceFocus: { ...current.workspaceFocus, [workspacePath]: { videoPath } } }));
    writeClientLog("debug", `开始保存工作区焦点：工作区 ${workspacePath}，视频 ${videoPath}`);
    const pending = persistence.current.then(async () => {
      try {
        await invoke("set_workspace_focus", { workspacePath, videoPath });
        writeClientLog("debug", `工作区焦点已写入独立状态文件：工作区 ${workspacePath}，视频 ${videoPath}`);
      } catch (persistError) {
        writeClientLog("warn", `保存工作区视频焦点失败：工作区 ${workspacePath}，视频 ${videoPath}，${errorMessage(persistError)}`);
      }
    });
    persistence.current = pending;
    await pending;
  }, [setConfig]);

  const persistWorkspaceSort = useCallback(async (workspacePath: string, key: SortKey, ascending: boolean) => {
    const previous = sortByPath.current[workspacePath];
    if (previous?.key === key && previous.ascending === ascending) {
      await persistence.current;
      return;
    }
    const sort = { key, ascending };
    sortByPath.current = { ...sortByPath.current, [workspacePath]: sort };
    setConfig((current) => ({ ...current, workspaceSort: { ...current.workspaceSort, [workspacePath]: sort } }));
    writeClientLog("debug", `开始保存工作区排序：工作区 ${workspacePath}，字段 ${key}，升序 ${ascending}`);
    const pending = persistence.current.then(async () => {
      try {
        await invoke("set_workspace_sort", { workspacePath, sortKey: key, sortAscending: ascending });
        writeClientLog("debug", `工作区排序已写入独立状态文件：工作区 ${workspacePath}，字段 ${key}，升序 ${ascending}`);
      } catch (persistError) {
        writeClientLog("warn", `保存工作区排序失败：工作区 ${workspacePath}，${errorMessage(persistError)}`);
      }
    });
    persistence.current = pending;
    await pending;
  }, [setConfig]);

  useEffect(() => {
    if (!config.settings.rememberWorkspaceFocus || !workspace || !selectionAnchor || !selectedVideos.has(selectionAnchor)) return;
    if (focusByPath.current[workspace.path]?.videoPath === selectionAnchor) return;
    const workspacePath = workspace.path;
    const videoPath = selectionAnchor;
    writeClientLog("debug", `工作区焦点将在 350ms 后保存：工作区 ${workspacePath}，视频 ${videoPath}`);
    const timer = window.setTimeout(() => void persistWorkspaceFocus(workspacePath, videoPath), 350);
    return () => { window.clearTimeout(timer); writeClientLog("debug", `取消延迟保存工作区焦点：工作区 ${workspacePath}，视频 ${videoPath}`); };
  }, [config.settings.rememberWorkspaceFocus, persistWorkspaceFocus, selectedVideos, selectionAnchor, workspace]);

  useLayoutEffect(() => {
    if (viewMode !== "grid" || !gridViewport) return;
    const updateColumnCount = (width = gridViewport.clientWidth) => setGridColumns(Math.max(1, Math.floor((Math.max(0, width - 32) + 12) / (GRID_CARD_WIDTH + 12))));
    const observer = new ResizeObserver(([entry]) => updateColumnCount(entry.contentRect.width));
    observer.observe(gridViewport);
    const frame = window.requestAnimationFrame(() => updateColumnCount());
    return () => { window.cancelAnimationFrame(frame); observer.disconnect(); };
  }, [gridViewport, viewMode]);

  useEffect(() => {
    if (!focusRestorePending.current || !workspace) return;
    if (viewMode === "grid" && !gridViewport) { writeClientLog("debug", `等待网格视口挂载后恢复工作区焦点：${workspace.path}`); return; }
    if (viewMode === "grid" && gridViewport) {
      const measuredColumns = Math.max(1, Math.floor((Math.max(0, gridViewport.clientWidth - 32) + 12) / (GRID_CARD_WIDTH + 12)));
      if (gridColumns !== measuredColumns) { writeClientLog("debug", `等待网格列数稳定后恢复工作区焦点：当前 ${gridColumns} 列，测得 ${measuredColumns} 列，工作区 ${workspace.path}`); return; }
    }
    if ((sortKey === "duration" || sortKey === "resolution") && workspace.videos.some((video) => (video.duration === null || video.width === null || video.height === null) && !probedMetadataPaths.current.has(video.path))) {
      writeClientLog("debug", `等待媒体信息完成后恢复工作区焦点：${workspace.path}`);
      return;
    }
    const focusPath = focusRestorePath.current;
    const videoIndex = focusPath ? visibleVideos.findIndex((video) => video.path === focusPath) : -1;
    if (focusPath && videoIndex < 0) writeClientLog("warn", `无法恢复工作区焦点：视频不在当前可见列表中，工作区 ${workspace.path}，视频 ${focusPath}，可见视频 ${visibleVideos.length} 个`);
    else if (focusPath) writeClientLog("debug", `准备恢复工作区焦点：工作区 ${workspace.path}，视频 ${focusPath}，列表索引 ${videoIndex}，视图 ${viewMode}`);
    const frame = window.requestAnimationFrame(() => {
      if (viewMode === "grid") {
        if (!gridScrollElement.current) { writeClientLog("warn", `无法初始化工作区滚动位置：网格滚动容器尚未挂载，工作区 ${workspace.path}`); return; }
        if (videoIndex >= 0 && focusPath) gridRowVirtualizer.scrollToIndex(Math.floor(videoIndex / gridColumns), { align: "start" });
        else gridRowVirtualizer.scrollToOffset(0);
      } else {
        if (!listScrollElement.current) { writeClientLog("warn", `无法初始化工作区滚动位置：列表滚动容器尚未挂载，工作区 ${workspace.path}`); return; }
        if (videoIndex >= 0 && focusPath) listRowVirtualizer.scrollToIndex(videoIndex, { align: "start" });
        else listRowVirtualizer.scrollToOffset(0);
      }
      focusRestorePending.current = false;
      focusRestorePath.current = null;
      if (focusPath && videoIndex >= 0) writeClientLog("debug", `已恢复工作区视频焦点：${focusPath}`);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [gridColumns, gridRowVirtualizer, gridViewport, listRowVirtualizer, probedMetadataPaths, sortKey, viewMode, visibleVideos, workspace]);

  const animateScroll = useCallback((element: HTMLDivElement | null, targetOffset: number) => {
    if (!element) return;
    if (scrollAnimation.current !== null) window.cancelAnimationFrame(scrollAnimation.current);
    const startOffset = element.scrollTop;
    const distance = targetOffset - startOffset;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || Math.abs(distance) < 1) { element.scrollTop = targetOffset; return; }
    const duration = Math.min(1500, Math.max(500, 420 + Math.abs(distance) * 0.2));
    const startedAt = performance.now();
    const update = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      element.scrollTop = startOffset + distance * materialStandardEasing(progress);
      if (progress < 1) scrollAnimation.current = window.requestAnimationFrame(update);
      else scrollAnimation.current = null;
    };
    scrollAnimation.current = window.requestAnimationFrame(update);
  }, []);

  const scrollWorkspaceToStart = useCallback(() => animateScroll(viewMode === "grid" ? gridScrollElement.current : listScrollElement.current, 0), [animateScroll, viewMode]);
  const scrollWorkspaceToFocus = useCallback(() => {
    const focusPath = selectedVideo?.path ?? (workspace ? config.workspaceFocus[workspace.path]?.videoPath : null);
    const videoIndex = focusPath ? visibleVideos.findIndex((video) => video.path === focusPath) : -1;
    if (videoIndex < 0) { notify("当前筛选结果中没有可定位的焦点视频"); return; }
    if (viewMode === "grid") {
      const viewportHeight = gridScrollElement.current?.clientHeight ?? 0;
      animateScroll(gridScrollElement.current, Math.max(0, Math.floor(videoIndex / gridColumns) * GRID_ROW_HEIGHT - (viewportHeight - GRID_ROW_HEIGHT) / 2));
    } else {
      const viewportHeight = listScrollElement.current?.clientHeight ?? 0;
      animateScroll(listScrollElement.current, Math.max(0, videoIndex * LIST_ROW_HEIGHT - (viewportHeight - LIST_ROW_HEIGHT) / 2));
    }
  }, [animateScroll, config.workspaceFocus, gridColumns, notify, selectedVideo, viewMode, visibleVideos, workspace]);

  useEffect(() => () => { if (scrollAnimation.current !== null) window.cancelAnimationFrame(scrollAnimation.current); }, []);

  const prepareWorkspace = useCallback((listing: WorkspaceListing, enabled: boolean) => {
    const rememberedSort = enabled ? sortByPath.current[listing.path] : undefined;
    if (enabled) {
      const restoredSort = rememberedSort ?? { key: "createdAt" as const, ascending: false };
      activeSort.current = restoredSort;
      setSortKey(restoredSort.key);
      setSortAscending(restoredSort.ascending);
    }
    if (rememberedSort) writeClientLog("debug", `工作区排序命中：工作区 ${listing.path}，字段 ${rememberedSort.key}，升序 ${rememberedSort.ascending}`);
    else if (enabled) writeClientLog("debug", `工作区没有已保存排序，使用创建日期降序：${listing.path}`);
    const rememberedPath = enabled ? focusByPath.current[listing.path]?.videoPath : undefined;
    const rememberedVideo = rememberedPath ? listing.videos.find((video) => video.path === rememberedPath) ?? null : null;
    focusRestorePath.current = rememberedVideo?.path ?? null;
    focusRestorePending.current = true;
    setSearchQuery("");
    if (rememberedVideo) writeClientLog("debug", `工作区焦点命中：工作区 ${listing.path}，视频 ${rememberedVideo.path}，共 ${listing.videos.length} 个视频`);
    else if (rememberedPath) writeClientLog("warn", `工作区焦点未命中：工作区 ${listing.path}，已记录 ${rememberedPath}，当前视频 ${listing.videos.length} 个`);
    else if (enabled) writeClientLog("debug", `工作区没有已保存焦点：${listing.path}`);
    else writeClientLog("debug", `工作区排序与焦点记忆已关闭，滚动位置将从顶部开始：${listing.path}`);
    return rememberedVideo;
  }, []);

  const changeSortKey = useCallback((next: SortKey) => {
    writeClientLog("info", `切换工作区排序字段：${sortKey} -> ${next}`);
    activeSort.current = { key: next, ascending: sortAscending };
    setSortKey(next);
    if (workspace && config.settings.rememberWorkspaceFocus) void persistWorkspaceSort(workspace.path, next, sortAscending);
  }, [config.settings.rememberWorkspaceFocus, persistWorkspaceSort, sortAscending, sortKey, workspace]);
  const toggleSortDirection = useCallback(() => {
    const next = !sortAscending;
    writeClientLog("info", `切换工作区排序方向：${sortAscending ? "升序" : "降序"} -> ${next ? "升序" : "降序"}`);
    activeSort.current = { key: sortKey, ascending: next };
    setSortAscending(next);
    if (workspace && config.settings.rememberWorkspaceFocus) void persistWorkspaceSort(workspace.path, sortKey, next);
  }, [config.settings.rememberWorkspaceFocus, persistWorkspaceSort, sortAscending, sortKey, workspace]);
  const changeViewMode = useCallback((mode: ViewMode) => { writeClientLog("info", `切换工作区视图：${viewMode} -> ${mode}`); setViewMode(mode); }, [viewMode]);

  return {
    viewMode, searchQuery, setSearchQuery, sortKey, sortAscending, gridColumns, selectedVideo,
    visibleVideos, visibleListColumns, listGridStyle, gridRowVirtualizer, listRowVirtualizer,
    setGridScrollRef, listScrollElement, scrollWorkspaceToStart, scrollWorkspaceToFocus,
    persistWorkspaceFocus, persistWorkspaceSort, prepareWorkspace, changeSortKey,
    toggleSortDirection, changeViewMode,
    getActiveSort: () => activeSort.current,
    memorySummary: () => ({ focus: Object.keys(focusByPath.current).length, sort: Object.keys(sortByPath.current).length }),
  };
}
