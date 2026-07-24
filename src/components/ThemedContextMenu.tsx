import {
  ClipboardCopy,
  ClipboardPaste,
  FolderOpen,
  Play,
  RefreshCw,
  Scissors,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, type KeyboardEvent } from "react";

import type { WorkspaceContextMenu } from "../app-types";
import { writeClientLog } from "../app-utils";

export type ContextMenuAction =
  | "open"
  | "reveal"
  | "copyTo"
  | "clipboardCopy"
  | "clipboardCut"
  | "paste"
  | "delete"
  | "deleteDirectory"
  | "refresh";

export function ThemedContextMenu({
  menu,
  onAction,
  onClose,
}: {
  menu: WorkspaceContextMenu;
  onAction: (action: ContextMenuAction) => void;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]')?.focus();
    writeClientLog("debug", `主题化菜单获得焦点：目标 ${menu.kind}`);
    return () => {
      returnFocus.current?.focus();
      writeClientLog("debug", `主题化菜单关闭并恢复焦点：目标 ${menu.kind}`);
    };
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      writeClientLog("debug", `主题化菜单通过 Escape 关闭：目标 ${menu.kind}`);
      onClose();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    event.preventDefault();
    const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]') ?? [])];
    if (items.length === 0) {
      return;
    }
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = (current + delta + items.length) % items.length;
    items[next]?.focus();
    writeClientLog("debug", `主题化菜单键盘导航：${event.key}，索引 ${current} -> ${next}`);
  };

  const item = (action: ContextMenuAction, icon: React.ReactNode, label: React.ReactNode, danger = false) => (
    <button
      className={danger ? "danger" : undefined}
      type="button"
      role="menuitem"
      onClick={() => onAction(action)}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div
      ref={root}
      className="workspace-context-menu"
      role="menu"
      aria-label="文件菜单"
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={handleKeyDown}
    >
      <div className="workspace-context-menu-title">
        {menu.kind === "directory"
          ? "目录"
          : menu.kind === "files"
            ? `已选择 ${menu.paths.length} 个项目`
            : "当前工作区"}
      </div>
      {menu.kind === "directory" && (
        <>
          {item("open", <FolderOpen size={16} />, "在工作区打开")}
          {item("reveal", <FolderOpen size={16} />, "在资源管理器中显示")}
          {menu.canRecycleDirectory && <>
            <div className="workspace-context-menu-separator" />
            {item("deleteDirectory", <Trash2 size={16} />, "移到回收站", true)}
          </>}
        </>
      )}
      {menu.kind === "files" && (
        <>
          {item("open", <Play size={16} />, "打开")}
          {item("reveal", <FolderOpen size={16} />, "在资源管理器中显示")}
          {item("clipboardCopy", <ClipboardCopy size={16} />, <>复制 <span className="menu-shortcut">Ctrl+C</span></>)}
          {item("clipboardCut", <Scissors size={16} />, <>剪切 <span className="menu-shortcut">Ctrl+X</span></>)}
          {item("copyTo", <FolderOpen size={16} />, "复制到…")}
          <div className="workspace-context-menu-separator" />
          {item("delete", <Trash2 size={16} />, "移到回收站", true)}
        </>
      )}
      {menu.kind === "workspace" && item("reveal", <FolderOpen size={16} />, "在资源管理器中打开")}
      {menu.kind !== "directory" && (
        <>
          {item("paste", <ClipboardPaste size={16} />, <>粘贴 <span className="menu-shortcut">Ctrl+V</span></>)}
          <div className="workspace-context-menu-separator" />
          {item("refresh", <RefreshCw size={16} />, "刷新")}
        </>
      )}
    </div>
  );
}
