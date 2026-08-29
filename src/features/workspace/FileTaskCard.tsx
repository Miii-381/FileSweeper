import { useEffect, useMemo, useRef, useState } from "react";

import type { FileTaskSnapshot } from "../../app-types";
import { writeClientLog } from "../../app-utils";
import {
  FILE_TASK_SPEED_HISTORY_MS,
  appendFileTaskProgressSample,
  calculateCurrentItemSpeed,
  calculateItemSpeedSeries,
  type FileTaskProgressSample,
} from "./fileTaskProgress";

type Props = {
  task: FileTaskSnapshot;
  onCancel: () => void;
};

const SAMPLE_INTERVAL_MS = 400;
const GRAPH_WIDTH = 100;
const GRAPH_HEIGHT = 44;

function formatItemSpeed(itemsPerSecond: number) {
  if (!Number.isFinite(itemsPerSecond) || itemsPerSecond <= 0.05) return "0";
  return itemsPerSecond < 10 ? itemsPerSecond.toFixed(1) : Math.round(itemsPerSecond).toLocaleString("zh-CN");
}

function formatRemainingTime(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "正在估算";
  if (seconds < 60) return `约 ${Math.max(1, Math.ceil(seconds))} 秒`;
  if (seconds < 3_600) return `约 ${Math.ceil(seconds / 60)} 分钟`;
  return `约 ${(seconds / 3_600).toFixed(1)} 小时`;
}

export function FileTaskCard({ task, onCancel }: Props) {
  const latestTask = useRef(task);
  latestTask.current = task;
  const [samples, setSamples] = useState<FileTaskProgressSample[]>(() => [{
    timestamp: performance.now(),
    completedItems: task.completedItems,
  }]);
  const isActive = task.state === "queued" || task.state === "running";

  useEffect(() => {
    writeClientLog("debug", `文件任务固定节拍速度采样已初始化：任务 #${task.id}，间隔 ${SAMPLE_INTERVAL_MS}ms，已完成 ${task.completedItems}/${task.totalItems}`);
  }, [task.id]);

  useEffect(() => {
    if (!isActive) return;
    const timer = window.setInterval(() => {
      const currentTask = latestTask.current;
      setSamples((current) => appendFileTaskProgressSample(current, {
        timestamp: performance.now(),
        completedItems: currentTask.completedItems,
      }));
    }, SAMPLE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isActive, task.id]);

  const speed = calculateCurrentItemSpeed(samples);
  const remainingItems = Math.max(0, task.totalItems - task.completedItems);
  const remainingSeconds = speed > 0.05 ? remainingItems / speed : null;
  const percentage = task.totalItems > 0
    ? Math.min(100, Math.round(task.completedItems / task.totalItems * 100))
    : 0;
  const graphPoints = useMemo(() => {
    const series = calculateItemSpeedSeries(samples);
    if (series.length === 0) return `0,${GRAPH_HEIGHT} ${GRAPH_WIDTH},${GRAPH_HEIGHT}`;
    const latestTimestamp = samples.at(-1)?.timestamp ?? performance.now();
    const earliestTimestamp = latestTimestamp - FILE_TASK_SPEED_HISTORY_MS;
    const maximumSpeed = Math.max(1, ...series.map((point) => point.itemsPerSecond));
    const points = series.map((point) => {
      const x = Math.max(0, Math.min(GRAPH_WIDTH, (point.timestamp - earliestTimestamp) / FILE_TASK_SPEED_HISTORY_MS * GRAPH_WIDTH));
      const y = GRAPH_HEIGHT - Math.min(GRAPH_HEIGHT, point.itemsPerSecond / maximumSpeed * GRAPH_HEIGHT);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    });
    return [`0,${GRAPH_HEIGHT}`, ...points, `${GRAPH_WIDTH},${GRAPH_HEIGHT}`].join(" ");
  }, [samples]);
  const succeeded = task.results.filter((result) => result.status === "completed").length;
  const skipped = task.results.filter((result) => result.status === "skipped").length;
  const failed = task.results.filter((result) => result.status === "failed").length;
  const verb = task.operation === "move" ? "移动" : "复制";

  return (
    <section className="file-task-card" aria-label={`文件任务 ${task.id}`}>
      <div className="file-task-heading">
        <div>
          <strong>{task.state === "queued" ? `等待${verb}` : `正在${verb}`} {task.totalItems.toLocaleString("zh-CN")} 个项目</strong>
          <span>
            {task.state === "queued" && "等待开始"}
            {task.state === "running" && `已完成 ${percentage}%`}
            {task.state === "completed" && "已完成 100%"}
            {task.state === "cancelled" && `已完成 ${percentage}% · 已取消未开始项目`}
          </span>
        </div>
        {isActive && <button type="button" onClick={onCancel}>取消</button>}
      </div>

      <div className="file-task-speed-chart" aria-label={`实时速度 ${formatItemSpeed(speed)} 个项目每秒`}>
        <svg viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
          <polygon points={graphPoints} />
          <polyline points={graphPoints} />
        </svg>
        <span>速度：{formatItemSpeed(speed)} 个项目/秒</span>
      </div>

      <div className="file-task-details">
        <span>剩余时间：{task.state === "completed" ? "0 秒" : formatRemainingTime(remainingSeconds)}</span>
        <span>剩余项目：{remainingItems.toLocaleString("zh-CN")}</span>
      </div>
      <div className="file-task-summary" title={task.results.find((result) => result.error)?.error ?? undefined}>
        <span>成功 {succeeded}</span>
        <span>跳过 {skipped}</span>
        <span>失败 {failed}</span>
      </div>
    </section>
  );
}
