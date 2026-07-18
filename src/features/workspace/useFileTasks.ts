import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";

import type {
  FileTaskOperation,
  FileTaskSnapshot,
  RecycleResult,
  RenameResult,
  VideoEntry,
  WorkspaceListing,
} from "../../app-types";
import { errorMessage, writeClientLog } from "../../app-utils";
import type { PreviewPlayerHandle } from "../../components/PreviewPlayer";

export function useFileTasks({
  workspace,
  setWorkspace,
  selectedVideos,
  setSelectedVideos,
  setSelectionAnchor,
  selectedVideo,
  previewPlayerRef,
  refreshWorkspace,
  notify,
}: {
  workspace: WorkspaceListing | null;
  setWorkspace: Dispatch<SetStateAction<WorkspaceListing | null>>;
  selectedVideos: Set<string>;
  setSelectedVideos: Dispatch<SetStateAction<Set<string>>>;
  setSelectionAnchor: Dispatch<SetStateAction<string | null>>;
  selectedVideo: VideoEntry | null;
  previewPlayerRef: RefObject<PreviewPlayerHandle | null>;
  refreshWorkspace: (path: string, reason?: string) => Promise<void>;
  notify: (message: string) => void;
}) {
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [activeFileTask, setActiveFileTask] = useState<FileTaskSnapshot | null>(null);
  const renameSubmitting = useRef(false);
  const renameCancelling = useRef(false);
  const dismissTimer = useRef<number | null>(null);
  const completedTasks = useRef<Set<number>>(new Set());
  const refreshWorkspaceRef = useRef(refreshWorkspace);
  const notifyRef = useRef(notify);
  refreshWorkspaceRef.current = refreshWorkspace;
  notifyRef.current = notify;

  const applyRecycleResult = useCallback(
    (result: RecycleResult) => {
      const recycledPaths = new Set(result.recycledPaths);
      setWorkspace((current) =>
        current ? { ...current, videos: current.videos.filter((video) => !recycledPaths.has(video.path)) } : current,
      );
      setSelectedVideos((current) => new Set([...current].filter((path) => !recycledPaths.has(path))));
      setSelectionAnchor((current) => (current && recycledPaths.has(current) ? null : current));
      if (result.failedPaths.length > 0) {
        notifyRef.current(`已移到回收站 ${result.recycledPaths.length} 个视频，${result.failedPaths.length} 个失败`);
        writeClientLog("warn", `回收站操作部分失败：成功 ${result.recycledPaths.length}，失败 ${result.failedPaths.length}`);
      } else {
        notifyRef.current(`已将 ${result.recycledPaths.length} 个视频移到回收站`);
        writeClientLog("info", `回收站操作完成：${result.recycledPaths.length} 个视频`);
      }
    },
    [setSelectedVideos, setSelectionAnchor, setWorkspace],
  );

  const recycleVideos = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) {
        writeClientLog("debug", "回收站操作被忽略：没有视频路径");
        return;
      }
      if (!window.confirm(`将 ${paths.length} 个视频移到回收站？`)) {
        writeClientLog("info", `用户取消回收站操作：${paths.length} 个视频`);
        return;
      }
      writeClientLog("info", `开始回收站操作：${paths.length} 个视频`);
      try {
        const focusedVideoPath = selectedVideo && paths.includes(selectedVideo.path) ? selectedVideo.path : null;
        if (focusedVideoPath) {
          writeClientLog("debug", `删除前停止焦点视频预览：${focusedVideoPath}`);
          previewPlayerRef.current?.stopPlayback();
          await invoke("stop_transcoded_preview", { path: focusedVideoPath });
          previewPlayerRef.current?.releasePlayback();
        }
        const result = await invoke<RecycleResult>("recycle_videos", { paths, focusedVideoPath });
        applyRecycleResult(result);
      } catch (recycleError) {
        const message = errorMessage(recycleError);
        notifyRef.current(message);
        writeClientLog("error", `回收站操作失败：${message}`);
      }
    },
    [applyRecycleResult, previewPlayerRef, selectedVideo],
  );

  const recycleSelectedVideos = useCallback(
    () => recycleVideos([...selectedVideos]),
    [recycleVideos, selectedVideos],
  );

  const startInlineRename = useCallback(
    (path: string) => {
      if (selectedVideos.size !== 1 || !workspace) {
        writeClientLog("debug", `重命名入口被忽略：选择数量 ${selectedVideos.size}，工作区 ${Boolean(workspace)}`);
        return;
      }
      const selected = workspace.videos.find((video) => video.path === path);
      if (!selected) {
        writeClientLog("warn", `重命名入口未找到工作区视频：${path}`);
        return;
      }
      const currentStem = selected.extension.length > 0 ? selected.name.slice(0, -selected.extension.length) : selected.name;
      renameCancelling.current = false;
      setRenameDraft(currentStem);
      setRenamingPath(selected.path);
      writeClientLog("info", `开始原位重命名：${selected.path}`);
    },
    [selectedVideos.size, workspace],
  );

  const cancelInlineRename = useCallback(() => {
    if (renamingPath) {
      writeClientLog("info", `取消原位重命名：${renamingPath}`);
    }
    renameCancelling.current = true;
    setRenamingPath(null);
    setRenameDraft("");
    window.requestAnimationFrame(() => {
      renameCancelling.current = false;
    });
  }, [renamingPath]);

  const submitInlineRename = useCallback(async () => {
    if (renameCancelling.current || renameSubmitting.current || !renamingPath || !workspace) {
      return;
    }
    const selected = workspace.videos.find((video) => video.path === renamingPath);
    if (!selected) {
      writeClientLog("warn", `提交重命名时视频已不在工作区：${renamingPath}`);
      cancelInlineRename();
      return;
    }
    const newStem = renameDraft.trim();
    const currentStem = selected.extension.length > 0 ? selected.name.slice(0, -selected.extension.length) : selected.name;
    if (newStem === currentStem) {
      writeClientLog("debug", `重命名内容未变化，取消提交：${selected.path}`);
      cancelInlineRename();
      return;
    }
    renameSubmitting.current = true;
    setRenamingPath(null);
    writeClientLog("info", `提交视频重命名：${selected.path} -> ${newStem}${selected.extension}`);
    try {
      const result = await invoke<RenameResult>("rename_video", { path: selected.path, newStem });
      await refreshWorkspaceRef.current(workspace.path, "重命名");
      setSelectedVideos(new Set([result.newPath]));
      setSelectionAnchor(result.newPath);
      notifyRef.current(`已重命名为 ${result.name}`);
      writeClientLog("info", `重命名视频：${result.oldPath} -> ${result.newPath}`);
    } catch (renameError) {
      const message = errorMessage(renameError);
      notifyRef.current(message);
      writeClientLog("error", `重命名视频失败：${selected.path}，${message}`);
    } finally {
      renameSubmitting.current = false;
      setRenameDraft("");
    }
  }, [cancelInlineRename, renameDraft, renamingPath, setSelectedVideos, setSelectionAnchor, workspace]);

  const startTransferTask = useCallback(async (
    paths: string[],
    destinationPath: string,
    operation: FileTaskOperation = "copy",
  ) => {
    if (paths.length === 0) {
      return null;
    }
    try {
      if (dismissTimer.current !== null) {
        window.clearTimeout(dismissTimer.current);
        dismissTimer.current = null;
      }
      const task = await invoke<FileTaskSnapshot>("start_file_task", { paths, destinationPath, operation });
      setActiveFileTask(task);
      notifyRef.current(`${operation === "move" ? "移动" : "复制"}任务 #${task.id} 已加入队列`);
      writeClientLog("info", `文件任务 #${task.id} 已创建：${operation} ${paths.length} 个项目到 ${destinationPath}`);
      return task;
    } catch (taskError) {
      const message = errorMessage(taskError);
      notifyRef.current(message);
      writeClientLog("error", `创建文件任务失败：${message}`);
      return null;
    }
  }, []);

  const copyDroppedVideos = useCallback(
    async (paths: string[], workspacePath: string) => {
      await startTransferTask(paths, workspacePath, "copy");
    },
    [startTransferTask],
  );

  const copyVideosToDirectory = useCallback(async (paths: string[]) => {
    if (paths.length === 0) {
      return;
    }
    try {
      writeClientLog("info", `打开“复制到”目录选择器：${paths.length} 个视频`);
      const destination = await open({ directory: true, multiple: false, title: "复制视频到" });
      if (typeof destination !== "string") {
        writeClientLog("debug", `用户取消“复制到”操作：${paths.length} 个视频`);
        return;
      }
      writeClientLog("info", `“复制到”目标已选择：${destination}`);
      await startTransferTask(paths, destination, "copy");
    } catch (copyError) {
      const message = errorMessage(copyError);
      notifyRef.current(message);
      writeClientLog("error", `复制到目录失败：${message}`);
    }
  }, [startTransferTask]);

  const writeSelectionToFileClipboard = useCallback(async (operation: FileTaskOperation) => {
    const paths = [...selectedVideos];
    if (paths.length === 0) {
      return;
    }
    try {
      await invoke("write_files_to_clipboard", { paths, operation });
      notifyRef.current(`已${operation === "move" ? "剪切" : "复制"} ${paths.length} 个视频，可粘贴到本应用或资源管理器`);
      writeClientLog("info", `写入系统文件剪贴板：${operation} ${paths.length} 个视频`);
    } catch (clipboardError) {
      const message = errorMessage(clipboardError);
      notifyRef.current(message);
      writeClientLog("error", `写入系统文件剪贴板失败：${message}`);
    }
  }, [selectedVideos]);

  const pasteFileClipboard = useCallback(async () => {
    if (!workspace?.isAvailable) {
      return;
    }
    try {
      if (dismissTimer.current !== null) {
        window.clearTimeout(dismissTimer.current);
        dismissTimer.current = null;
      }
      const task = await invoke<FileTaskSnapshot>("paste_files_from_clipboard", { destinationPath: workspace.path });
      setActiveFileTask(task);
      notifyRef.current(`${task.operation === "move" ? "移动" : "复制"}任务 #${task.id} 已加入队列`);
      writeClientLog("info", `从系统文件剪贴板创建任务 #${task.id}，目标 ${workspace.path}`);
    } catch (pasteError) {
      const message = errorMessage(pasteError);
      notifyRef.current(message);
      writeClientLog("error", `粘贴系统文件剪贴板失败：${message}`);
    }
  }, [workspace]);

  const cancelActiveFileTask = useCallback(async () => {
    if (!activeFileTask || !["queued", "running"].includes(activeFileTask.state)) {
      writeClientLog("debug", "取消文件任务被忽略：当前没有可取消任务");
      return;
    }
    writeClientLog("info", `请求取消文件任务 #${activeFileTask.id}，当前状态 ${activeFileTask.state}`);
    try {
      const accepted = await invoke<boolean>("cancel_file_task", { taskId: activeFileTask.id });
      notifyRef.current(accepted ? `正在取消任务 #${activeFileTask.id} 的未开始项目` : `任务 #${activeFileTask.id} 已无法取消`);
      writeClientLog(accepted ? "info" : "warn", `文件任务取消结果：任务 #${activeFileTask.id}，接受 ${accepted}`);
    } catch (cancelError) {
      const message = errorMessage(cancelError);
      notifyRef.current(message);
      writeClientLog("error", `取消文件任务失败：任务 #${activeFileTask.id}，${message}`);
    }
  }, [activeFileTask]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<FileTaskSnapshot>("file-task-progress", (event) => {
      const task = event.payload;
      setActiveFileTask((current) => (!current || current.id === task.id || task.id > current.id ? task : current));
      if (!["completed", "cancelled"].includes(task.state) || completedTasks.current.has(task.id)) {
        return;
      }
      completedTasks.current.add(task.id);
      const completed = task.results.filter((result) => result.status === "completed").length;
      const skipped = task.results.filter((result) => result.status === "skipped").length;
      const failed = task.results.filter((result) => result.status === "failed").length;
      const cancelled = task.results.filter((result) => result.status === "cancelled").length;
      const verb = task.operation === "move" ? "移动" : "复制";
      notifyRef.current(`${verb}任务 #${task.id}：成功 ${completed}，跳过 ${skipped}，失败 ${failed}${cancelled ? `，取消 ${cancelled}` : ""}`);
      writeClientLog(
        failed > 0 ? "warn" : "info",
        `文件任务 #${task.id} 完成：${verb}成功 ${completed}，跳过 ${skipped}，失败 ${failed}，取消 ${cancelled}`,
      );
      if (workspace?.path) {
        void refreshWorkspaceRef.current(workspace.path, `文件任务 #${task.id} 完成`);
      }
      if (dismissTimer.current !== null) {
        window.clearTimeout(dismissTimer.current);
      }
      dismissTimer.current = window.setTimeout(() => {
        setActiveFileTask((current) => (current?.id === task.id ? null : current));
        dismissTimer.current = null;
      }, 5000);
    })
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch((listenError: unknown) => writeClientLog("warn", `文件任务监听不可用：${errorMessage(listenError)}`));
    return () => unlisten?.();
  }, [workspace?.path]);

  useEffect(
    () => () => {
      if (dismissTimer.current !== null) {
        window.clearTimeout(dismissTimer.current);
      }
    },
    [],
  );

  return {
    renamingPath,
    renameDraft,
    setRenameDraft,
    activeFileTask,
    recycleVideos,
    recycleSelectedVideos,
    startInlineRename,
    cancelInlineRename,
    submitInlineRename,
    startTransferTask,
    copyDroppedVideos,
    copyVideosToDirectory,
    writeSelectionToFileClipboard,
    pasteFileClipboard,
    cancelActiveFileTask,
  };
}
