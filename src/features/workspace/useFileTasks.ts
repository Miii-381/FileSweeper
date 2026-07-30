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
  FileEntry,
  WorkspaceListing,
} from "../../app-types";
import { errorMessage, writeClientLog } from "../../app-utils";
import type { PreviewPlayerHandle } from "../../components/PreviewPlayer";

export function useFileTasks({
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
}: {
  workspace: WorkspaceListing | null;
  setWorkspace: Dispatch<SetStateAction<WorkspaceListing | null>>;
  selectedFiles: Set<string>;
  setSelectedFiles: Dispatch<SetStateAction<Set<string>>>;
  setSelectionAnchor: Dispatch<SetStateAction<string | null>>;
  selectedFile: FileEntry | null;
  previewPlayerRef: RefObject<PreviewPlayerHandle | null>;
  refreshWorkspace: (path: string, reason?: string) => Promise<void>;
  notify: (message: string) => void;
  confirmRecycle: (message: string) => Promise<boolean>;
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
  const workspacePathRef = useRef<string | null>(workspace?.path ?? null);
  refreshWorkspaceRef.current = refreshWorkspace;
  notifyRef.current = notify;
  workspacePathRef.current = workspace?.path ?? null;

  const applyRecycleResult = useCallback(
    (result: RecycleResult) => {
      const recycledPaths = new Set(result.recycledPaths);
      setWorkspace((current) =>
        current ? { ...current, items: current.items.filter((item) => !recycledPaths.has(item.path)) } : current,
      );
      setSelectedFiles((current) => new Set([...current].filter((path) => !recycledPaths.has(path))));
      setSelectionAnchor((current) => (current && recycledPaths.has(current) ? null : current));
      if (result.failedPaths.length > 0) {
        notifyRef.current(`已移到回收站 ${result.recycledPaths.length} 个项目，${result.failedPaths.length} 个失败`);
        writeClientLog("warn", `回收站操作部分失败：成功 ${result.recycledPaths.length}，失败 ${result.failedPaths.length}`);
      } else {
        notifyRef.current(`已将 ${result.recycledPaths.length} 个项目移到回收站`);
        writeClientLog("info", `回收站操作完成：${result.recycledPaths.length} 个文件`);
      }
    },
    [setSelectedFiles, setSelectionAnchor, setWorkspace],
  );

  const recycleFiles = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) {
        writeClientLog("debug", "回收站操作被忽略：没有文件路径");
        return;
      }
      if (!await confirmRecycle(`将 ${paths.length} 个文件移到回收站？`)) {
        writeClientLog("info", `用户取消回收站操作：${paths.length} 个文件`);
        return;
      }
      writeClientLog("info", `开始回收站操作：${paths.length} 个文件`);
      try {
        const focusedFilePath = selectedFile && paths.includes(selectedFile.path) ? selectedFile.path : null;
        if (focusedFilePath && selectedFile?.kind === "video") {
          writeClientLog("debug", `删除前停止焦点文件预览：${focusedFilePath}`);
          previewPlayerRef.current?.stopPlayback();
          await invoke("stop_transcoded_preview", { path: focusedFilePath });
          previewPlayerRef.current?.releasePlayback();
        }
        const result = await invoke<RecycleResult>("recycle_items", { paths, focusedFilePath });
        applyRecycleResult(result);
      } catch (recycleError) {
        const message = errorMessage(recycleError);
        notifyRef.current(message);
        writeClientLog("error", `回收站操作失败：${message}`);
      }
    },
    [applyRecycleResult, confirmRecycle, previewPlayerRef, selectedFile],
  );

  const recycleSelectedFiles = useCallback(
    () => recycleFiles([...selectedFiles]),
    [recycleFiles, selectedFiles],
  );

  const startInlineRename = useCallback(
    (path: string) => {
      if (selectedFiles.size !== 1 || !workspace) {
        writeClientLog("debug", `重命名入口被忽略：选择数量 ${selectedFiles.size}，工作区 ${Boolean(workspace)}`);
        return;
      }
      const selected = workspace.items.find((item) => item.path === path);
      if (!selected) {
        writeClientLog("warn", `重命名入口未找到工作区文件：${path}`);
        return;
      }
      const currentStem = "extension" in selected && selected.extension.length > 0 ? selected.name.slice(0, -selected.extension.length) : selected.name;
      renameCancelling.current = false;
      setRenameDraft(currentStem);
      setRenamingPath(selected.path);
      writeClientLog("info", `开始原位重命名：${selected.path}`);
    },
    [selectedFiles.size, workspace],
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
    const selected = workspace.items.find((item) => item.path === renamingPath);
    if (!selected) {
      writeClientLog("warn", `提交重命名时文件已不在工作区：${renamingPath}`);
      cancelInlineRename();
      return;
    }
    const newStem = renameDraft.trim();
    const extension = "extension" in selected ? selected.extension : "";
    const currentStem = extension.length > 0 ? selected.name.slice(0, -extension.length) : selected.name;
    if (newStem === currentStem) {
      writeClientLog("debug", `重命名内容未变化，取消提交：${selected.path}`);
      cancelInlineRename();
      return;
    }
    renameSubmitting.current = true;
    setRenamingPath(null);
    const renamedWorkspacePath = workspace.path;
    writeClientLog("info", `提交项目重命名：${selected.path} -> ${newStem}${extension}`);
    try {
      const result = await invoke<RenameResult>("rename_item", { path: selected.path, newStem });
      await refreshWorkspaceRef.current(renamedWorkspacePath, "重命名");
      if (workspacePathRef.current?.toLocaleLowerCase() === renamedWorkspacePath.toLocaleLowerCase()) {
        setSelectedFiles(new Set([result.newPath]));
        setSelectionAnchor(result.newPath);
      } else {
        writeClientLog("debug", `重命名完成时工作区已切换，跳过选择更新：原工作区 ${renamedWorkspacePath}，当前 ${workspacePathRef.current ?? "无"}`);
      }
      notifyRef.current(`已重命名为 ${result.name}`);
      writeClientLog("info", `重命名项目：${result.oldPath} -> ${result.newPath}`);
    } catch (renameError) {
      const message = errorMessage(renameError);
      notifyRef.current(message);
      writeClientLog("error", `重命名项目失败：${selected.path}，${message}`);
    } finally {
      renameSubmitting.current = false;
      setRenameDraft("");
    }
  }, [cancelInlineRename, renameDraft, renamingPath, setSelectedFiles, setSelectionAnchor, workspace]);

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

  const copyDroppedFiles = useCallback(
    async (paths: string[], workspacePath: string) => {
      await startTransferTask(paths, workspacePath, "copy");
    },
    [startTransferTask],
  );

  const copyFilesToDirectory = useCallback(async (paths: string[]) => {
    if (paths.length === 0) {
      return;
    }
    try {
      writeClientLog("info", `打开“复制到”目录选择器：${paths.length} 个文件`);
      const destination = await open({ directory: true, multiple: false, title: "复制文件到" });
      if (typeof destination !== "string") {
        writeClientLog("debug", `用户取消“复制到”操作：${paths.length} 个文件`);
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

  const writeFilesToClipboard = useCallback(async (paths: string[], operation: FileTaskOperation) => {
    if (paths.length === 0) {
      return;
    }
    try {
      await invoke("write_items_to_clipboard", { paths, operation });
      notifyRef.current(`已${operation === "move" ? "剪切" : "复制"} ${paths.length} 个文件，可粘贴到本应用或资源管理器`);
      writeClientLog("info", `写入系统文件剪贴板：${operation} ${paths.length} 个文件`);
    } catch (clipboardError) {
      const message = errorMessage(clipboardError);
      notifyRef.current(message);
      writeClientLog("error", `写入系统文件剪贴板失败：${message}`);
    }
  }, []);

  const writeSelectionToFileClipboard = useCallback(
    (operation: FileTaskOperation) => writeFilesToClipboard([...selectedFiles], operation),
    [selectedFiles, writeFilesToClipboard],
  );

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
    let active = true;
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
      const workspacePath = workspacePathRef.current;
      if (workspacePath) {
        void refreshWorkspaceRef.current(workspacePath, `文件任务 #${task.id} 完成`);
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
        if (active) unlisten = cleanup;
        else cleanup();
      })
      .catch((listenError: unknown) => writeClientLog("warn", `文件任务监听不可用：${errorMessage(listenError)}`));
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

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
  };
}
