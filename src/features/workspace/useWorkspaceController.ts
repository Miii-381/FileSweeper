import { invoke } from "@tauri-apps/api/core";
import { useRef, type Dispatch, type SetStateAction } from "react";
import { isFileEntry, type AppConfig, type SortKey, type DirectoryItem, type WorkspaceListing } from "../../app-types";
import { errorMessage, writeClientLog } from "../../app-utils";

type Props = {
  config: AppConfig;
  setConfig: Dispatch<SetStateAction<AppConfig>>;
  workspace: WorkspaceListing | null;
  setWorkspace: Dispatch<SetStateAction<WorkspaceListing | null>>;
  selectedFiles: Set<string>;
  setSelectedFiles: Dispatch<SetStateAction<Set<string>>>;
  selectionAnchor: string | null;
  setSelectionAnchor: Dispatch<SetStateAction<string | null>>;
  setSelectedPath: Dispatch<SetStateAction<string | null>>;
  setWorkspaceLoading: Dispatch<SetStateAction<boolean>>;
  setSuppressPreviewAutoplay: Dispatch<SetStateAction<boolean>>;
  resetMetadata: () => void;
  clearThumbnailDisplayOverrides: () => void;
  prepareWorkspaceView: (listing: WorkspaceListing, memoryEnabled: boolean) => DirectoryItem | null;
  persistWorkspaceFocus: (workspacePath: string, filePath: string) => Promise<void>;
  persistWorkspaceSort: (workspacePath: string, key: SortKey, ascending: boolean) => Promise<void>;
  getActiveSort: () => { key: SortKey; ascending: boolean };
  notify: (message: string) => void;
};

export function useWorkspaceController({
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
  persistWorkspaceFocus,
  persistWorkspaceSort,
  getActiveSort,
  notify,
}: Props) {
  const workspaceRequest = useRef(0);
  const workspaceNavigationPending = useRef(false);
  const workspaceScanRequest = useRef(0);
  const currentWorkspacePath = useRef<string | null>(workspace?.path ?? null);
  currentWorkspacePath.current = workspace?.path ?? null;

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
        if (selectionAnchor && selectedFiles.has(selectionAnchor)) {
          writeClientLog("debug", `切换工作区前保存当前焦点：工作区 ${workspace.path}，文件 ${selectionAnchor}`);
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
      return false;
    }
    if (requestId !== workspaceRequest.current) {
      writeClientLog("debug", `工作区切换响应已过期，忽略：${requestedPath}`);
      return false;
    }

    const scanRequestId = ++workspaceScanRequest.current;
    setWorkspaceLoading(true);
    writeClientLog("info", `打开工作区：${requestedPath}`);
    try {
      const listing = await invoke<WorkspaceListing>("list_directory", {
        path: requestedPath,
        requestId: scanRequestId,
      });
      if (requestId !== workspaceRequest.current || scanRequestId !== workspaceScanRequest.current) {
        writeClientLog("debug", `工作区扫描响应已过期，忽略：${requestedPath}`);
        return false;
      }
      clearThumbnailDisplayOverrides();
      const rememberedFile = prepareWorkspaceView(listing, workspaceMemoryEnabled);
      setSuppressPreviewAutoplay(Boolean(rememberedFile));
      setWorkspace(listing);
      setSelectedPath(listing.path);
      setSelectedFiles(rememberedFile ? new Set([rememberedFile.path]) : new Set());
      setSelectionAnchor(rememberedFile?.path ?? null);
      writeClientLog("info", `目录读取完成：${listing.path}，项目 ${listing.items.length} 个`);
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
      return true;
    } catch (error) {
      if (requestId === workspaceRequest.current && scanRequestId === workspaceScanRequest.current) {
        const message = errorMessage(error);
        setWorkspace({ path: requestedPath, items: [], mediaSuppressed: false, isAvailable: false });
        setSelectedPath(requestedPath);
        setSelectedFiles(new Set());
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
    return false;
  };

  const markWorkspaceUnavailable = (path: string, reason: string) => {
    if (currentWorkspacePath.current?.toLocaleLowerCase() !== path.toLocaleLowerCase()) {
      writeClientLog("debug", `忽略非当前工作区的断连结果：当前 ${currentWorkspacePath.current ?? "无"}，结果 ${path}`);
      return;
    }
    setWorkspace((current) =>
      current && current.path.toLocaleLowerCase() === path.toLocaleLowerCase()
        ? { ...current, items: [], mediaSuppressed: false, isAvailable: false }
        : current,
    );
    setSelectedFiles(new Set());
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
      const listing = await invoke<WorkspaceListing>("list_directory", { path, requestId: scanRequestId });
      if (scanRequestId !== workspaceScanRequest.current) {
        writeClientLog("debug", `工作区刷新响应已过期，忽略：${path}，${reason}`);
        return;
      }
      if (currentWorkspacePath.current?.toLocaleLowerCase() !== path.toLocaleLowerCase()) {
        writeClientLog("debug", `工作区刷新目标已不是当前工作区，忽略列表和选择更新：当前 ${currentWorkspacePath.current ?? "无"}，结果 ${path}，${reason}`);
        return;
      }
      setWorkspace((current) => {
        if (!current || current.path.toLocaleLowerCase() !== path.toLocaleLowerCase()) {
          return current;
        }
        const previousByPath = new Map(current.items.filter(isFileEntry).map((file) => [file.path, file]));
        return {
          ...listing,
          items: listing.items.map((item) => {
            if (!isFileEntry(item)) return item;
            const previous = previousByPath.get(item.path);
            return previous
              ? { ...item, duration: previous.duration, width: previous.width, height: previous.height }
              : item;
          }),
        };
      });
      const nextPaths = new Set(listing.items.map((item) => item.path));
      setSelectedFiles((current) => new Set([...current].filter((path) => nextPaths.has(path))));
      setSelectionAnchor((current) => (current && nextPaths.has(current) ? current : null));
      writeClientLog("debug", `目录已刷新：${reason}，项目 ${listing.items.length} 个`);
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
