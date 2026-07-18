import { invoke } from "@tauri-apps/api/core";
import { useRef, type Dispatch, type SetStateAction } from "react";
import type { AppConfig, SortKey, VideoEntry, WorkspaceListing } from "../../app-types";
import { errorMessage, writeClientLog } from "../../app-utils";

type Props = {
  config: AppConfig;
  setConfig: Dispatch<SetStateAction<AppConfig>>;
  workspace: WorkspaceListing | null;
  setWorkspace: Dispatch<SetStateAction<WorkspaceListing | null>>;
  selectedVideos: Set<string>;
  setSelectedVideos: Dispatch<SetStateAction<Set<string>>>;
  selectionAnchor: string | null;
  setSelectionAnchor: Dispatch<SetStateAction<string | null>>;
  setSelectedPath: Dispatch<SetStateAction<string | null>>;
  setWorkspaceLoading: Dispatch<SetStateAction<boolean>>;
  setSuppressPreviewAutoplay: Dispatch<SetStateAction<boolean>>;
  resetMetadata: () => void;
  clearThumbnailDisplayOverrides: () => void;
  prepareWorkspaceView: (listing: WorkspaceListing, memoryEnabled: boolean) => VideoEntry | null;
  persistWorkspaceFocus: (workspacePath: string, videoPath: string) => Promise<void>;
  persistWorkspaceSort: (workspacePath: string, key: SortKey, ascending: boolean) => Promise<void>;
  getActiveSort: () => { key: SortKey; ascending: boolean };
  notify: (message: string) => void;
};

export function useWorkspaceController({
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
}: Props) {
  const workspaceRequest = useRef(0);
  const workspaceNavigationPending = useRef(false);
  const workspaceScanRequest = useRef(0);

  const activateWorkspace = async (
    requestedPath: string,
    persist = true,
    workspaceMemoryEnabled = config.settings.rememberWorkspaceFocus,
  ) => {
    const requestId = ++workspaceRequest.current;
    workspaceNavigationPending.current = true;
    resetMetadata();
    try {
      if (workspaceMemoryEnabled && workspace) {
        if (selectionAnchor && selectedVideos.has(selectionAnchor)) {
          writeClientLog("debug", `切换工作区前保存当前焦点：工作区 ${workspace.path}，视频 ${selectionAnchor}`);
          await persistWorkspaceFocus(workspace.path, selectionAnchor);
        }
        const activeSort = getActiveSort();
        await persistWorkspaceSort(workspace.path, activeSort.key, activeSort.ascending);
      }
    } catch (error) {
      if (requestId === workspaceRequest.current) {
        workspaceNavigationPending.current = false;
        const message = errorMessage(error);
        notify(message);
        writeClientLog("error", `切换工作区前保存状态失败：${message}`);
      } else {
        writeClientLog("debug", `旧工作区状态保存失败响应已过期，忽略：${errorMessage(error)}`);
      }
      return;
    }
    if (requestId !== workspaceRequest.current) {
      writeClientLog("debug", `工作区切换响应已过期，忽略：${requestedPath}`);
      return;
    }

    const scanRequestId = ++workspaceScanRequest.current;
    setWorkspaceLoading(true);
    writeClientLog("info", `打开工作区：${requestedPath}`);
    try {
      const listing = await invoke<WorkspaceListing>("scan_workspace", {
        path: requestedPath,
        requestId: scanRequestId,
      });
      if (requestId !== workspaceRequest.current || scanRequestId !== workspaceScanRequest.current) {
        writeClientLog("debug", `工作区扫描响应已过期，忽略：${requestedPath}`);
        return;
      }
      clearThumbnailDisplayOverrides();
      const rememberedVideo = prepareWorkspaceView(listing, workspaceMemoryEnabled);
      setSuppressPreviewAutoplay(Boolean(rememberedVideo));
      setWorkspace(listing);
      setSelectedPath(listing.path);
      setSelectedVideos(rememberedVideo ? new Set([rememberedVideo.path]) : new Set());
      setSelectionAnchor(rememberedVideo?.path ?? null);
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
        setWorkspace({ path: requestedPath, videos: [], mediaSuppressed: false, isAvailable: false });
        setSelectedPath(requestedPath);
        setSelectedVideos(new Set());
        setSelectionAnchor(null);
        notify(message);
        writeClientLog("warn", `工作区暂不可用，已保留位置等待恢复：${requestedPath}，${message}`);
      } else {
        writeClientLog("debug", `工作区扫描失败响应已过期，忽略：${requestedPath}，${errorMessage(error)}`);
      }
    } finally {
      if (requestId === workspaceRequest.current) {
        setWorkspaceLoading(false);
        workspaceNavigationPending.current = false;
      }
    }
  };

  const markWorkspaceUnavailable = (path: string, reason: string) => {
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
    if (workspaceNavigationPending.current) {
      writeClientLog("debug", `工作区切换期间忽略旧目录刷新：${path}，${reason}`);
      return;
    }
    const scanRequestId = ++workspaceScanRequest.current;
    try {
      const listing = await invoke<WorkspaceListing>("scan_workspace", { path, requestId: scanRequestId });
      if (scanRequestId !== workspaceScanRequest.current) {
        writeClientLog("debug", `工作区刷新响应已过期，忽略：${path}，${reason}`);
        return;
      }
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
              ? { ...video, duration: previous.duration, width: previous.width, height: previous.height }
              : video;
          }),
        };
      });
      const nextPaths = new Set(listing.videos.map((video) => video.path));
      setSelectedVideos((current) => new Set([...current].filter((path) => nextPaths.has(path))));
      setSelectionAnchor((current) => (current && nextPaths.has(current) ? current : null));
      writeClientLog("debug", `工作区已刷新：${reason}，视频 ${listing.videos.length} 个`);
    } catch (error) {
      if (scanRequestId !== workspaceScanRequest.current) {
        writeClientLog("debug", `工作区刷新失败响应已过期，忽略：${path}，${reason}，${errorMessage(error)}`);
        return;
      }
      markWorkspaceUnavailable(path, errorMessage(error));
    }
  };

  return { activateWorkspace, refreshWorkspace, markWorkspaceUnavailable };
}
