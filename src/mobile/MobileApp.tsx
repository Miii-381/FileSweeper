import { invoke } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowUp, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, Crosshair, Folder, FolderOpen, Grid2X2, List, Maximize2, Menu, Minimize2, MoreHorizontal, Pencil, RefreshCw, Search, Settings, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { DirectoryItem, FileEntry, WorkspaceListing } from "../app-types";
import { errorMessage, formatBytes, writeClientLog } from "../app-utils";
import { colorModeTokens, themePresets } from "../theme";
import { MobileMediaControls, MobilePreview } from "./MobilePreview";
import { MobileSettings } from "./MobileSettings";
import { MobileTasks } from "./MobileTasks";
import { MobileTrash } from "./MobileTrash";
import { MobileLocations } from "./MobileLocations";
import { clearWorkspaceMemory, readFavorites, readWorkspaces, saveWorkspaces } from "./mobile-workspace";
import { breadcrumbs, mobileCall, nextFile, parentPath, stateLabels, taskLabels, type MobilePreferences, type MobileTask, type StorageState, type TaskRequest } from "./mobile-api";
import "./mobile.css";

type Modal = "locations" | "settings" | "actions" | "rename" | "tasks" | "trash" | "confirm" | null;
type Picker = { request: TaskRequest; path: string } | null;

function Sheet({ title, close, back, children, className = "" }: { title: string; close: () => void; back?: () => void; children: ReactNode; className?: string }) {
  return <div className="mobile-backdrop" onClick={close}><section className={`mobile-sheet ${className}`} role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
    <header><div className="mobile-sheet-title">{back && <button aria-label="返回设置" onClick={back}><ChevronLeft size={22} /></button>}<h2>{title}</h2></div><button aria-label="关闭" onClick={close}><X size={22} /></button></header>{children}
  </section></div>;
}

function Thumbnail({ item, revision }: { item: DirectoryItem; revision: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (item.entryType === "file" && ["image", "video", "audio"].includes(item.kind)) {
      void mobileCall<{ path: string | null }>("thumbnail", { path: item.path }).then(async ({ path }) => {
        if (path && active) { const source = await invoke<string>("get_preview_file_url", { path }); if (active) setUrl(source); }
      }).catch((reason) => writeClientLog("debug", `手机缩略图不可用：${item.path}，${errorMessage(reason)}`));
    }
    return () => { active = false; };
  }, [item.path, item.modifiedAt, revision]);
  return url ? <img className="mobile-thumbnail" src={url} alt="" /> : <span className={`mobile-file-symbol ${item.entryType}`}>
    {item.entryType === "folder" ? <Folder size={30} /> : <span>{item.extension.slice(1).toUpperCase().slice(0, 5) || "FILE"}</span>}
  </span>;
}

function DirectoryPicker({ root, initial, choose, close }: { root: string; initial: Picker & {}; choose: (path: string) => void; close: () => void }) {
  const [path, setPath] = useState(initial.path);
  const [folders, setFolders] = useState<DirectoryItem[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true; setError(""); setFolders([]);
    void mobileCall<WorkspaceListing>("listDirectory", { path }).then((data) => { if (active) setFolders(data.items.filter((item) => item.entryType === "folder").sort((a,b) => a.name.localeCompare(b.name))); }).catch((reason) => active && setError(errorMessage(reason)));
    return () => { active = false; };
  }, [path]);
  return <Sheet title={initial.request.operation === "favorite" ? "选择喜好目录" : `选择${taskLabels[initial.request.operation]}目标`} close={close}>
    <p className="mobile-path">{path}</p>
    <button className="mobile-menu-row" disabled={!parentPath(path, root)} onClick={() => setPath(parentPath(path, root)!)}><ArrowUp size={18} />上一级</button>
    <div className="mobile-picker-list">{error && <p role="alert">{error}</p>}{folders.map((folder) => <button className="mobile-menu-row" key={folder.path} onClick={() => setPath(folder.path)}><Folder size={20} /><span>{folder.name}</span><ChevronRight size={16} /></button>)}</div>
    <button className="mobile-primary" disabled={!!error} onClick={() => choose(path)}>选择此目录</button>
  </Sheet>;
}

export default function MobileApp() {
  const [storage, setStorage] = useState<StorageState | null>(null);
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(() => localStorage.getItem("mobile.previewOpen") !== "false");
  const [ratio, setRatio] = useState(() => Math.min(75, Math.max(20, Number(localStorage.getItem("mobile.ratio")) || 40)));
  const [fullscreen, setFullscreen] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [actionItem, setActionItem] = useState<DirectoryItem | null>(null);
  const [rename, setRename] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState(() => localStorage.getItem("mobile.sort") ?? "name");
  const [grid, setGrid] = useState(() => localStorage.getItem("mobile.grid") === "true");
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null);
  const [backgroundRevision, setBackgroundRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [tasks, setTasks] = useState<MobileTask[]>([]);
  const [confirmation, setConfirmation] = useState<TaskRequest | null>(null);
  const [picker, setPicker] = useState<Picker>(null);
  const [multi, setMulti] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [favorites, setFavorites] = useState(readFavorites);
  const [chosenFavorite, setChosenFavorite] = useState<{ path: string } | null>(null);
  const history = useRef<string[]>([]);
  const generation = useRef(0);
  const scroll = useRef<HTMLDivElement>(null);
  const split = useRef<HTMLDivElement>(null);
  const workspaces = useRef(readWorkspaces());
  const pendingScroll = useRef<{ path: string; offset: number; selected: string | null } | null>(null);
  const longPress = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number; fired: boolean } | null>(null);
  const tracked = useRef(new Map<string, { order: DirectoryItem[]; processed: Set<number> }>());
  const observedTasks = useRef<Set<string> | null>(null);
  const latest = useRef({ listing, selected, sort, grid }); latest.current = { listing, selected, sort, grid };
  const saveQueue = useRef(Promise.resolve());
  const preferences = storage?.preferences;
  const preferenceRef = useRef(preferences); preferenceRef.current = preferences;
  const savedFocus = useRef(localStorage.getItem("mobile.selected"));

  const savePreferences = useCallback((patch: Partial<MobilePreferences>) => {
    // Serialize edits from sliders and switches so a slower reply cannot undo a newer edit.
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        const result = await mobileCall<MobilePreferences>("savePreferences", patch);
        setStorage((previous) => previous ? { ...previous, preferences: result } : previous);
      } catch (reason) { setToast(errorMessage(reason)); writeClientLog("warn", `手机设置保存失败：${errorMessage(reason)}`); }
    });
    return saveQueue.current;
  }, []);
  const backgroundImported = (result: MobilePreferences) => {
    setStorage((previous) => previous ? { ...previous, preferences: result } : previous);
    setBackgroundRevision((value) => value + 1);
    notify("背景图片已导入");
  };

  const notify = useCallback((message: string) => { setToast(message); writeClientLog("info", `手机界面：${message}`); }, []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 4000); return () => clearTimeout(timer); }, [toast]);
  const openDirectory = useCallback(async (path: string, remember = true) => {
    const request = ++generation.current;
    const current = latest.current;
    const previous = current.listing?.path;
    if (previous && preferenceRef.current?.rememberWorkspaceFocus) {
      workspaces.current[previous] = { selected: current.selected, sort: current.sort, grid: current.grid, scrollTop: scroll.current?.scrollTop ?? 0 };
      saveWorkspaces(workspaces.current);
    }
    setBusy(true); setError(null);
    try {
      const data = await mobileCall<WorkspaceListing>("listDirectory", { path });
      if (request !== generation.current) return;
      if (remember && previous && previous !== path) history.current.push(previous);
      const memory = preferenceRef.current?.rememberWorkspaceFocus ? workspaces.current[data.path] : undefined;
      const saved = previous === data.path ? current.selected : memory ? memory.selected : (localStorage.getItem("mobile.lastPath") === data.path ? savedFocus.current : null);
      const restored = (previous === data.path || preferenceRef.current?.rememberWorkspaceFocus) && data.items.some((item) => item.entryType === "file" && item.path === saved) ? saved : null;
      setListing(data); setQuery(""); setChecked(new Set()); setMulti(false);
      setSelected(restored);
      if (previous !== data.path) {
        setSort(memory?.sort ?? "name"); setGrid(memory?.grid ?? false);
      }
      pendingScroll.current = { path: data.path, offset: memory?.scrollTop ?? 0, selected: restored };
      writeClientLog("info", `手机目录焦点恢复：目录 ${data.path}，文件 ${restored ?? "无"}，排序 ${memory?.sort ?? "name"}，滚动 ${memory?.scrollTop ?? 0}`);
    } catch (reason) { if (request === generation.current) setError(errorMessage(reason)); }
    finally { if (request === generation.current) setBusy(false); }
  }, []);

  useEffect(() => {
    const refresh = () => { void mobileCall<StorageState>("storageState").then(setStorage).catch((reason) => setError(errorMessage(reason))); };
    refresh(); window.addEventListener("mobile-resume", refresh);
    return () => window.removeEventListener("mobile-resume", refresh);
  }, []);
  useEffect(() => {
    if (storage?.granted && !latest.current.listing) {
      const saved = storage.preferences.rememberWorkspaceFocus ? localStorage.getItem("mobile.lastPath") : null;
      void openDirectory(saved && (saved === storage.root || saved.startsWith(`${storage.root}/`)) ? saved : storage.root);
    }
  }, [storage?.granted, storage?.root, openDirectory]);
  useEffect(() => { localStorage.setItem("mobile.previewOpen", String(previewOpen)); }, [previewOpen]);
  useEffect(() => { localStorage.setItem("mobile.ratio", String(ratio)); }, [ratio]);
  useEffect(() => { localStorage.setItem("mobile.favorites", JSON.stringify(favorites)); }, [favorites]);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!preferences) return;
    if (!preferences.rememberWorkspaceFocus) {
      clearWorkspaceMemory(); workspaces.current = {};
      return;
    }
    if (!listing) return;
    workspaces.current[listing.path] = { selected, sort, grid, scrollTop: workspaces.current[listing.path]?.scrollTop ?? 0 };
    saveWorkspaces(workspaces.current);
    localStorage.setItem("mobile.lastPath", listing.path);
    if (selected) localStorage.setItem("mobile.selected", selected); else localStorage.removeItem("mobile.selected");
    localStorage.setItem("mobile.sort", sort); localStorage.setItem("mobile.grid", String(grid));
  }, [preferences?.rememberWorkspaceFocus, selected, listing?.path, sort, grid]);
  useEffect(() => {
    let active = true; setBackgroundUrl(null);
    if (preferences?.backgroundImage) void mobileCall<{ path: string | null }>("background").then(async ({ path }) => {
      if (path) { const url = await invoke<string>("get_preview_file_url", { path }); if (active) setBackgroundUrl(`${url}?v=${backgroundRevision}`); }
    }).catch((reason) => writeClientLog("warn", `手机背景加载失败：${errorMessage(reason)}`));
    return () => { active = false; };
  }, [preferences?.backgroundImage, backgroundRevision]);
  useEffect(() => {
    if (latest.current.listing) void openDirectory(latest.current.listing.path, false);
  }, [preferences?.showHiddenItems, preferences?.showNomediaMedia, JSON.stringify(preferences?.videoExtensions), JSON.stringify(preferences?.audioExtensions), JSON.stringify(preferences?.imageExtensions), JSON.stringify(preferences?.textExtensions), openDirectory]);
  useEffect(() => { void mobileCall("setFullscreen", { fullscreen }).catch((reason) => writeClientLog("warn", errorMessage(reason))); }, [fullscreen]);

  const ordered = useMemo(() => [...(listing?.items ?? [])].filter((item) => item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a,b) => {
    if (a.entryType !== b.entryType) return a.entryType === "folder" ? -1 : 1;
    if (sort === "modified") return (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0);
    if (sort === "size") return (b.entryType === "file" ? b.size : 0) - (a.entryType === "file" ? a.size : 0);
    return a.name.localeCompare(b.name, "zh-CN", { numeric: true });
  }), [listing, query, sort]);
  const selectedFile = listing?.items.find((item): item is FileEntry & { entryType: "file" } => item.entryType === "file" && item.path === selected) ?? null;
  const fileOrder = ordered.filter((item) => item.entryType === "file");
  const latestOrder = useRef(ordered); latestOrder.current = ordered;
  const fileIndex = fileOrder.findIndex((item) => item.path === selected);
  const columns = grid ? 2 : 1;
  const virtual = useVirtualizer({ count: Math.ceil(ordered.length / columns), getScrollElement: () => scroll.current, estimateSize: () => grid ? 152 : 68, overscan: 4 });
  useEffect(() => {
    const target = pendingScroll.current;
    if (!target || target.path !== listing?.path) return;
    const frame = requestAnimationFrame(() => {
      if (!scroll.current || target.path !== latest.current.listing?.path) return;
      scroll.current.scrollTop = target.offset;
      const index = ordered.findIndex((item) => item.path === target.selected);
      if (index >= 0) {
        const height = grid ? 152 : 68;
        const top = Math.floor(index / columns) * height;
        if (top < scroll.current.scrollTop || top + height > scroll.current.scrollTop + scroll.current.clientHeight) scroll.current.scrollTop = Math.max(0, top - (scroll.current.clientHeight - height) / 2);
      }
      pendingScroll.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [listing?.path, ordered, grid, columns]);
  useEffect(() => {
    const saveScroll = () => {
      const path = latest.current.listing?.path;
      if (!path || !preferenceRef.current?.rememberWorkspaceFocus || !scroll.current || !workspaces.current[path]) return;
      workspaces.current[path].scrollTop = scroll.current.scrollTop; saveWorkspaces(workspaces.current);
    };
    const element = scroll.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout>;
    const changed = () => { clearTimeout(timer); timer = setTimeout(saveScroll, 180); };
    element.addEventListener("scroll", changed);
    const flush = () => { clearTimeout(timer); saveScroll(); };
    window.addEventListener("pagehide", flush); document.addEventListener("visibilitychange", flush);
    return () => { clearTimeout(timer); element.removeEventListener("scroll", changed); window.removeEventListener("pagehide", flush); document.removeEventListener("visibilitychange", flush); };
  }, [storage?.granted, fullscreen]);
  const activeTasks = tasks.filter((task) => ["queued", "running"].includes(task.state));
  const jumpToFocus = () => {
    if (!listing || !selectedFile) return;
    if (query) {
      pendingScroll.current = { path: listing.path, offset: scroll.current?.scrollTop ?? 0, selected: selectedFile.path };
      setQuery("");
    } else {
      const index = ordered.findIndex((item) => item.path === selectedFile.path);
      if (index >= 0) virtual.scrollToIndex(Math.floor(index / columns), { align: "center" });
    }
    writeClientLog("info", `跳转手机文件焦点：${selectedFile.path}，清除搜索=${Boolean(query)}`);
  };
  const editingSelected = activeTasks.some((task) => task.operation !== "copy" && task.items.some((item) => item.source === selected));

  useEffect(() => {
    let active = true;
    let polling = false;
    const poll = async () => {
      if (document.visibilityState === "hidden" || polling) return;
      polling = true;
      try {
        const result = await mobileCall<{ tasks: MobileTask[] }>("tasks");
        if (!active) return;
        setTasks(result.tasks);
        const initial = observedTasks.current === null;
        observedTasks.current ??= new Set();
        for (const task of result.tasks) {
          // Native/script tasks follow the same refresh path as tasks started by the UI.
          // Existing finished history is only a baseline, never replayed on startup.
          if (!observedTasks.current.has(task.id)) {
            observedTasks.current.add(task.id);
            if (!tracked.current.has(task.id) && (!initial || ["queued", "running"].includes(task.state))) {
              tracked.current.set(task.id, { order: latestOrder.current, processed: new Set() });
              writeClientLog("info", `跟踪原生文件任务：${task.id}，操作 ${task.operation}，状态 ${task.state}`);
            }
          }
          const context = tracked.current.get(task.id);
          if (!context) continue;
          const newlyCompleted = task.items.filter((item, index) => {
            if (item.stage !== "completed" || context.processed.has(index)) return false;
            context.processed.add(index); return true;
          });
          // A batch may finish hundreds of items between polls. Refresh once per task,
          // and skip purge because removing trash payloads does not change this directory.
          if (newlyCompleted.length && task.operation !== "purge") {
            const current = latest.current;
            if (current.listing) {
              const fresh = await mobileCall<WorkspaceListing>("listDirectory", { path: current.listing.path });
              if (active && latest.current.listing?.path === fresh.path) {
                setListing(fresh);
                const selectedItem = newlyCompleted.find((item) => latest.current.selected === item.source);
                if (selectedItem) {
                  if (task.operation === "rename") setSelected(selectedItem.destination ?? null);
                  else if (["move", "trash", "delete"].includes(task.operation)) {
                    const remaining = new Set(fresh.items.filter((item) => item.entryType === "file").map((item) => item.path));
                    const missing = new Set(context.order.filter((item) => !remaining.has(item.path)).map((item) => item.path));
                    setSelected(nextFile(context.order, missing, selectedItem.source));
                    writeClientLog("info", `任务后清理旧预览：${task.id}，文件 ${selectedItem.source}`);
                  }
                }
              }
            }
          }
          if (!["queued", "running"].includes(task.state)) {
            tracked.current.delete(task.id); notify(task.state === "completed" ? `${taskLabels[task.operation]}完成` : task.error ?? stateLabels[task.state]);
          }
        }
      } catch (reason) { writeClientLog("warn", `读取手机任务失败：${errorMessage(reason)}`); }
      finally { polling = false; }
    };
    void poll(); const timer = setInterval(() => void poll(), 1000);
    return () => { active = false; clearInterval(timer); };
  }, [notify]);

  const startTask = async (request: TaskRequest, keepTrash = false) => {
    setModal(keepTrash ? "trash" : null); setPicker(null); setConfirmation(null);
    try {
      const task = await mobileCall<MobileTask>("startTask", request);
      tracked.current.set(task.id, { order: ordered, processed: new Set() });
      setTasks((previous) => [task, ...previous.filter((item) => item.id !== task.id)]);
      if (!storage?.notifications) notify("任务已开始；请允许通知权限以显示通知栏进度");
      return task;
    } catch (reason) { notify(errorMessage(reason)); return null; }
  };
  const closePicker = useCallback(() => { if (picker?.request.trashIds) setModal("trash"); setPicker(null); }, [picker]);
  const showTasks = () => { writeClientLog("info", "从设置进入文件任务"); setModal("tasks"); };
  const backToSettings = () => { writeClientLog("info", "从文件任务返回设置"); setModal("settings"); };
  const cancelTask = async (task: MobileTask) => {
    try { await mobileCall("cancelTask", { id: task.id }); notify("已请求取消任务"); }
    catch (reason) { notify(errorMessage(reason)); }
  };
  const retryTask = async (task: MobileTask) => {
    if (["delete", "purge"].includes(task.operation) && !window.confirm("重新执行将永久删除剩余内容，是否继续？")) return;
    writeClientLog("info", `请求重新执行文件任务：${task.id}，操作 ${task.operation}，原状态 ${task.state}`);
    try {
      const result = await mobileCall<MobileTask>("resumeTask", { id: task.id });
      tracked.current.set(result.id, { order: latestOrder.current, processed: new Set(result.items.map((item, index) => item.stage === "completed" ? index : -1)) });
      setTasks((previous) => previous.map((entry) => entry.id === result.id ? result : entry));
      notify("任务已重新排队");
    } catch (reason) { notify(errorMessage(reason)); }
  };
  const toggleFullscreen = () => { setPreviewOpen(true); setFullscreen((previous) => !previous); };
  const navigateBack = useCallback(() => {
    if (picker) { closePicker(); return; }
    if (modal === "tasks") { writeClientLog("info", "系统返回：从文件任务返回设置"); setModal("settings"); return; }
    if (modal) { setModal(null); return; }
    if (multi) { setMulti(false); setChecked(new Set()); return; }
    if (fullscreen) { setFullscreen(false); return; }
    const previous = history.current.pop();
    if (previous) void openDirectory(previous, false);
    else void mobileCall("finish");
  }, [picker, modal, multi, fullscreen, openDirectory, closePicker]);
  useEffect(() => { const back = () => navigateBack(); window.addEventListener("mobile-back", back); return () => window.removeEventListener("mobile-back", back); }, [navigateBack]);
  useEffect(() => () => { if (longPress.current) clearTimeout(longPress.current.timer); }, []);

  const actions = (item: DirectoryItem) => { setActionItem(item); setModal("actions"); };
  const cancelPress = () => { if (longPress.current) clearTimeout(longPress.current.timer); };
  const press = (event: ReactPointerEvent, item: DirectoryItem) => {
    if (event.button !== 0 || multi) return;
    cancelPress();
    longPress.current = { x: event.clientX, y: event.clientY, fired: false, timer: setTimeout(() => {
      if (longPress.current) longPress.current.fired = true;
      actions(item);
    }, 450) };
  };
  const clickItem = (item: DirectoryItem) => {
    if (longPress.current?.fired) { longPress.current = null; return; }
    if (multi) setChecked((previous) => { const next = new Set(previous); if (next.has(item.path)) next.delete(item.path); else next.add(item.path); return next; });
    else if (item.entryType === "folder") void openDirectory(item.path);
    else setSelected(item.path);
  };
  const confirmDelete = (paths: string[]) => {
    if (storage?.preferences.trashEnabled) void startTask({ operation: "trash", paths });
    else { setConfirmation({ operation: "delete", paths, confirmed: true }); setModal("confirm"); }
  };
  const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const mode = preferences?.appearance === "system" ? (systemDark ? "dark" : "light") : preferences?.appearance ?? "dark";
  const theme = themePresets.find((item) => item.id === preferences?.accentTheme) ?? themePresets[0];
  const appStyle = { ...colorModeTokens[mode], colorScheme: mode, "--danger-text": mode === "dark" ? "#ffb4ab" : "#a83a2f", "--danger-soft": mode === "dark" ? "#442923" : "#ffebe7", "--accent": theme.color, "--accent-color": theme.color, "--accent-soft": mode === "dark" ? theme.soft : theme.lightDeep, "--accent-ink": theme.ink, "--mobile-border": "var(--border-subtle)", "--wallpaper-opacity": (preferences?.backgroundOpacity ?? 30) / 100, "--wallpaper-blur": `${(preferences?.backgroundBlur ?? 0) * .2}px` } as CSSProperties;
  if (!storage) return <main className="mobile-app mobile-loading" style={appStyle}><FolderOpen size={38} /><p>{error ?? "正在启动 FileSweeper…"}</p></main>;
  if (!storage.granted) return <main className="mobile-app mobile-permission" style={colorModeTokens.dark}>
    <FolderOpen size={50} /><h1>让文件整理更顺手</h1><p>授权访问手机内置存储后，即可逐个预览、确认并整理文件。</p>
    <button className="mobile-primary" onClick={() => void mobileCall("requestStorage").catch((reason) => setError(errorMessage(reason)))}>授予文件访问权限</button>
    <button onClick={() => void mobileCall<StorageState>("storageState").then(setStorage)}>我已授权，重新检查</button>
    {error && <p role="alert">{error}</p>}<small>文件在本机处理</small>
  </main>;

  return <main className={`mobile-app ${fullscreen ? "is-fullscreen" : ""}`} style={appStyle}>
    {backgroundUrl && <div className="mobile-wallpaper" aria-hidden="true" style={{ backgroundImage: `url("${backgroundUrl}")` }} />}
    {!fullscreen && <header className="mobile-topbar"><button aria-label="打开位置" onClick={() => setModal("locations")}><Menu size={23} /></button><strong>FileSweeper<small>文件确认工作台</small></strong><button aria-label="跳转到当前焦点" disabled={!selectedFile || busy} onClick={jumpToFocus}><Crosshair size={21} /></button><button aria-label="删除当前焦点文件" disabled={!selectedFile || editingSelected || busy} onClick={() => selectedFile && confirmDelete([selectedFile.path])}><Trash2 size={21} /></button><button aria-label="设置" onClick={() => setModal("settings")}><Settings size={21} /></button></header>}
    <div className="mobile-split" ref={split}>
      <section className={`mobile-preview ${previewOpen ? "" : "is-collapsed"}`} style={!fullscreen && previewOpen ? { height: `${ratio}%` } : undefined}>
        <div className="mobile-preview-heading"><button aria-label={previewOpen ? "收起预览" : "展开预览"} onClick={() => { if (fullscreen) setFullscreen(false); setPreviewOpen((value) => !value); }}>{previewOpen ? <ChevronUp size={20} /> : <ChevronDown size={20} />}</button><span>{selectedFile?.name ?? "文件预览"}</span>
          {previewOpen && <><button aria-label="上一个文件" disabled={fileIndex <= 0} onClick={() => setSelected(fileOrder[fileIndex - 1].path)}><ChevronLeft size={20} /></button><button aria-label="下一个文件" disabled={fileIndex < 0 || fileIndex >= fileOrder.length - 1} onClick={() => setSelected(fileOrder[fileIndex + 1].path)}><ChevronRight size={20} /></button><button aria-label={fullscreen ? "退出全屏" : "全屏预览"} onClick={toggleFullscreen}>{fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button></>}
        </div>
        <div className="mobile-preview-body" hidden={!previewOpen}>{editingSelected ? <div className="mobile-empty">正在处理当前文件…</div> : <MobilePreview file={selectedFile} preferences={storage.preferences} visible={previewOpen && !modal && !picker} />}</div>
        {previewOpen && selectedFile && ["video", "audio"].includes(selectedFile.kind) && !editingSelected && <MobileMediaControls key={selectedFile.path} path={selectedFile.path} preferences={storage.preferences} save={savePreferences} visible={!modal && !picker} />}
      </section>
      {!fullscreen && previewOpen && <div className="mobile-divider" role="separator" aria-label="调整预览高度" aria-orientation="horizontal" tabIndex={0} onPointerDown={resize} onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId) || !split.current) return;
        const rect = split.current.getBoundingClientRect(); setRatio(Math.min(75, Math.max(20, (event.clientY - rect.top) / rect.height * 100)));
      }} onKeyDown={(event) => { if (event.key === "ArrowUp" || event.key === "ArrowDown") setRatio((value) => Math.max(20, Math.min(75, value + (event.key === "ArrowUp" ? -3 : 3)))); }}><span /></div>}
      {!fullscreen && <section className="mobile-workspace">
        <nav className="mobile-breadcrumbs" aria-label="目录路径"><button aria-label="返回上级目录" disabled={!listing || !parentPath(listing.path, storage.root)} onClick={() => listing && void openDirectory(parentPath(listing.path, storage.root)!)}><ArrowUp size={18} /></button>{breadcrumbs(listing?.path ?? storage.root, storage.root).map((crumb) => <button key={crumb.path} onClick={() => void openDirectory(crumb.path)}>{crumb.name}<ChevronRight size={12} /></button>)}</nav>
        <div className="mobile-tools"><label className="mobile-search"><Search size={16} /><input aria-label="搜索当前目录" placeholder="搜索当前目录" value={query} onChange={(event) => setQuery(event.target.value)} /></label><select aria-label="排序" value={sort} onChange={(event) => setSort(event.target.value)}><option value="name">名称</option><option value="modified">最近修改</option><option value="size">大小</option></select><button aria-label={grid ? "列表视图" : "网格视图"} onClick={() => setGrid(!grid)}>{grid ? <List size={19} /> : <Grid2X2 size={19} />}</button><button aria-label="更多文件操作" onClick={() => setMulti(!multi)}><MoreHorizontal size={20} /></button><button aria-label="刷新目录" disabled={busy} onClick={() => listing && void openDirectory(listing.path, false)}><RefreshCw size={18} className={busy ? "mobile-spin" : ""} /></button></div>
        {error && <div className="mobile-inline-error" role="alert">{error}</div>}
        <div className="mobile-file-scroll" ref={scroll} onScroll={cancelPress}>
          {!busy && ordered.length === 0 && <div className="mobile-empty"><FolderOpen size={30} /><p>{query ? "没有匹配的文件" : listing?.mediaSuppressed ? "此目录中的媒体已被 .nomedia 隐藏" : "此目录为空"}</p></div>}
          <div style={{ height: virtual.getTotalSize(), position: "relative", width: "100%" }}>
            {virtual.getVirtualItems().map((row) => <div key={row.key} className={`mobile-file-row ${grid ? "is-grid" : ""}`} style={{ position: "absolute", width: "100%", height: row.size, transform: `translateY(${row.start}px)` }}>
              {ordered.slice(row.index * columns, (row.index + 1) * columns).map((item) => <button key={item.path} className={`mobile-file ${selected === item.path || checked.has(item.path) ? "is-selected" : ""}`} aria-label={item.name} aria-pressed={selected === item.path || checked.has(item.path)} onPointerDown={(event) => press(event, item)} onPointerUp={cancelPress} onPointerCancel={() => { cancelPress(); longPress.current = null; }} onPointerMove={(event) => { const state = longPress.current; if (state && Math.hypot(event.clientX - state.x, event.clientY - state.y) > 9) cancelPress(); }} onContextMenu={(event) => { event.preventDefault(); cancelPress(); actions(item); }} onClick={() => clickItem(item)}>
                <Thumbnail item={item} revision={storage.preferences.thumbnailCapturePosition} /><span className="mobile-file-label"><strong>{item.name}</strong><small>{item.entryType === "folder" ? "文件夹" : `${formatBytes(item.size)} · ${item.extension.slice(1).toUpperCase()}`}</small></span>{multi ? <span className={`mobile-check ${checked.has(item.path) ? "checked" : ""}`}>{checked.has(item.path) && <Check size={15} />}</span> : item.entryType === "folder" ? <ChevronRight size={16} /> : null}
              </button>)}
            </div>)}
          </div>
        </div>
        {multi ? <footer className="mobile-selection-bar"><span>已选 {checked.size} 项</span><button disabled={!checked.size} onClick={() => setPicker({ request: { operation: "copy", paths: [...checked] }, path: listing?.path ?? storage.root })}>复制</button><button disabled={!checked.size} onClick={() => setPicker({ request: { operation: "move", paths: [...checked] }, path: listing?.path ?? storage.root })}>移动</button><button disabled={!checked.size} onClick={() => confirmDelete([...checked])}>删除</button><button onClick={() => { setMulti(false); setChecked(new Set()); }}>完成</button></footer> : <footer className="mobile-status"><span>{busy ? "正在读取…" : `${ordered.length} 个项目`}</span><span>{selectedFile ? formatBytes(selectedFile.size) : "长按文件打开操作菜单"}</span></footer>}
      </section>}
    </div>
    {toast && <div className="mobile-toast" role="status">{toast}</div>}
    {modal === "locations" && <Sheet title="位置" close={() => setModal(null)}><MobileLocations root={storage.root} currentPath={listing?.path ?? storage.root} favorites={favorites} save={setFavorites} chosen={chosenFavorite} open={(path) => { setModal(null); void openDirectory(path); }} openTrash={() => setModal("trash")} browse={(path) => setPicker({ request: { operation: "favorite" }, path })} /></Sheet>}
    {(modal === "settings" || modal === "tasks") && <Sheet title={modal === "tasks" ? "文件任务" : "设置"} className="mobile-settings-sheet" close={modal === "tasks" ? backToSettings : () => setModal(null)} back={modal === "tasks" ? backToSettings : undefined}>
      <div className="mobile-settings-scroll" hidden={modal === "tasks"}>
        <button className="mobile-menu-row mobile-settings-link" aria-label="文件任务" onClick={showTasks}><Copy size={21} /><span>文件任务<small>查看文件明细、执行进度与失败重试</small></span>{activeTasks.length > 0 && <small>{activeTasks.length} 项进行中</small>}<ChevronRight size={16} /></button>
        <MobileSettings preferences={storage.preferences} save={savePreferences} imported={backgroundImported} notify={notify} /><p className="mobile-muted">FileSweeper Android MVP</p>
      </div>
      {modal === "tasks" && <MobileTasks tasks={tasks} cancel={cancelTask} retry={retryTask} />}
    </Sheet>}
    {modal === "actions" && actionItem && <Sheet title={actionItem.name} close={() => setModal(null)}>{actionItem.entryType === "file" && actionItem.kind === "image" && <button className="mobile-menu-row" onClick={() => { setModal(null); void mobileCall<{ preferences: MobilePreferences }>("importBackground", { path: actionItem.path }).then((result) => backgroundImported(result.preferences)).catch((reason) => notify(errorMessage(reason))); }}>设为背景</button>}{actionItem.entryType === "file" && <button className="mobile-menu-row" onClick={() => { setSelected(actionItem.path); setModal(null); void invoke("open_file_externally", { path: actionItem.path }).catch((reason) => notify(errorMessage(reason))); }}><FolderOpen size={20} />使用其他应用打开</button>}<button className="mobile-menu-row" onClick={() => { setRename(actionItem.name); setModal("rename"); }}><Pencil size={20} />重命名</button>{["copy", "move"].map((operation) => <button key={operation} className="mobile-menu-row" onClick={() => { setModal(null); setPicker({ request: { operation, paths: [actionItem.path] }, path: listing?.path ?? storage.root }); }}><Copy size={20} />{taskLabels[operation]}到…</button>)}<button className="mobile-menu-row mobile-danger" onClick={() => confirmDelete([actionItem.path])}><Trash2 size={20} />{storage.preferences.trashEnabled ? "移入回收站" : "永久删除"}</button></Sheet>}
    {modal === "rename" && actionItem && <Sheet title="重命名" close={() => setModal(null)}><form onSubmit={(event) => { event.preventDefault(); void startTask({ operation: "rename", paths: [actionItem.path], name: rename }); }}><input className="mobile-rename" aria-label="新文件名" autoFocus value={rename} onChange={(event) => setRename(event.target.value)} /><button className="mobile-primary" disabled={!rename.trim()} type="submit">保存名称</button></form></Sheet>}
    {modal === "confirm" && confirmation && <Sheet title="确认永久删除" close={() => setModal(null)}><p>将永久删除所选内容，无法通过 FileSweeper 恢复。</p><button className="mobile-primary mobile-danger" onClick={() => void startTask(confirmation)}>永久删除</button><button className="mobile-menu-row" onClick={() => setModal(null)}>取消</button></Sheet>}
    {modal === "trash" && <Sheet title="回收站" className="mobile-trash-sheet" close={() => setModal(null)}><MobileTrash tasks={tasks} grid={grid} setGrid={setGrid} startTask={(request) => startTask(request, true)} chooseDestination={(request) => { setModal(null); setPicker({ request, path: listing?.path ?? storage.root }); }} /></Sheet>}
    {picker && <DirectoryPicker root={storage.root} initial={picker} close={closePicker} choose={(destination) => { if (picker.request.operation === "favorite") { setChosenFavorite({ path: destination }); setPicker(null); } else void startTask({ ...picker.request, destination }, !!picker.request.trashIds); }} />}
  </main>;
}
