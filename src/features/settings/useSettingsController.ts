import { invoke } from "@tauri-apps/api/core";
import { useCallback, useState } from "react";
import type { Dispatch, MouseEvent as ReactMouseEvent, SetStateAction } from "react";

import type { AppConfig, ListColumn, ListColumnId, Preferences, WorkspaceListing } from "../../app-types";
import { errorMessage, writeClientLog } from "../../app-utils";

export function useSettingsController({ config, setConfig, workspace, activateWorkspace, resetThumbnails, notify }: {
  config: AppConfig;
  setConfig: Dispatch<SetStateAction<AppConfig>>;
  workspace: WorkspaceListing | null;
  activateWorkspace: (path: string, persist?: boolean, workspaceMemoryEnabled?: boolean) => Promise<void>;
  resetThumbnails: () => void;
  notify: (message: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [draggedColumn, setDraggedColumn] = useState<ListColumnId | null>(null);
  const [dropTarget, setDropTarget] = useState<ListColumnId | null>(null);
  const [dropPosition, setDropPosition] = useState<"before" | "after" | null>(null);

  const open = useCallback(() => {
    writeClientLog("info", "打开偏好设置");
    setIsOpen(true);
  }, []);

  const apply = useCallback(async (settings: Preferences): Promise<boolean> => {
    const thumbnailPositionChanged = config.settings.thumbnailCapturePosition !== settings.thumbnailCapturePosition;
    writeClientLog("info", `提交偏好设置：主题 ${settings.appearance}/${settings.accentTheme}，代码配色 ${settings.codeTheme}，文本字体 ${settings.textPreviewLatinFont}/${settings.textPreviewCjkFont}，缓存 ${settings.thumbnailCacheGb} GiB，取帧 ${settings.thumbnailCapturePosition}，后台并发 ${settings.backgroundSidecarConcurrency}，扩展名 ${settings.videoExtensions.length} 个`);
    try {
      const nextConfig = await invoke<AppConfig>("save_configuration", { settings });
      setConfig((current) => ({ ...current, version: nextConfig.version, settings: nextConfig.settings }));
      if (thumbnailPositionChanged && workspace) {
        writeClientLog("info", `缩略图取帧位置发生变化，清空前端内存缓存并重新扫描：${workspace.path}`);
        resetThumbnails();
      }
      if (workspace) await activateWorkspace(workspace.path, false, nextConfig.settings.rememberWorkspaceFocus);
      writeClientLog("info", `偏好设置保存完成：配置版本 ${nextConfig.version}`);
      return true;
    } catch (applyError) {
      const message = errorMessage(applyError);
      notify(message);
      writeClientLog("error", `保存设置失败：${message}`);
      return false;
    }
  }, [activateWorkspace, config.settings.thumbnailCapturePosition, notify, resetThumbnails, setConfig, workspace]);

  const setColumns = useCallback((listColumns: ListColumn[]) => {
    setConfig((current) => ({ ...current, settings: { ...current.settings, listColumns } }));
  }, [setConfig]);

  const persistColumns = useCallback(async (listColumns: ListColumn[]) => {
    writeClientLog("info", `保存列表列布局：${listColumns.map((column) => `${column.id}:${column.visible ? "显示" : "隐藏"}:${column.width}`).join(", ")}`);
    try {
      const nextConfig = await invoke<AppConfig>("set_list_columns", { listColumns });
      setConfig((current) => ({ ...current, version: nextConfig.version, settings: { ...current.settings, listColumns: nextConfig.settings.listColumns } }));
      writeClientLog("info", `列表列布局保存完成：${nextConfig.settings.listColumns.length} 列`);
    } catch (persistError) {
      const message = errorMessage(persistError);
      notify(message);
      writeClientLog("error", `保存列表列设置失败：${message}`);
    }
  }, [notify, setConfig]);

  const reorderColumns = useCallback((sourceId: ListColumnId, targetId: ListColumnId, position: "before" | "after") => {
    if (sourceId === "name" || targetId === "name" || sourceId === targetId) return;
    const nextColumns = [...config.settings.listColumns];
    const sourceIndex = nextColumns.findIndex((column) => column.id === sourceId);
    const targetIndex = nextColumns.findIndex((column) => column.id === targetId);
    if (sourceIndex < 1 || targetIndex < 1) return;
    const [source] = nextColumns.splice(sourceIndex, 1);
    const adjustedTargetIndex = nextColumns.findIndex((column) => column.id === targetId);
    nextColumns.splice(position === "after" ? adjustedTargetIndex + 1 : adjustedTargetIndex, 0, source);
    writeClientLog("info", `重排列表列：${sourceId} ${position} ${targetId}`);
    setColumns(nextColumns);
    void persistColumns(nextColumns);
  }, [config.settings.listColumns, persistColumns, setColumns]);

  const startColumnReorder = useCallback((event: ReactMouseEvent<HTMLSpanElement>, columnId: ListColumnId) => {
    if (columnId === "name" || event.button !== 0) return;
    event.preventDefault();
    setDraggedColumn(columnId);
    let nextTarget: ListColumnId | null = null;
    let nextPosition: "before" | "after" | null = null;
    const onPointerMove = (moveEvent: PointerEvent) => {
      const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest<HTMLElement>("[data-list-column-id]");
      const targetId = target?.dataset.listColumnId as ListColumnId | undefined;
      if (target && targetId && targetId !== "name" && targetId !== columnId) {
        const bounds = target.getBoundingClientRect();
        nextTarget = targetId;
        nextPosition = moveEvent.clientX < bounds.left + bounds.width / 2 ? "before" : "after";
      } else {
        nextTarget = null;
        nextPosition = null;
      }
      setDropTarget(nextTarget);
      setDropPosition(nextPosition);
    };
    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      if (nextTarget && nextPosition) reorderColumns(columnId, nextTarget, nextPosition);
      setDraggedColumn(null);
      setDropTarget(null);
      setDropPosition(null);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  }, [reorderColumns]);

  const startColumnResize = useCallback((event: ReactMouseEvent<HTMLSpanElement>, columnId: ListColumnId) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startColumn = config.settings.listColumns.find((column) => column.id === columnId);
    if (!startColumn) return;
    let nextColumns = config.settings.listColumns;
    const onPointerMove = (moveEvent: PointerEvent) => {
      const width = Math.round(Math.max(80, Math.min(520, startColumn.width + moveEvent.clientX - startX)) / 4) * 4;
      nextColumns = config.settings.listColumns.map((column) => column.id === columnId ? { ...column, width } : column);
      setColumns(nextColumns);
    };
    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      void persistColumns(nextColumns);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  }, [config.settings.listColumns, persistColumns, setColumns]);

  return { isOpen, setIsOpen, open, apply, setColumns, draggedColumn, dropTarget, dropPosition, startColumnReorder, startColumnResize };
}
