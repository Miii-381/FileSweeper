import { useEffect, useMemo, useRef, useState } from "react";

import type { FileTaskSnapshot } from "../../app-types";
import { writeClientLog } from "../../app-utils";
import {
  FILE_TASK_SPEED_HISTORY_MS,
  appendFileTaskProgressSample,
  calculateByteSpeedSeries,
  calculateCurrentByteSpeed,
  type FileTaskProgressSample,
} from "./fileTaskProgress";

type Props = {
  task: FileTaskSnapshot;
  onCancel: () => void;
};

const SAMPLE_INTERVAL_MS = 400;
const GRAPH_WIDTH = 100;
const GRAPH_HEIGHT = 44;
const SPEED_AREA_MAX_HEIGHT_RATIO = 0.8;

function formatByteSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 字节";
  if (bytes < 1_024) return `${Math.round(bytes).toLocaleString("zh-CN")} 字节`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1_024)) - 1, units.length - 1);
  const value = bytes / 1_024 ** (unitIndex + 1);
  const maximumFractionDigits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toLocaleString("zh-CN", { maximumFractionDigits })} ${units[unitIndex]}`;
}

function formatByteSpeed(bytesPerSecond: number) {
  return `${formatByteSize(bytesPerSecond)}/秒`;
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
    transferredBytes: task.transferredBytes,
  }]);
  const maximumPercentage = useRef({ taskId: task.id, value: 0 });
  const isActive = task.state === "queued" || task.state === "running";

  useEffect(() => {
    setSamples([{ timestamp: performance.now(), transferredBytes: task.transferredBytes }]);
    writeClientLog("debug", `文件任务字节速度采样已初始化：任务 #${task.id}，间隔 ${SAMPLE_INTERVAL_MS}ms，已传输 ${task.transferredBytes} 字节，总字节 ${task.totalBytes ?? "未知"}`);
  }, [task.id]);

  useEffect(() => {
    if (!isActive) return;
    const timer = window.setInterval(() => {
      const currentTask = latestTask.current;
      setSamples((current) => appendFileTaskProgressSample(current, {
        timestamp: performance.now(),
        transferredBytes: currentTask.transferredBytes,
      }));
    }, SAMPLE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isActive, task.id]);

  const speed = calculateCurrentByteSpeed(samples);
  const remainingItems = Math.max(0, task.totalItems - task.completedItems);
  const remainingBytes = task.totalBytes === null
    ? null
    : Math.max(0, task.totalBytes - task.transferredBytes);
  const remainingSeconds = remainingBytes !== null && speed > 0
    ? remainingBytes / speed
    : null;
  const rawProgressPercentage = task.totalBytes !== null && task.totalBytes > 0
    ? Math.min(100, task.transferredBytes / task.totalBytes * 100)
    : task.totalItems > 0
      ? Math.min(100, task.completedItems / task.totalItems * 100)
      : 0;
  if (maximumPercentage.current.taskId !== task.id) {
    maximumPercentage.current = { taskId: task.id, value: 0 };
  }
  maximumPercentage.current.value = Math.max(maximumPercentage.current.value, rawProgressPercentage);
  const progressPercentage = task.state === "completed" ? 100 : maximumPercentage.current.value;
  const percentage = Math.round(progressPercentage);
  const graphGeometry = useMemo(() => {
    const series = calculateByteSpeedSeries(samples);
    const currentProgressX = progressPercentage / 100 * GRAPH_WIDTH;
    if (series.length === 0) {
      return {
        areaPoints: "",
        linePoints: "",
        currentSpeedY: GRAPH_HEIGHT - 0.75,
        currentProgressX,
      };
    }
    const latestTimestamp = samples.at(-1)?.timestamp ?? performance.now();
    const earliestTimestamp = latestTimestamp - FILE_TASK_SPEED_HISTORY_MS;
    const maximumSpeed = Math.max(1, speed, ...series.map((point) => point.bytesPerSecond));
    const speedAreaHeight = GRAPH_HEIGHT * SPEED_AREA_MAX_HEIGHT_RATIO;
    const plottedPoints = series.map((point, index) => {
      const byteProgressX = task.totalBytes !== null && task.totalBytes > 0
        ? point.transferredBytes / task.totalBytes * GRAPH_WIDTH
        : (point.timestamp - earliestTimestamp) / FILE_TASK_SPEED_HISTORY_MS * currentProgressX;
      const x = index === series.length - 1
        ? currentProgressX
        : Math.max(0, Math.min(currentProgressX, byteProgressX));
      const y = GRAPH_HEIGHT - Math.min(speedAreaHeight, point.bytesPerSecond / maximumSpeed * speedAreaHeight);
      return { x, y };
    });
    const visibleLinePoints = plottedPoints[0].x > 0
      ? [{ x: 0, y: plottedPoints[0].y }, ...plottedPoints]
      : plottedPoints;
    const linePoints = visibleLinePoints
      .map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`)
      .join(" ");
    const lastX = plottedPoints[plottedPoints.length - 1].x.toFixed(2);
    const unclampedCurrentSpeedY = GRAPH_HEIGHT - Math.min(speedAreaHeight, speed / maximumSpeed * speedAreaHeight);
    return {
      areaPoints: `0,${GRAPH_HEIGHT} ${linePoints} ${lastX},${GRAPH_HEIGHT}`,
      linePoints,
      currentSpeedY: Math.max(0.75, Math.min(GRAPH_HEIGHT - 0.75, unclampedCurrentSpeedY)),
      currentProgressX,
    };
  }, [progressPercentage, samples, speed, task.totalBytes]);
  const succeeded = task.results.filter((result) => result.status === "completed").length;
  const skipped = task.results.filter((result) => result.status === "skipped").length;
  const failed = task.results.filter((result) => result.status === "failed").length;
  const cancelled = task.results.filter((result) => result.status === "cancelled").length;
  const verb = task.operation === "move" ? "移动" : "复制";
  const progressGradientId = `file-task-progress-gradient-${task.id}`;
  const progressClipId = `file-task-progress-clip-${task.id}`;

  return (
    <section className="file-task-card" aria-label={`文件任务 ${task.id}`}>
      <div className="file-task-heading">
        <div>
          <strong>{task.state === "queued" ? `等待${verb}` : `正在${verb}`} {task.totalItems.toLocaleString("zh-CN")} 个项目</strong>
          <span>
            {task.state === "queued" && "等待开始"}
            {task.state === "running" && `已完成 ${percentage}%`}
            {task.state === "completed" && "已完成 100%"}
            {task.state === "cancelled" && `已停止 · 已完成 ${succeeded.toLocaleString("zh-CN")} · 已取消 ${cancelled.toLocaleString("zh-CN")}`}
          </span>
        </div>
        {isActive && <button type="button" onClick={onCancel}>取消</button>}
      </div>

      <div className="file-task-speed-chart" aria-label={`实时速度 ${formatByteSpeed(speed)}`}>
        <svg viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`} preserveAspectRatio="none">
          <defs>
            <linearGradient id={progressGradientId} x1="0" y1="0" x2="1" y2="0">
              <stop className="file-task-progress-start" offset="0" />
              <stop className="file-task-progress-end" offset="1" />
            </linearGradient>
            <clipPath id={progressClipId}>
              <rect
                className="file-task-progress-clip"
                x="0"
                y="0"
                width={graphGeometry.currentProgressX}
                height={GRAPH_HEIGHT}
              />
            </clipPath>
          </defs>
          <rect
            className="file-task-progress-fill"
            role="progressbar"
            aria-label={`${verb}进度`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressPercentage}
            x="0"
            y="0"
            width={graphGeometry.currentProgressX}
            height={GRAPH_HEIGHT}
            style={{ fill: `url(#${progressGradientId})` }}
          />
          <g className="file-task-speed-plot" clipPath={`url(#${progressClipId})`}>
            {graphGeometry.areaPoints && <polygon className="file-task-speed-area" points={graphGeometry.areaPoints} />}
            <line
              className="file-task-current-speed-marker"
              x1="0"
              x2={graphGeometry.currentProgressX}
              y1={graphGeometry.currentSpeedY}
              y2={graphGeometry.currentSpeedY}
            />
            {graphGeometry.linePoints && <polyline className="file-task-speed-line" points={graphGeometry.linePoints} />}
          </g>
          {progressPercentage > 0 && progressPercentage < 100 && (
            <line
              className="file-task-current-progress-boundary"
              x1={graphGeometry.currentProgressX}
              x2={graphGeometry.currentProgressX}
              y1="0"
              y2={GRAPH_HEIGHT}
            />
          )}
        </svg>
        <span>速度：{formatByteSpeed(speed)}</span>
      </div>

      <div className="file-task-details">
        <span>剩余时间：{task.state === "completed" ? "0 秒" : task.state === "cancelled" ? "已停止" : formatRemainingTime(remainingSeconds)}</span>
        {task.state === "cancelled"
          ? <span>取消项目：{cancelled.toLocaleString("zh-CN")}</span>
          : remainingBytes === null
            ? <span>剩余项目：{remainingItems.toLocaleString("zh-CN")}</span>
            : <span>剩余：{formatByteSize(remainingBytes)}（{remainingItems.toLocaleString("zh-CN")} 个项目）</span>}
      </div>
      <div className="file-task-summary" title={task.results.find((result) => result.error)?.error ?? undefined}>
        <span>成功 {succeeded}</span>
        <span>跳过 {skipped}</span>
        <span>失败 {failed}</span>
        {cancelled > 0 && <span>取消 {cancelled}</span>}
      </div>
    </section>
  );
}
