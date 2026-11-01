import { writeClientLog } from "../app-utils";

export type FavoritePath = { name: string; path: string };
export type WorkspaceMemory = { selected: string | null; sort: string; grid: boolean; scrollTop: number };
const memoryKey = "mobile.workspaces";

export function readFavorites(): FavoritePath[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem("mobile.favorites") ?? "[]");
    if (!Array.isArray(saved)) return [];
    const unique = new Map<string, FavoritePath>();
    for (const entry of saved) {
      // Migrate the original array of paths without losing existing favorites.
      const path = typeof entry === "string" ? entry : entry?.path;
      if (typeof path !== "string" || !path.startsWith("/")) continue;
      unique.set(path, { path, name: typeof entry?.name === "string" && entry.name.trim() ? entry.name.trim() : path.split("/").filter(Boolean).at(-1) ?? "内部存储" });
    }
    return [...unique.values()];
  } catch (error) { writeClientLog("warn", `读取手机喜好路径失败：${String(error)}`); return []; }
}

export function readWorkspaces(): Record<string, WorkspaceMemory> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(memoryKey) ?? "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).filter(([path, value]) => path.startsWith("/") && value && typeof value === "object" && ["name", "modified", "size"].includes(value.sort) && typeof value.grid === "boolean" && (value.selected === null || typeof value.selected === "string") && Number.isFinite(value.scrollTop) && value.scrollTop >= 0));
  } catch (error) { writeClientLog("warn", `读取手机目录记忆失败：${String(error)}`); return {}; }
}

export function saveWorkspaces(memories: Record<string, WorkspaceMemory>) {
  try { localStorage.setItem(memoryKey, JSON.stringify(memories)); }
  catch (error) { writeClientLog("error", `持久化手机目录记忆失败：${String(error)}`); }
}

export function clearWorkspaceMemory() {
  for (const key of [memoryKey, "mobile.lastPath", "mobile.selected", "mobile.sort", "mobile.grid"]) localStorage.removeItem(key);
}
