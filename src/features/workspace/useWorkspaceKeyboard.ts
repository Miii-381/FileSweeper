import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";

import type { FileTaskOperation, VideoEntry } from "../../app-types";
import { writeClientLog } from "../../app-utils";

export function useWorkspaceKeyboard({ disabled, workspaceAvailable, videos, selectedVideos, setSelectedVideos, selectionAnchor, setSelectionAnchor, setSuppressPreviewAutoplay, writeClipboard, pasteClipboard, recycleSelected, startRename }: {
  disabled: boolean;
  workspaceAvailable: boolean;
  videos: VideoEntry[];
  selectedVideos: Set<string>;
  setSelectedVideos: Dispatch<SetStateAction<Set<string>>>;
  selectionAnchor: string | null;
  setSelectionAnchor: Dispatch<SetStateAction<string | null>>;
  setSuppressPreviewAutoplay: Dispatch<SetStateAction<boolean>>;
  writeClipboard: (operation: FileTaskOperation) => Promise<void>;
  pasteClipboard: () => Promise<void>;
  recycleSelected: () => void;
  startRename: (path: string) => void;
}) {
  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      const target = event.target;
      const isEditing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
      if (disabled || isEditing) return;
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (modifier && key === "c" && selectedVideos.size > 0) {
        event.preventDefault();
        if (!event.repeat) void writeClipboard("copy");
        return;
      }
      if (modifier && key === "x" && selectedVideos.size > 0) {
        event.preventDefault();
        if (!event.repeat) void writeClipboard("move");
        return;
      }
      if (modifier && key === "v" && workspaceAvailable) {
        event.preventDefault();
        if (!event.repeat) void pasteClipboard();
        return;
      }
      if (event.key === "Delete" && selectedVideos.size > 0) {
        event.preventDefault();
        recycleSelected();
        return;
      }
      if (event.key === "F2" && selectedVideos.size === 1) {
        event.preventDefault();
        startRename(selectionAnchor && selectedVideos.has(selectionAnchor) ? selectionAnchor : [...selectedVideos][0]);
        return;
      }
      if (modifier && key === "a" && videos.length > 0) {
        event.preventDefault();
        setSelectedVideos(new Set(videos.map((video) => video.path)));
        setSelectionAnchor(videos[videos.length - 1]?.path ?? null);
        writeClientLog("debug", `快捷键全选当前筛选结果：${videos.length} 个视频`);
        return;
      }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && videos.length > 0) {
        event.preventDefault();
        const currentIndex = selectionAnchor ? videos.findIndex((video) => video.path === selectionAnchor) : -1;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex = Math.min(videos.length - 1, Math.max(0, currentIndex === -1 ? (delta > 0 ? 0 : videos.length - 1) : currentIndex + delta));
        const nextPath = videos[nextIndex].path;
        setSuppressPreviewAutoplay(false);
        setSelectedVideos(new Set([nextPath]));
        setSelectionAnchor(nextPath);
        writeClientLog("debug", `键盘移动视频焦点：${event.key} -> ${nextPath}`);
        return;
      }
      if (event.key === " " && selectionAnchor && !(target instanceof Element && target.closest(".preview-player"))) {
        event.preventDefault();
        setSelectedVideos((current) => {
          const next = new Set(current);
          if (next.has(selectionAnchor)) next.delete(selectionAnchor);
          else next.add(selectionAnchor);
          writeClientLog("debug", `空格切换焦点视频选择：${selectionAnchor}，选择后数量 ${next.size}`);
          return next;
        });
      }
    };
    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, [disabled, pasteClipboard, recycleSelected, selectedVideos, selectionAnchor, setSelectedVideos, setSelectionAnchor, setSuppressPreviewAutoplay, startRename, videos, workspaceAvailable, writeClipboard]);
}
