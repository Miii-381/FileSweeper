import type { FileTaskSnapshot, FileTaskState } from "../../app-types";

export type FileTaskProgressSample = {
  timestamp: number;
  transferredBytes: number;
};

export type FileTaskSpeedPoint = {
  timestamp: number;
  transferredBytes: number;
  bytesPerSecond: number;
};

export const FILE_TASK_SPEED_HISTORY_MS = 12_000;
export const FILE_TASK_MAX_PROGRESS_SAMPLES = 360;

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
  if (FILE_TASK_STATE_ORDER[incoming.state] > FILE_TASK_STATE_ORDER[current.state]) return incoming;
  if (FILE_TASK_STATE_ORDER[incoming.state] < FILE_TASK_STATE_ORDER[current.state]) return current;
  if (incoming.transferredBytes > current.transferredBytes) return incoming;
  if (incoming.transferredBytes < current.transferredBytes) return current;
  if (incoming.completedItems > current.completedItems) return incoming;
  if (incoming.completedItems < current.completedItems) return current;
  if (incoming.results.length > current.results.length) return incoming;
  if (incoming.results.length < current.results.length) return current;
  if (incoming.totalBytes !== null && current.totalBytes === null) return incoming;
  if (incoming.totalBytes === null && current.totalBytes !== null) return current;
  if ((incoming.totalBytes ?? 0) > (current.totalBytes ?? 0)) return incoming;
  return current;
}

export function appendFileTaskProgressSample(
  samples: readonly FileTaskProgressSample[],
  sample: FileTaskProgressSample,
  maximumSamples = FILE_TASK_MAX_PROGRESS_SAMPLES,
) {
  const next = samples.length > 0 && samples.at(-1)?.timestamp === sample.timestamp
    ? [...samples.slice(0, -1), sample]
    : [...samples, sample];
  if (maximumSamples <= 0) {
    return [];
  }
  if (next.length <= maximumSamples || maximumSamples < 3) {
    return maximumSamples < 3 ? next.slice(-maximumSamples) : next;
  }

  const recentCutoff = sample.timestamp - FILE_TASK_SPEED_HISTORY_MS;
  const recentStart = next.findIndex((candidate) => candidate.timestamp >= recentCutoff);
  const recent = recentStart < 0 ? [next[next.length - 1]] : next.slice(recentStart);
  if (recent.length >= maximumSamples) {
    return [next[0], ...recent.slice(-(maximumSamples - 1))];
  }

  const older = recentStart < 0 ? next.slice(0, -1) : next.slice(0, recentStart);
  const olderBudget = maximumSamples - recent.length;
  if (older.length <= olderBudget) {
    return [...older, ...recent];
  }
  if (olderBudget === 1) {
    return [older[0], ...recent];
  }

  const sampledOlder: FileTaskProgressSample[] = [];
  for (let index = 0; index < olderBudget; index += 1) {
    const sourceIndex = Math.round(index * (older.length - 1) / (olderBudget - 1));
    sampledOlder.push(older[sourceIndex]);
  }
  return [...sampledOlder, ...recent];
}

export function calculateCurrentByteSpeed(
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
  return Math.max(0, latest.transferredBytes - baseline.transferredBytes) / elapsedSeconds;
}

export function calculateByteSpeedSeries(
  samples: readonly FileTaskProgressSample[],
  averagingWindow = 2_500,
) {
  const points: FileTaskSpeedPoint[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    const current = samples[index];
    points.push({
      timestamp: current.timestamp,
      transferredBytes: current.transferredBytes,
      bytesPerSecond: calculateCurrentByteSpeed(samples.slice(0, index + 1), averagingWindow),
    });
  }
  return points;
}
