import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef, useState } from "react";

import type { WorkspaceListing } from "../../app-types";
import { errorMessage, writeClientLog } from "../../app-utils";

export function useWorkspaceMonitoring({ workspace, refreshWorkspace, markUnavailable, copyDroppedVideos }: {
  workspace: WorkspaceListing | null;
  refreshWorkspace: (path: string, reason?: string) => Promise<void>;
  markUnavailable: (path: string, reason: string) => void;
  copyDroppedVideos: (paths: string[], workspacePath: string) => Promise<void>;
}) {
  const [isExternalDropActive, setIsExternalDropActive] = useState(false);
  const refreshRef = useRef(refreshWorkspace);
  const markUnavailableRef = useRef(markUnavailable);
  const copyDroppedRef = useRef(copyDroppedVideos);
  refreshRef.current = refreshWorkspace;
  markUnavailableRef.current = markUnavailable;
  copyDroppedRef.current = copyDroppedVideos;

  useEffect(() => {
    if (!workspace?.isAvailable) return;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") setIsExternalDropActive(true);
      else if (event.payload.type === "leave") setIsExternalDropActive(false);
      else if (event.payload.type === "drop") {
        setIsExternalDropActive(false);
        writeClientLog("info", `接收拖入文件：${event.payload.paths.length} 个`);
        void copyDroppedRef.current(event.payload.paths, workspace.path);
      }
    }).then((cleanup) => { unlisten = cleanup; }).catch((monitorError: unknown) => {
      writeClientLog("warn", `原生拖入监听不可用：${errorMessage(monitorError)}`);
    });
    return () => { setIsExternalDropActive(false); unlisten?.(); };
  }, [workspace?.isAvailable, workspace?.path]);

  useEffect(() => {
    if (!workspace?.isAvailable) return;
    let unlisten: (() => void) | undefined;
    let refreshTimer: number | undefined;
    let active = true;
    void listen<string>("workspace-file-event", (event) => {
      if (event.payload.toLocaleLowerCase() !== workspace.path.toLocaleLowerCase()) {
        writeClientLog("debug", `忽略其他工作区的文件事件：当前 ${workspace.path}，事件 ${event.payload}`);
        return;
      }
      writeClientLog("debug", `接收工作区文件事件，准备 300ms 合并刷新：${event.payload}`);
      if (refreshTimer) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        if (active) void refreshRef.current(workspace.path, "文件监听合并刷新");
      }, 300);
    }).then((cleanup) => {
      if (active) { unlisten = cleanup; writeClientLog("debug", `工作区后端监听已启动：${workspace.path}`); }
      else cleanup();
    }).catch((listenError: unknown) => writeClientLog("warn", `工作区监听事件不可用：${errorMessage(listenError)}`));
    const reconciliationTimer = window.setInterval(() => {
      if (active) void refreshRef.current(workspace.path, "周期完整校准");
    }, 30_000);
    return () => {
      active = false;
      if (refreshTimer) window.clearTimeout(refreshTimer);
      window.clearInterval(reconciliationTimer);
      unlisten?.();
    };
  }, [workspace?.isAvailable, workspace?.path]);

  useEffect(() => {
    if (!workspace) return;
    const { path, isAvailable: expectedAvailability } = workspace;
    let checking = false;
    let active = true;
    const recoveryTimer = window.setInterval(() => {
      if (checking) return;
      checking = true;
      void invoke<boolean>("workspace_is_accessible", { path }).then((accessible) => {
        if (!active) return;
        if (accessible && !expectedAvailability) void refreshRef.current(path, "目录恢复探测");
        else if (!accessible && expectedAvailability) {
          markUnavailableRef.current(path, "目录已无法访问");
          void refreshRef.current(path, "目录断连确认");
        }
      }).catch((probeError: unknown) => writeClientLog("warn", `工作区可访问性探测失败：${errorMessage(probeError)}`)).finally(() => { checking = false; });
    }, 2500);
    return () => { active = false; window.clearInterval(recoveryTimer); };
  }, [workspace]);

  return isExternalDropActive;
}
