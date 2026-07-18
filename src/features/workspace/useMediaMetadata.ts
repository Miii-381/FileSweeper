import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { MetadataBatchResult, SortKey, VideoEntry, VideoMetadata, WorkspaceListing } from "../../app-types";
import { errorMessage, writeClientLog } from "../../app-utils";

export function useMediaMetadata({ workspace, setWorkspace, selectedVideo, sortKey, concurrency, probedPaths, notify }: {
  workspace: WorkspaceListing | null;
  setWorkspace: Dispatch<SetStateAction<WorkspaceListing | null>>;
  selectedVideo: VideoEntry | null;
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
    const paths = workspace.videos.map((video) => video.path).filter((path) => !probedPaths.current.has(path));
    if (paths.length === 0) return;
    const requestId = ++batchRequest.current;
    const workspacePath = workspace.path;
    const metadataByPath = new Map<string, VideoMetadata>();
    setMetadataLoading(true);
    writeClientLog("info", `开始读取媒体信息：${paths.length} 个视频`);
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
        setWorkspace((current) => !current || current.path !== workspacePath ? current : ({ ...current, videos: current.videos.map((video) => {
          const metadata = metadataByPath.get(video.path);
          return metadata ? { ...video, duration: metadata.duration, width: metadata.width, height: metadata.height } : video;
        }) }));
        writeClientLog("info", `媒体信息读取完成：${paths.length} 个视频`);
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
    const currentVideo = selectedVideo;
    const workspacePath = workspace?.path;
    const requiresProbe = currentVideo && (currentVideo.duration === null || currentVideo.width === null || currentVideo.height === null);
    if (!currentVideo || !workspacePath || !requiresProbe || probedPaths.current.has(currentVideo.path)) { setSelectedMetadataLoading(false); return; }
    setSelectedMetadataLoading(true);
    writeClientLog("debug", `补充读取右栏媒体信息：${currentVideo.path}`);
    void invoke<MetadataBatchResult>("probe_video_metadata_batch_command", { paths: [currentVideo.path] }).then((result) => {
      if (requestId !== selectedRequest.current) { writeClientLog("debug", `右栏媒体信息结果已过期，忽略：${currentVideo.path}`); return; }
      probedPaths.current.add(currentVideo.path);
      const metadata = result.metadata.find((item) => item.path === currentVideo.path);
      if (!metadata) { writeClientLog("warn", `无法读取右栏媒体信息：${currentVideo.path}`); return; }
      setWorkspace((current) => !current || current.path !== workspacePath ? current : ({ ...current, videos: current.videos.map((video) => video.path === currentVideo.path ? { ...video, duration: metadata.duration ?? video.duration, width: metadata.width ?? video.width, height: metadata.height ?? video.height } : video) }));
      writeClientLog("debug", `右栏媒体信息读取完成：${currentVideo.path}`);
    }).catch((probeError: unknown) => {
      if (requestId === selectedRequest.current) { probedPaths.current.add(currentVideo.path); writeClientLog("warn", `右栏媒体信息读取失败：${currentVideo.path}，${errorMessage(probeError)}`); }
    }).finally(() => { if (requestId === selectedRequest.current) setSelectedMetadataLoading(false); });
  }, [probedPaths, selectedVideo, setWorkspace, workspace?.path]);

  return { metadataLoading, selectedMetadataLoading, reset };
}
