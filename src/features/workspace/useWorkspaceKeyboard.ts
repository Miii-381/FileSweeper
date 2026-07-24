import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";

import { isFolderEntry, type FileTaskOperation, type DirectoryItem } from "../../app-types";
import { writeClientLog } from "../../app-utils";

export function useWorkspaceKeyboard({ disabled, workspaceAvailable, files, selectedFiles, setSelectedFiles, selectionAnchor, setSelectionAnchor, setSuppressPreviewAutoplay, writeClipboard, pasteClipboard, recycleSelected, startRename, openFolder }: {
  disabled: boolean;
  workspaceAvailable: boolean;
  files: DirectoryItem[];
  selectedFiles: Set<string>;
  setSelectedFiles: Dispatch<SetStateAction<Set<string>>>;
  selectionAnchor: string | null;
  setSelectionAnchor: Dispatch<SetStateAction<string | null>>;
  setSuppressPreviewAutoplay: Dispatch<SetStateAction<boolean>>;
  writeClipboard: (operation: FileTaskOperation) => Promise<void>;
  pasteClipboard: () => Promise<void>;
  recycleSelected: () => void;
  startRename: (path: string) => void;
  openFolder: (path: string) => void;
}) {
  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      const target = event.target;
      const isEditing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
      if (disabled || isEditing) return;
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (modifier && key === "c" && selectedFiles.size > 0) {
        event.preventDefault();
        if (!event.repeat) void writeClipboard("copy");
        return;
      }
      if (modifier && key === "x" && selectedFiles.size > 0) {
        event.preventDefault();
        if (!event.repeat) void writeClipboard("move");
        return;
      }
      if (modifier && key === "v" && workspaceAvailable) {
        event.preventDefault();
        if (!event.repeat) void pasteClipboard();
        return;
      }
      if (event.key === "Delete" && selectedFiles.size > 0) {
        event.preventDefault();
        recycleSelected();
        return;
      }
      if (event.key === "F2" && selectedFiles.size === 1) {
        event.preventDefault();
        startRename(selectionAnchor && selectedFiles.has(selectionAnchor) ? selectionAnchor : [...selectedFiles][0]);
        return;
      }
      if (event.key === "Enter" && selectionAnchor) {
        const item = files.find((candidate) => candidate.path === selectionAnchor);
        if (item && isFolderEntry(item)) {
          event.preventDefault();
          openFolder(item.path);
          return;
        }
      }
      if (modifier && key === "a" && files.length > 0) {
        event.preventDefault();
        setSelectedFiles(new Set(files.map((file) => file.path)));
        setSelectionAnchor(files[files.length - 1]?.path ?? null);
        writeClientLog("debug", `快捷键全选当前筛选结果：${files.length} 个文件`);
        return;
      }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && files.length > 0) {
        event.preventDefault();
        const currentIndex = selectionAnchor ? files.findIndex((file) => file.path === selectionAnchor) : -1;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex = Math.min(files.length - 1, Math.max(0, currentIndex === -1 ? (delta > 0 ? 0 : files.length - 1) : currentIndex + delta));
        const nextPath = files[nextIndex].path;
        setSuppressPreviewAutoplay(false);
        setSelectedFiles(new Set([nextPath]));
        setSelectionAnchor(nextPath);
        writeClientLog("debug", `键盘移动文件焦点：${event.key} -> ${nextPath}`);
        return;
      }
      if (event.key === " " && selectionAnchor && !(target instanceof Element && target.closest(".preview-player"))) {
        event.preventDefault();
        setSelectedFiles((current) => {
          const next = new Set(current);
          if (next.has(selectionAnchor)) next.delete(selectionAnchor);
          else next.add(selectionAnchor);
          writeClientLog("debug", `空格切换焦点文件选择：${selectionAnchor}，选择后数量 ${next.size}`);
          return next;
        });
      }
    };
    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, [disabled, openFolder, pasteClipboard, recycleSelected, selectedFiles, selectionAnchor, setSelectedFiles, setSelectionAnchor, setSuppressPreviewAutoplay, startRename, files, workspaceAvailable, writeClipboard]);
}
