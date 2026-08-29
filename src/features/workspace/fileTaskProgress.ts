import type { FileTaskSnapshot, FileTaskState } from "../../app-types";

export type FileTaskProgressSample = {
  timestamp: number;
  completedItems: number;
};

export type FileTaskSpeedPoint = {
  timestamp: number;
  itemsPerSecond: number;
};

export const FILE_TASK_SPEED_HISTORY_MS = 12_000;

const FILE_TASK_STATE_ORDER: Record<FileTaskState, number> = {
  queued: 0,
  running: 1,
  cancelled: 2,
  completed: 2,
};

export function selectMonotonicFileTaskSnapshot(
  current: FileTaskSnapshot | null,
  incoming: FileTaskSnapshot,
) {
  if (!current || incoming.id > current.id) return incoming;
  if (incoming.id < current.id) return current;
  if (incoming.completedItems > current.completedItems) return incoming;
  if (incoming.completedItems < current.completedItems) return current;
  if (incoming.results.length > current.results.length) return incoming;
  if (incoming.results.length < current.results.length) return current;
  return FILE_TASK_STATE_ORDER[incoming.state] > FILE_TASK_STATE_ORDER[current.state]
    ? incoming
    : current;
}

export function appendFileTaskProgressSample(
  samples: readonly FileTaskProgressSample[],
  sample: FileTaskProgressSample,
  historyWindow = FILE_TASK_SPEED_HISTORY_MS,
) {
  const next = samples.length > 0 && samples.at(-1)?.timestamp === sample.timestamp
    ? [...samples.slice(0, -1), sample]
    : [...samples, sample];
  const earliestTimestamp = sample.timestamp - historyWindow;
  return next.filter((candidate, index) => candidate.timestamp >= earliestTimestamp || index === next.length - 1);
}

export function calculateCurrentItemSpeed(
  samples: readonly FileTaskProgressSample[],
  averagingWindow = 2_500,
) {
  if (samples.length < 2) {
    return 0;
  }
  const latest = samples[samples.length - 1];
  const cutoff = latest.timestamp - averagingWindow;
  let baseline = samples[0];
  for (const sample of samples) {
    if (sample.timestamp > cutoff) break;
    baseline = sample;
  }
  const elapsedSeconds = (latest.timestamp - baseline.timestamp) / 1_000;
  if (elapsedSeconds <= 0) {
    return 0;
  }
  return Math.max(0, latest.completedItems - baseline.completedItems) / elapsedSeconds;
}

export function calculateItemSpeedSeries(
  samples: readonly FileTaskProgressSample[],
  averagingWindow = 2_500,
) {
  const points: FileTaskSpeedPoint[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    const current = samples[index];
    points.push({
      timestamp: current.timestamp,
      itemsPerSecond: calculateCurrentItemSpeed(samples.slice(0, index + 1), averagingWindow),
    });
  }
  return points;
}
