import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

import type { FileTaskOperation, WorkspaceContextMenu, WorkspaceListing } from "../../app-types";
import { errorMessage, writeClientLog } from "../../app-utils";
import type { ContextMenuAction } from "../../components/ThemedContextMenu";

export function useWorkspaceMenu({ workspace, refreshWorkspace, activateWorkspace, copyVideosToDirectory, writeFilesToClipboard, pasteFileClipboard, recycleVideos, notify }: {
  workspace: WorkspaceListing | null;
  refreshWorkspace: (path: string, reason?: string) => Promise<void>;
  activateWorkspace: (path: string) => Promise<void>;
  copyVideosToDirectory: (paths: string[]) => Promise<void>;
  writeFilesToClipboard: (paths: string[], operation: FileTaskOperation) => Promise<void>;
  pasteFileClipboard: () => Promise<void>;
  recycleVideos: (paths: string[]) => Promise<void>;
  notify: (message: string) => void;
}) {
  const [menu, setMenu] = useState<WorkspaceContextMenu | null>(null);

  const showPathMenu = useCallback((event: ReactMouseEvent<HTMLElement>, path: string) => {
    event.preventDefault();
    event.stopPropagation();
    writeClientLog("debug", `打开目录菜单：${path}`);
    setMenu({ x: Math.max(12, Math.min(event.clientX, window.innerWidth - 252)), y: Math.max(12, Math.min(event.clientY, window.innerHeight - 150)), kind: "directory", workspacePath: workspace?.path ?? null, paths: [path], primaryPath: path });
  }, [workspace?.path]);

  const showWorkspaceMenu = useCallback((event: ReactMouseEvent<HTMLElement>, paths: string[] = []) => {
    if (!workspace) return;
    event.preventDefault();
    event.stopPropagation();
    writeClientLog("debug", `打开${paths.length > 0 ? "视频" : "工作区"}菜单：工作区 ${workspace.path}，视频 ${paths.length} 个`);
    setMenu({ x: Math.max(12, Math.min(event.clientX, window.innerWidth - 252)), y: Math.max(12, Math.min(event.clientY, window.innerHeight - (paths.length > 0 ? 342 : 190))), kind: paths.length > 0 ? "videos" : "workspace", workspacePath: workspace.path, paths, primaryPath: paths[0] ?? null });
  }, [workspace]);

  const runAction = useCallback(async (action: ContextMenuAction) => {
    const current = menu;
    setMenu(null);
    if (!current) {
      writeClientLog("warn", `菜单动作被忽略：菜单状态已不存在，动作 ${action}`);
      return;
    }
    writeClientLog("info", `执行菜单动作：目标 ${current.kind}，动作 ${action}，路径 ${current.paths.length} 个，主路径 ${current.primaryPath ?? current.workspacePath ?? "无"}`);
    try {
      if (action === "refresh" && current.workspacePath) await refreshWorkspace(current.workspacePath, "右键手动刷新");
      else if (action === "open" && current.kind === "directory" && current.primaryPath) await activateWorkspace(current.primaryPath);
      else if (action === "open" && current.primaryPath) await invoke("open_video_externally", { path: current.primaryPath });
      else if (action === "reveal") {
        const path = current.primaryPath ?? current.workspacePath;
        if (path) await invoke("reveal_path", { path });
      } else if (action === "copyTo" && current.paths.length > 0) await copyVideosToDirectory(current.paths);
      else if (action === "clipboardCopy" && current.paths.length > 0) await writeFilesToClipboard(current.paths, "copy");
      else if (action === "clipboardCut" && current.paths.length > 0) await writeFilesToClipboard(current.paths, "move");
      else if (action === "paste") await pasteFileClipboard();
      else if (action === "delete" && current.paths.length > 0) await recycleVideos(current.paths);
      writeClientLog("info", `菜单动作完成：目标 ${current.kind}，动作 ${action}`);
    } catch (actionError) {
      const message = errorMessage(actionError);
      notify(message);
      writeClientLog("error", `执行工作区右键菜单操作失败：${message}`);
    }
  }, [activateWorkspace, copyVideosToDirectory, menu, notify, pasteFileClipboard, recycleVideos, refreshWorkspace, writeFilesToClipboard]);

  useEffect(() => {
    if (!menu) return;
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".workspace-context-menu")) {
        writeClientLog("debug", "点击菜单外部，关闭主题化菜单");
        setMenu(null);
      }
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        writeClientLog("debug", "按 Escape 关闭主题化菜单");
        setMenu(null);
      }
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeEscape);
    };
  }, [menu]);

  return { menu, close: () => setMenu(null), showPathMenu, showWorkspaceMenu, runAction };
}
