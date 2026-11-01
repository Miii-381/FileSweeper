import { Check, Folder, Grid2X2, List, MoreHorizontal, RefreshCw, RotateCcw, Search, Trash2, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { errorMessage, formatBytes, writeClientLog } from "../app-utils";
import { mobileCall, type MobileTask, type TaskRequest, type TrashItem } from "./mobile-api";

type Props = {
  tasks: MobileTask[];
  grid: boolean;
  setGrid: (value: boolean) => void;
  startTask: (request: TaskRequest) => Promise<MobileTask | null>;
  chooseDestination: (request: TaskRequest) => void;
};

/** Reuse the file area's visual controls while keeping trash selections and destructive confirmation local. */
export function MobileTrash({ tasks, grid, setGrid, startTask, chooseDestination }: Props) {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("recycled");
  const [multi, setMulti] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ items: TrashItem[]; all: boolean } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const generation = useRef(0);
  const scroll = useRef<HTMLDivElement>(null);
  const pressState = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number; fired: boolean } | null>(null);
  const taskRevision = tasks.filter((task) => ["trash", "restore", "purge"].includes(task.operation)).map((task) => `${task.id}:${task.revision}`).join(",");
  const busyIds = new Set(tasks.filter((task) => ["queued", "running"].includes(task.state)).flatMap((task) => task.items.map((item) => item.trashId)));

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    try {
      const result = await mobileCall<{ items: TrashItem[] }>("trash");
      if (generation.current !== request) return;
      setItems(result.items); setError("");
      const ids = new Set(result.items.map((item) => item.id));
      setChecked((previous) => new Set([...previous].filter((id) => ids.has(id))));
      setFocused((previous) => previous && ids.has(previous) ? previous : null);
      writeClientLog("debug", `回收站列表已刷新：${result.items.length} 项`);
    } catch (reason) {
      if (generation.current === request) setError(errorMessage(reason));
      writeClientLog("warn", `读取回收站失败：${errorMessage(reason)}`);
    } finally { if (generation.current === request) setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh, taskRevision]);
  useEffect(() => {
    const resume = () => { void refresh(); };
    window.addEventListener("mobile-resume", resume);
    return () => { generation.current++; window.removeEventListener("mobile-resume", resume); };
  }, [refresh]);
  const cancelPress = () => { if (pressState.current) clearTimeout(pressState.current.timer); };
  useEffect(() => () => { if (pressState.current) clearTimeout(pressState.current.timer); }, []);

  const ordered = useMemo(() => items.filter((item) => `${item.name}\n${item.originalPath}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a, b) => {
    if (sort === "recycled") return b.recycledAt - a.recycledAt;
    if (a.directory !== b.directory) return a.directory ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-CN", { numeric: true });
  }), [items, query, sort]);
  const selected = items.filter((item) => multi ? checked.has(item.id) : item.id === focused);
  const available = ordered.filter((item) => !busyIds.has(item.id));
  const allSelected = available.length > 0 && available.every((item) => checked.has(item.id));
  const blocked = submitting || selected.length === 0 || selected.some((item) => busyIds.has(item.id));
  const clearBlocked = loading || submitting || !items.length || items.some((item) => busyIds.has(item.id));
  const columns = grid ? 2 : 1;
  const virtual = useVirtualizer({ count: Math.ceil(ordered.length / columns), getScrollElement: () => scroll.current, estimateSize: () => grid ? 180 : 90, overscan: 4 });
  const selectMultiple = (id: string) => {
    if (busyIds.has(id)) return;
    setMulti(true); setFocused(null); setChecked((previous) => new Set([...previous, id]));
    writeClientLog("debug", `回收站长按进入多选：${id}`);
  };
  const pointerDown = (event: PointerEvent, item: TrashItem) => {
    if (event.button !== 0 || multi || busyIds.has(item.id)) return;
    cancelPress();
    pressState.current = { x: event.clientX, y: event.clientY, fired: false, timer: setTimeout(() => {
      if (pressState.current) pressState.current.fired = true;
      selectMultiple(item.id);
    }, 450) };
  };
  const selectItem = (id: string) => {
    if (pressState.current?.fired) { pressState.current = null; return; }
    if (multi) setChecked((previous) => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
    else setFocused(id);
  };
  const submit = async (operation: "restore" | "purge", selection: TrashItem[]) => {
    if (submitting || !selection.length) return;
    setSubmitting(true);
    writeClientLog("info", `提交回收站任务：${operation}，${selection.length} 项，IDs=${selection.map((item) => item.id).join(",")}`);
    try {
      const task = await startTask({ operation, trashIds: selection.map((item) => item.id), ...(operation === "purge" ? { confirmed: true } : {}) });
      if (task) { setConfirmation(null); setChecked(new Set()); setFocused(null); await refresh(); }
    } finally { setSubmitting(false); }
  };

  return <section className="mobile-trash" aria-label="回收站文件区">
    <div className="mobile-trash-notice" role="note"><Trash2 size={24} /><div><strong>当前位于回收站</strong><span>文件仍占用空间；彻底删除后无法恢复。</span></div>{!confirmation && <button className="mobile-danger mobile-trash-clear" disabled={clearBlocked} onClick={() => { writeClientLog("info", `打开清空整个回收站确认：${items.length} 项`); setConfirmation({ items: [...items], all: true }); }}>全部删除</button>}</div>
    {confirmation ? <div className="mobile-trash-confirm">
      <h3><TriangleAlert size={22} />{confirmation.all ? "确认清空回收站" : "确认彻底删除"} {confirmation.items.length} 项？</h3>
      <p>{confirmation.all ? "将删除整个回收站的内容，包括未在当前搜索结果中显示的项目。" : "以下选中内容将从回收站永久移除。"}此操作无法通过 FileSweeper 恢复。</p>
      <ul>{confirmation.items.map((item) => <li key={item.id}><strong>{item.name}</strong><small>{item.originalPath}</small></li>)}</ul>
      <button className="mobile-primary mobile-danger" disabled={submitting} onClick={() => void submit("purge", confirmation.items)}>{submitting ? "正在提交…" : `${confirmation.all ? "全部删除" : "彻底删除"} ${confirmation.items.length} 项`}</button>
      <button className="mobile-menu-row" disabled={submitting} onClick={() => { writeClientLog("debug", `取消回收站彻底删除确认：${confirmation.items.length} 项`); setConfirmation(null); }}>取消，返回回收站</button>
    </div> : <>
      <div className="mobile-tools">
        <label className="mobile-search"><Search size={16} /><input aria-label="搜索回收站" placeholder="搜索名称或原位置" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <select aria-label="回收站排序" value={sort} onChange={(event) => setSort(event.target.value)}><option value="recycled">回收时间</option><option value="name">名称</option></select>
        <button aria-label={grid ? "回收站列表视图" : "回收站网格视图"} onClick={() => setGrid(!grid)}>{grid ? <List size={19} /> : <Grid2X2 size={19} />}</button>
        <button aria-label={multi ? "退出回收站多选" : "多选回收项目"} className={multi ? "mobile-active" : ""} onClick={() => { setMulti(!multi); setChecked(new Set(!multi && focused ? [focused] : [])); setFocused(null); }}>{multi ? <X size={20} /> : <MoreHorizontal size={20} />}</button>
        <button aria-label="刷新回收站" disabled={loading} onClick={() => void refresh()}><RefreshCw size={18} className={loading ? "mobile-spin" : ""} /></button>
      </div>
      {multi && <div className="mobile-selection-bar"><span>已选 {selected.length} 项</span><button onClick={() => setChecked((previous) => { const next = new Set(previous); for (const item of available) { if (allSelected) next.delete(item.id); else next.add(item.id); } return next; })}>{allSelected ? "取消全选" : query ? "全选搜索结果" : "全选"}</button></div>}
      {error && <div className="mobile-inline-error" role="alert">{error}</div>}
      <div className="mobile-file-scroll mobile-trash-scroll" ref={scroll} onScroll={cancelPress}>
        {ordered.length === 0 && <div className="mobile-empty"><Trash2 size={32} /><p>{loading ? "正在读取回收站…" : error ? "回收站读取失败，请重试" : query ? "没有匹配的回收项目" : "回收站为空"}</p></div>}
        <div style={{ height: virtual.getTotalSize(), position: "relative", width: "100%" }}>
          {virtual.getVirtualItems().map((row) => <div key={row.key} className={`mobile-file-row ${grid ? "is-grid" : ""}`} style={{ position: "absolute", width: "100%", height: row.size, transform: `translateY(${row.start}px)` }}>
            {ordered.slice(row.index * columns, (row.index + 1) * columns).map((item) => {
              const isSelected = multi ? checked.has(item.id) : focused === item.id;
              return <button key={item.id} className={`mobile-file ${isSelected ? "is-selected" : ""}`} aria-label={item.name} aria-pressed={isSelected} disabled={busyIds.has(item.id)}
                onPointerDown={(event) => pointerDown(event, item)} onPointerUp={cancelPress} onPointerCancel={() => { cancelPress(); pressState.current = null; }}
                onPointerMove={(event) => { const state = pressState.current; if (state && Math.hypot(event.clientX - state.x, event.clientY - state.y) > 9) cancelPress(); }}
                onContextMenu={(event) => { event.preventDefault(); cancelPress(); selectMultiple(item.id); }} onClick={() => selectItem(item.id)}>
                <span className={`mobile-file-symbol ${item.directory ? "folder" : "file"}`}>{item.directory ? <Folder size={30} /> : <span>{item.name.includes(".") ? item.name.split(".").at(-1)!.toUpperCase().slice(0, 5) : "FILE"}</span>}</span>
                <span className="mobile-file-label"><strong>{item.name}</strong><small title={item.originalPath}>原位置：{item.originalPath}</small><small>{busyIds.has(item.id) ? "正在处理…" : `${item.directory ? "文件夹" : formatBytes(item.size ?? 0)} · ${new Date(item.recycledAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} 回收`}</small></span>
                {multi && <span className={`mobile-check ${isSelected ? "checked" : ""}`}>{isSelected && <Check size={15} />}</span>}
              </button>;
            })}
          </div>)}
        </div>
      </div>
      <footer className="mobile-trash-actions mobile-selection-bar" aria-label="回收站操作">{!multi && <span>{selected.length ? `已选 ${selected.length} 项` : `${ordered.length} 项 · 点选或长按多选`}</span>}<div>
        <button disabled={blocked} onClick={() => void submit("restore", selected)}><RotateCcw size={17} />恢复</button>
        <button disabled={blocked} onClick={() => chooseDestination({ operation: "restore", trashIds: selected.map((item) => item.id) })}>恢复到…</button>
        <button className="mobile-danger" disabled={blocked} onClick={() => { writeClientLog("info", `打开回收站彻底删除确认：${selected.length} 项`); setConfirmation({ items: [...selected], all: false }); }}><Trash2 size={17} />彻底删除</button>
      </div></footer>
    </>}
  </section>;
}
