import { invoke } from "@tauri-apps/api/core";
import type { DirectoryItem, Preferences } from "../app-types";

export type MobilePreferences = Pick<Preferences, "appearance" | "accentTheme" | "codeTheme" | "autoplay" | "volume" | "muted" | "rememberWorkspaceFocus" | "showHiddenItems" | "showNomediaMedia" | "backgroundImage" | "backgroundOpacity" | "backgroundBlur" | "imageMaxMegabytes" | "imageMaxMegapixels" | "thumbnailCapturePosition" | "textPreviewLatinFont" | "textPreviewCjkFont" | "textLanguageMap" | "videoExtensions" | "audioExtensions" | "imageExtensions" | "textExtensions"> & { trashEnabled: boolean; thumbnailCacheMb: number; holdPlaybackSpeed: number };
export type StorageState = { granted: boolean; root: string; notifications: boolean; preferences: MobilePreferences };
export type MediaState = { path: string | null; state: number; playing: boolean; position: number; duration: number; error: string | null; controlsEmbedded: boolean };
export type TaskRequest = { operation: string; paths?: string[]; destination?: string; name?: string; confirmed?: boolean; trashId?: string; trashIds?: string[] };
export type TaskItem = { source: string; name?: string; originalPath?: string; destination?: string; stage: string; trashId?: string };
export type MobileTask = { id: string; operation: string; state: string; items: TaskItem[]; totalItems: number; completedItems: number; transferredBytes: number; error?: string; revision: number; currentIndex?: number };
export type TrashItem = { id: string; name: string; originalPath: string; recycledAt: number; directory: boolean; size: number | null };
export const mobileCall = <T,>(command: string, payload: Record<string, unknown> = {}) => invoke<T>("mobile_call", { command, payload });

/** POSIX paths keep their leading slash and case. Never apply the desktop drive-letter rules. */
export function parentPath(path: string, root: string): string | null {
  const normalized = path.replace(/\/+$/, "");
  if (normalized === root.replace(/\/+$/, "")) return null;
  const parent = normalized.slice(0, normalized.lastIndexOf("/"));
  return parent === root || parent.startsWith(`${root}/`) ? parent : null;
}

export function breadcrumbs(path: string, root: string) {
  const parts = path.slice(root.length).split("/").filter(Boolean);
  return [{ name: "内部存储", path: root }, ...parts.map((name, index) => ({ name, path: `${root}/${parts.slice(0, index + 1).join("/")}` }))];
}

export function nextFile(items: DirectoryItem[], removed: Set<string>, selected: string): string | null {
  const files = items.filter((item) => item.entryType === "file");
  const index = files.findIndex((file) => file.path === selected);
  return files.slice(index + 1).find((file) => !removed.has(file.path))?.path
    ?? files.slice(0, index).reverse().find((file) => !removed.has(file.path))?.path ?? null;
}

export const taskLabels: Record<string, string> = { copy: "复制", move: "移动", rename: "重命名", trash: "移入回收站", delete: "永久删除", restore: "恢复", purge: "彻底删除" };
export const stateLabels: Record<string, string> = { queued: "等待中", running: "执行中", completed: "已完成", cancelled: "已取消", interrupted: "已中断", failed: "失败" };
