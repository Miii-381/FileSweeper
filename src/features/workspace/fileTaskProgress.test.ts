import { describe, expect, it } from "vitest";

import {
  appendFileTaskProgressSample,
  calculateCurrentItemSpeed,
  calculateItemSpeedSeries,
  selectMonotonicFileTaskSnapshot,
} from "./fileTaskProgress";

function snapshot(id: number, state: "queued" | "running" | "completed", completedItems: number) {
  return {
    id,
    operation: "copy" as const,
    state,
    destinationPath: "D:\\target",
    totalItems: 10,
    completedItems,
    results: Array.from({ length: completedItems }, (_, index) => ({
      sourcePath: `D:\\source\\${index}.txt`,
      destinationPath: `D:\\target\\${index}.txt`,
      status: "completed" as const,
      error: null,
    })),
  };
}

describe("文件任务实时速度", () => {
  it("使用最近时间窗口内的真实完成数量计算速度", () => {
    const samples = [
      { timestamp: 0, completedItems: 0 },
      { timestamp: 1_000, completedItems: 4 },
      { timestamp: 2_000, completedItems: 10 },
    ];
    expect(calculateCurrentItemSpeed(samples)).toBe(5);
  });

  it("任务停止产生进度后速度会衰减为零", () => {
    const samples = [
      { timestamp: 0, completedItems: 0 },
      { timestamp: 1_000, completedItems: 8 },
      { timestamp: 4_000, completedItems: 8 },
    ];
    expect(calculateCurrentItemSpeed(samples, 2_000)).toBe(0);
  });

  it("只保留速度图需要的时间窗口", () => {
    const samples = appendFileTaskProgressSample(
      [{ timestamp: 0, completedItems: 0 }, { timestamp: 5_000, completedItems: 5 }],
      { timestamp: 13_000, completedItems: 13 },
      10_000,
    );
    expect(samples).toEqual([
      { timestamp: 5_000, completedItems: 5 },
      { timestamp: 13_000, completedItems: 13 },
    ]);
  });

  it("速度图序列使用与当前速度相同的平滑窗口", () => {
    const series = calculateItemSpeedSeries([
      { timestamp: 0, completedItems: 0 },
      { timestamp: 500, completedItems: 2 },
      { timestamp: 1_500, completedItems: 5 },
    ]);
    expect(series[0]).toEqual({ timestamp: 500, itemsPerSecond: 4 });
    expect(series[1].timestamp).toBe(1_500);
    expect(series[1].itemsPerSecond).toBeCloseTo(10 / 3);
  });

  it("相邻的短间隔采样不会制造瞬时速度尖峰", () => {
    const series = calculateItemSpeedSeries([
      { timestamp: 0, completedItems: 0 },
      { timestamp: 400, completedItems: 0 },
      { timestamp: 401, completedItems: 1 },
    ]);

    expect(series.at(-1)?.itemsPerSecond).toBeCloseTo(1 / 0.401);
    expect(series.at(-1)?.itemsPerSecond).toBeLessThan(3);
  });

  it("同一文件任务不会被较旧的启动快照或进度快照回退", () => {
    const running = snapshot(7, "running", 3);

    expect(selectMonotonicFileTaskSnapshot(running, snapshot(7, "queued", 0))).toBe(running);
    expect(selectMonotonicFileTaskSnapshot(running, snapshot(7, "running", 2))).toBe(running);
    expect(selectMonotonicFileTaskSnapshot(running, snapshot(6, "completed", 10))).toBe(running);
  });

  it("同一文件任务允许完成数量和状态单调前进", () => {
    const queued = snapshot(7, "queued", 0);
    const running = snapshot(7, "running", 0);
    const progressed = snapshot(7, "running", 4);
    const completed = snapshot(7, "completed", 4);

    expect(selectMonotonicFileTaskSnapshot(queued, running)).toBe(running);
    expect(selectMonotonicFileTaskSnapshot(running, progressed)).toBe(progressed);
    expect(selectMonotonicFileTaskSnapshot(progressed, completed)).toBe(completed);
  });
});
