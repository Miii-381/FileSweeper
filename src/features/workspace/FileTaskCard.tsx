import type { FileTaskSnapshot } from "../../app-types";

type Props = {
  task: FileTaskSnapshot;
  onCancel: () => void;
};

export function FileTaskCard({ task, onCancel }: Props) {
  return (
    <section className="file-task-card" aria-label={`文件任务 ${task.id}`}>
      <div className="file-task-heading">
        <div>
          <strong>{task.operation === "move" ? "移动" : "复制"}任务 #{task.id}</strong>
          <span>
            {task.state === "queued" && "等待开始"}
            {task.state === "running" && `正在处理 ${Math.min(task.totalItems, task.completedItems + 1)} / ${task.totalItems}`}
            {task.state === "completed" && "已完成"}
            {task.state === "cancelled" && "已取消未开始项目"}
          </span>
        </div>
        {(task.state === "queued" || task.state === "running") && (
          <button type="button" onClick={onCancel}>取消</button>
        )}
      </div>
      <progress max={Math.max(1, task.totalItems)} value={task.completedItems} />
      <div className="file-task-summary" title={task.results.find((result) => result.error)?.error ?? undefined}>
        <span>成功 {task.results.filter((result) => result.status === "completed").length}</span>
        <span>跳过 {task.results.filter((result) => result.status === "skipped").length}</span>
        <span>失败 {task.results.filter((result) => result.status === "failed").length}</span>
      </div>
    </section>
  );
}
