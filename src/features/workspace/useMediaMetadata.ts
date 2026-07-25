import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { isFileEntry, type MetadataBatchResult, type SortKey, type FileEntry, type VideoMetadata, type WorkspaceListing } from "../../app-types";
import { errorMessage, writeClientLog } from "../../app-utils";

export function useMediaMetadata({ workspace, setWorkspace, selectedFile, sortKey, concurrency, probedPaths, notify }: {
  workspace: WorkspaceListing | null;
  setWorkspace: Dispatch<SetStateAction<WorkspaceListing | null>>;
  selectedFile: FileEntry | null;
  sortKey: SortKey;
  concurrency: number;
  probedPaths: RefObject<Set<string>>;
  notify: (message: string) => void;
}) {
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [selectedMetadataLoading, setSelectedMetadataLoading] = useState(false);
  const batchRequest = useRef(0);
  const selectedRequest = useRef(0);

  const reset = useCallback(() => {
    batchRequest.current += 1;
    selectedRequest.current += 1;
    probedPaths.current.clear();
    setMetadataLoading(false);
    setSelectedMetadataLoading(false);
  }, [probedPaths]);

  const loadWorkspaceMetadata = useCallback(async () => {
    if (!workspace || metadataLoading) return;
    const paths = workspace.items.filter(isFileEntry).filter((file) => file.kind === "video" || file.kind === "audio").map((file) => file.path).filter((path) => !probedPaths.current.has(path));
    if (paths.length === 0) return;
    const requestId = ++batchRequest.current;
    const workspacePath = workspace.path;
    const metadataByPath = new Map<string, VideoMetadata>();
    setMetadataLoading(true);
    writeClientLog("info", `开始读取媒体信息：${paths.length} 个视频或音频文件`);
    try {
      const transportWindow = Math.max(1, concurrency);
      for (let start = 0; start < paths.length; start += transportWindow) {
        const batchPaths = paths.slice(start, start + transportWindow);
        writeClientLog("debug", `分发媒体信息批次：${batchPaths.length} 个，进度 ${Math.min(start + batchPaths.length, paths.length)}/${paths.length}`);
        const result = await invoke<MetadataBatchResult>("probe_video_metadata_batch_command", { paths: batchPaths });
        if (requestId !== batchRequest.current) { writeClientLog("debug", `媒体信息批次结果已过期，停止剩余探测：请求 ${requestId}`); return; }
        result.metadata.forEach((metadata) => { metadataByPath.set(metadata.path, metadata); probedPaths.current.add(metadata.path); });
        result.failedPaths.forEach((path) => probedPaths.current.add(path));
        writeClientLog(result.failedPaths.length > 0 ? "warn" : "debug", `媒体信息批次返回：成功 ${result.metadata.length} 个，失败 ${result.failedPaths.length} 个`);
      }
      if (requestId === batchRequest.current) {
        setWorkspace((current) => !current || current.path !== workspacePath ? current : ({ ...current, items: current.items.map((item) => {
          if (!isFileEntry(item)) return item;
          const metadata = metadataByPath.get(item.path);
          return metadata ? { ...item, duration: metadata.duration, width: metadata.width, height: metadata.height } : item;
        }) }));
        writeClientLog("info", `媒体信息读取完成：${paths.length} 个视频或音频文件`);
      }
    } catch (loadError) {
      if (requestId === batchRequest.current) { const message = errorMessage(loadError); notify(message); writeClientLog("warn", `媒体信息读取失败：${message}`); }
    } finally {
      if (requestId === batchRequest.current) setMetadataLoading(false);
    }
  }, [concurrency, metadataLoading, notify, probedPaths, setWorkspace, workspace]);

  useEffect(() => {
    if (workspace && (sortKey === "duration" || sortKey === "resolution")) void loadWorkspaceMetadata();
  }, [loadWorkspaceMetadata, sortKey, workspace]);

  useEffect(() => {
    const requestId = ++selectedRequest.current;
    const currentFile = selectedFile;
    const workspacePath = workspace?.path;
    const supportsMediaMetadata = currentFile?.kind === "video" || currentFile?.kind === "audio";
    const requiresProbe = supportsMediaMetadata && (currentFile.duration === null || currentFile.width === null || currentFile.height === null);
    if (!currentFile || !workspacePath || !requiresProbe || probedPaths.current.has(currentFile.path)) { setSelectedMetadataLoading(false); return; }
    setSelectedMetadataLoading(true);
    writeClientLog("debug", `补充读取右栏媒体信息：类别 ${currentFile.kind}，路径 ${currentFile.path}`);
    void invoke<MetadataBatchResult>("probe_video_metadata_batch_command", { paths: [currentFile.path] }).then((result) => {
      if (requestId !== selectedRequest.current) { writeClientLog("debug", `右栏媒体信息结果已过期，忽略：${currentFile.path}`); return; }
      probedPaths.current.add(currentFile.path);
      const metadata = result.metadata.find((item) => item.path === currentFile.path);
      if (!metadata) { writeClientLog("warn", `无法读取右栏媒体信息：${currentFile.path}`); return; }
      setWorkspace((current) => !current || current.path !== workspacePath ? current : ({ ...current, items: current.items.map((item) => isFileEntry(item) && item.path === currentFile.path ? { ...item, duration: metadata.duration ?? item.duration, width: metadata.width ?? item.width, height: metadata.height ?? item.height } : item) }));
      writeClientLog("debug", `右栏媒体信息读取完成：${currentFile.path}`);
    }).catch((probeError: unknown) => {
      if (requestId === selectedRequest.current) { probedPaths.current.add(currentFile.path); writeClientLog("warn", `右栏媒体信息读取失败：${currentFile.path}，${errorMessage(probeError)}`); }
    }).finally(() => { if (requestId === selectedRequest.current) setSelectedMetadataLoading(false); });
  }, [probedPaths, selectedFile, setWorkspace, workspace?.path]);

  return { metadataLoading, selectedMetadataLoading, reset };
}
