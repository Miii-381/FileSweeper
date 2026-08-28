export type FileTaskProgressSample = {
  timestamp: number;
  completedItems: number;
};

export type FileTaskSpeedPoint = {
  timestamp: number;
  itemsPerSecond: number;
};

export const FILE_TASK_SPEED_HISTORY_MS = 12_000;

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

export function calculateItemSpeedSeries(samples: readonly FileTaskProgressSample[]) {
  const points: FileTaskSpeedPoint[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const elapsedSeconds = (current.timestamp - previous.timestamp) / 1_000;
    points.push({
      timestamp: current.timestamp,
      itemsPerSecond: elapsedSeconds > 0
        ? Math.max(0, current.completedItems - previous.completedItems) / elapsedSeconds
        : 0,
    });
  }
  return points;
}
