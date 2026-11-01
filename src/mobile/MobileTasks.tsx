import { RotateCcw, X } from "lucide-react";
import { useState } from "react";
import { formatBytes } from "../app-utils";
import { stateLabels, taskLabels, type MobileTask } from "./mobile-api";

const stageLabels: Record<string, string> = { pending: "待处理", copying: "复制中", moving: "移动中", committed: "已提交", deleting: "删除中", completed: "已完成" };
const basename = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

/** Display the durable task's actual files; retry keeps completed items intact. */
export function MobileTasks({ tasks, cancel, retry }: { tasks: MobileTask[]; cancel: (task: MobileTask) => Promise<void>; retry: (task: MobileTask) => Promise<void> }) {
  const [pending, setPending] = useState<Set<string>>(new Set());
  const act = async (task: MobileTask, action: (task: MobileTask) => Promise<void>) => {
    setPending((previous) => new Set(previous).add(task.id));
    try { await action(task); }
    finally { setPending((previous) => { const next = new Set(previous); next.delete(task.id); return next; }); }
  };
  return <div className="mobile-task-list" aria-label="文件任务列表">
    <p className="mobile-muted">最近 30 项任务。展开文件详情可核对名称和位置。</p>
    {tasks.length === 0 && <div className="mobile-empty">暂无文件任务</div>}
    {tasks.map((task) => {
      const retryable = ["failed", "interrupted", "cancelled"].includes(task.state);
      return <article className="mobile-task" key={task.id} data-task-id={task.id}>
        <header><strong>{taskLabels[task.operation] ?? task.operation}</strong><span className="mobile-task-state" data-state={task.state}>{stateLabels[task.state] ?? task.state}</span></header>
        <small>已完成 {task.completedItems} / {task.totalItems} 项 · 已传输 {formatBytes(task.transferredBytes)}</small>
        <details className="mobile-task-files" open={task.items.length === 1}>
          <summary>{task.items.length === 1 ? "文件详情" : `${task.items[0]?.name ?? basename(task.items[0]?.originalPath ?? task.items[0]?.source ?? "")} 等 ${task.items.length} 项`}</summary>
          <ul>{task.items.map((item, index) => <li key={`${index}-${item.source}`}>
            <div><strong className="mobile-task-file-name">{item.name ?? basename(item.originalPath ?? (task.operation === "restore" ? item.destination ?? item.source : item.source))}</strong><span className="mobile-task-file-stage">{item.stage === "completed" ? "已完成" : task.state === "failed" && task.currentIndex === index ? "失败" : stageLabels[item.stage] ?? "待核对"}</span></div>
            <small className="mobile-task-path">{task.operation === "purge" || task.operation === "restore" ? "原位置" : "来源"}：{item.originalPath ?? item.source}</small>
            {item.destination && task.operation !== "trash" && <small className="mobile-task-path">目标：{item.destination}</small>}
          </li>)}</ul>
        </details>
        {task.error && <p className="mobile-task-error">{task.error}</p>}
        {retryable && <p className="mobile-task-retry-help">仅重新处理未完成的项目，已完成的项目不会重复执行。</p>}
        <div className="mobile-task-actions">
          {["queued", "running", "interrupted"].includes(task.state) && <button disabled={pending.has(task.id)} onClick={() => void act(task, cancel)}><X size={16} />取消任务</button>}
          {retryable && <button className="mobile-task-retry" disabled={pending.has(task.id)} onClick={() => void act(task, retry)}><RotateCcw size={16} />{pending.has(task.id) ? "正在提交…" : task.state === "failed" ? "重新执行" : "继续未完成项"}</button>}
        </div>
      </article>;
    })}
  </div>;
}
