import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Dispatch,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  SetStateAction,
} from "react";

import type {
  FileDragGesture,
  DirectoryItem,
  ViewMode,
  WorkspaceSelectionBox,
  WorkspaceSelectionGesture,
} from "../../app-types";
import { errorMessage, writeClientLog } from "../../app-utils";
import { calculateWorkspaceSelectionGeometry } from "./workspaceSelection";

export function useWorkspaceGestures({
  hasWorkspace,
  files,
  selectedFiles,
  setSelectedFiles,
  selectionAnchor,
  setSelectionAnchor,
  setSuppressPreviewAutoplay,
  renamingPath,
  notify,
}: {
  hasWorkspace: boolean;
  files: DirectoryItem[];
  selectedFiles: Set<string>;
  setSelectedFiles: Dispatch<SetStateAction<Set<string>>>;
  selectionAnchor: string | null;
  setSelectionAnchor: Dispatch<SetStateAction<string | null>>;
  setSuppressPreviewAutoplay: Dispatch<SetStateAction<boolean>>;
  renamingPath: string | null;
  notify: (message: string) => void;
}) {
  const [selectionBox, setSelectionBox] = useState<WorkspaceSelectionBox | null>(null);
  const selectionGesture = useRef<WorkspaceSelectionGesture | null>(null);
  const selectionAutoScrollFrame = useRef<number | null>(null);
  const suppressBackgroundClear = useRef(false);
  const fileDragGesture = useRef<FileDragGesture | null>(null);

  const selectFile = useCallback(
    (event: ReactMouseEvent<HTMLElement>, path: string) => {
      setSuppressPreviewAutoplay(false);
      if (event.shiftKey && selectionAnchor) {
        const start = files.findIndex((file) => file.path === selectionAnchor);
        const end = files.findIndex((file) => file.path === path);
        if (start !== -1 && end !== -1) {
          const range = files.slice(Math.min(start, end), Math.max(start, end) + 1).map((file) => file.path);
          setSelectedFiles(new Set(range));
          writeClientLog("debug", `范围选择文件：起点 ${selectionAnchor}，终点 ${path}，数量 ${range.length}`);
          return;
        }
      }
      if (event.ctrlKey || event.metaKey) {
        setSelectedFiles((current) => {
          const next = new Set(current);
          if (next.has(path)) {
            next.delete(path);
          } else {
            next.add(path);
          }
          writeClientLog("debug", `切换文件选择：${path}，选择后数量 ${next.size}`);
          return next;
        });
      } else {
        setSelectedFiles(new Set([path]));
        writeClientLog("debug", `选择单个文件：${path}`);
      }
      setSelectionAnchor(path);
    },
    [selectionAnchor, setSelectedFiles, setSelectionAnchor, setSuppressPreviewAutoplay, files],
  );

  const clearSelection = useCallback(() => {
    if (selectedFiles.size > 0) {
      writeClientLog("debug", `清空工作区选择：原选中 ${selectedFiles.size} 个文件`);
    }
    setSelectedFiles(new Set());
    setSelectionAnchor(null);
  }, [selectedFiles.size, setSelectedFiles, setSelectionAnchor]);

  const clearSelectionFromBackground = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (suppressBackgroundClear.current) {
        suppressBackgroundClear.current = false;
        return;
      }
      const target = event.target;
      if (!(target instanceof Element) || target.closest(".file-card, .file-list-row, .file-list-header")) {
        return;
      }
      clearSelection();
    },
    [clearSelection],
  );

  const selectionPathsIntersecting = (root: HTMLDivElement, selectionRect: DOMRect) => {
    const paths = new Set<string>();
    root.querySelectorAll<HTMLElement>(".file-card[data-file-path], .file-list-row[data-file-path]").forEach((item) => {
      const itemRect = item.getBoundingClientRect();
      const intersects =
        itemRect.left < selectionRect.right &&
        itemRect.right > selectionRect.left &&
        itemRect.top < selectionRect.bottom &&
        itemRect.bottom > selectionRect.top;
      if (intersects) {
        const path = item.dataset.filePath;
        if (path) {
          paths.add(path);
        }
      }
    });
    return paths;
  };

  const stopAutoScroll = () => {
    if (selectionAutoScrollFrame.current !== null) {
      window.cancelAnimationFrame(selectionAutoScrollFrame.current);
      selectionAutoScrollFrame.current = null;
    }
  };

  const applyRectangleSelection = (
    gesture: WorkspaceSelectionGesture,
    clientX: number,
    clientY: number,
  ) => {
    const pointerWidth = Math.abs(clientX - gesture.startClientX);
    const pointerHeight = Math.abs(clientY - gesture.startClientY);
    if (!gesture.moved && pointerWidth < 4 && pointerHeight < 4) {
      return;
    }
    gesture.moved = true;
    const rootRect = gesture.root.getBoundingClientRect();
    const geometry = calculateWorkspaceSelectionGeometry({
      rootLeft: rootRect.left,
      rootTop: rootRect.top,
      scrollLeft: gesture.root.scrollLeft,
      scrollTop: gesture.root.scrollTop,
      startContentX: gesture.startContentX,
      startContentY: gesture.startContentY,
      clientX,
      clientY,
    });
    const { left, top, width, height } = geometry.contentBox;
    const selectionRect = new DOMRect(
      geometry.viewportBox.left,
      geometry.viewportBox.top,
      geometry.viewportBox.width,
      geometry.viewportBox.height,
    );
    setSelectionBox({ viewMode: gesture.viewMode, left, top, width, height });
    if (width < 8 && height < 8) {
      writeClientLog(
        "debug",
        `框选进入拖动：${gesture.viewMode}，视口 (${Math.round(geometry.viewportBox.left)}, ${Math.round(geometry.viewportBox.top)})，内容坐标 (${Math.round(left)}, ${Math.round(top)})，尺寸 ${Math.round(width)}×${Math.round(height)}`,
      );
    }
    const intersectingPaths = selectionPathsIntersecting(gesture.root, selectionRect);
    if (gesture.hasAutoScrolled) {
      intersectingPaths.forEach((path) => gesture.intersectedPaths.add(path));
    } else {
      gesture.intersectedPaths = intersectingPaths;
    }
    const nextSelection = gesture.additive ? new Set(gesture.initialSelection) : new Set<string>();
    gesture.intersectedPaths.forEach((path) => nextSelection.add(path));
    setSelectedFiles(nextSelection);
    const nextAnchor = files.find((file) => gesture.intersectedPaths.has(file.path))?.path;
    if (nextAnchor) {
      setSelectionAnchor(nextAnchor);
    } else if (nextSelection.size === 0) {
      setSelectionAnchor(null);
    }
  };

  const updateAutoScroll = (gesture: WorkspaceSelectionGesture) => {
    const edgeSize = 56;
    const rootRect = gesture.root.getBoundingClientRect();
    let scrollStep = 0;
    if (gesture.lastClientY <= rootRect.top + edgeSize) {
      const proximity = Math.min(1, (rootRect.top + edgeSize - gesture.lastClientY) / edgeSize);
      scrollStep = -Math.ceil(5 + proximity * 19);
    } else if (gesture.lastClientY >= rootRect.bottom - edgeSize) {
      const proximity = Math.min(1, (gesture.lastClientY - (rootRect.bottom - edgeSize)) / edgeSize);
      scrollStep = Math.ceil(5 + proximity * 19);
    }
    if (scrollStep === 0) {
      stopAutoScroll();
      return;
    }
    if (selectionAutoScrollFrame.current !== null) {
      return;
    }
    const tick = () => {
      selectionAutoScrollFrame.current = null;
      const activeGesture = selectionGesture.current;
      if (!activeGesture || activeGesture !== gesture) {
        return;
      }
      const previousScrollTop = activeGesture.root.scrollTop;
      activeGesture.root.scrollTop = Math.max(0, previousScrollTop + scrollStep);
      if (activeGesture.root.scrollTop === previousScrollTop) {
        return;
      }
      if (!activeGesture.hasAutoScrolled) {
        activeGesture.hasAutoScrolled = true;
        writeClientLog("debug", `框选自动滚动开始：${activeGesture.viewMode}，方向 ${scrollStep > 0 ? "向下" : "向上"}`);
      }
      applyRectangleSelection(activeGesture, activeGesture.lastClientX, activeGesture.lastClientY);
      updateAutoScroll(activeGesture);
    };
    selectionAutoScrollFrame.current = window.requestAnimationFrame(tick);
  };

  const startRectangleSelection = (event: ReactPointerEvent<HTMLDivElement>, mode: ViewMode) => {
    if (event.button !== 0 || !hasWorkspace || files.length === 0) {
      return;
    }
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(".file-card, .file-list-row, .file-list-header, input, button, select, a, [contenteditable='true']")
    ) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const rootRect = event.currentTarget.getBoundingClientRect();
    writeClientLog(
      "debug",
      `开始框选：${mode}，鼠标 (${event.clientX}, ${event.clientY})，容器 (${Math.round(rootRect.left)}, ${Math.round(rootRect.top)})，滚动 (${Math.round(event.currentTarget.scrollLeft)}, ${Math.round(event.currentTarget.scrollTop)})`,
    );
    selectionGesture.current = {
      viewMode: mode,
      pointerId: event.pointerId,
      root: event.currentTarget,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startContentX: event.clientX - rootRect.left + event.currentTarget.scrollLeft,
      startContentY: event.clientY - rootRect.top + event.currentTarget.scrollTop,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      initialSelection: new Set(selectedFiles),
      intersectedPaths: new Set(),
      additive: event.ctrlKey || event.metaKey || event.shiftKey,
      moved: false,
      hasAutoScrolled: false,
    };
  };

  const updateRectangleSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = selectionGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }
    gesture.lastClientX = event.clientX;
    gesture.lastClientY = event.clientY;
    applyRectangleSelection(gesture, event.clientX, event.clientY);
    updateAutoScroll(gesture);
  };

  const finishRectangleSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = selectionGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }
    stopAutoScroll();
    selectionGesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setSelectionBox(null);
    if (gesture.moved) {
      suppressBackgroundClear.current = true;
      window.setTimeout(() => {
        suppressBackgroundClear.current = false;
      }, 0);
      writeClientLog("debug", `完成框选：${gesture.viewMode}，当前选中 ${selectedFiles.size} 个文件`);
    } else {
      clearSelection();
    }
  };

  const startFileDrag = (event: ReactPointerEvent<HTMLDivElement>, path: string) => {
    if (event.button !== 0 || renamingPath === path) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    fileDragGesture.current = {
      pointerId: event.pointerId,
      root: event.currentTarget,
      startClientX: event.clientX,
      startClientY: event.clientY,
      paths: selectedFiles.has(path) ? [...selectedFiles] : [path],
      started: false,
    };
    writeClientLog(
      "debug",
      `准备文件拖出：候选 ${selectedFiles.has(path) ? selectedFiles.size : 1} 个，起点 (${event.clientX}, ${event.clientY})，路径 ${path}`,
    );
  };

  const updateFileDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = fileDragGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.started) {
      return;
    }
    const distance = Math.hypot(event.clientX - gesture.startClientX, event.clientY - gesture.startClientY);
    if (distance < 7) {
      return;
    }
    gesture.started = true;
    event.preventDefault();
    event.stopPropagation();
    if (gesture.root.hasPointerCapture(event.pointerId)) {
      gesture.root.releasePointerCapture(event.pointerId);
    }
    setSelectedFiles(new Set(gesture.paths));
    setSelectionAnchor(gesture.paths[0] ?? null);
    writeClientLog(
      "debug",
      `达到文件拖出阈值：${gesture.paths.length} 个，位移 ${Math.round(distance)}px，调用后端 OLE 拖放`,
    );
    void invoke("start_file_drag", { paths: gesture.paths })
      .then(() => writeClientLog("debug", "后端 OLE 拖放会话结束"))
      .catch((dragError: unknown) => {
        const message = errorMessage(dragError);
        notify(message);
        writeClientLog("warn", `无法开始或完成文件拖出：${message}`);
      });
  };

  const finishFileDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = fileDragGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }
    fileDragGesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  useEffect(() => () => stopAutoScroll(), []);

  return {
    selectionBox,
    selectFile,
    clearSelection,
    clearSelectionFromBackground,
    startRectangleSelection,
    updateRectangleSelection,
    finishRectangleSelection,
    startFileDrag,
    updateFileDrag,
    finishFileDrag,
  };
}
