import { describe, expect, it } from "vitest";

import {
  appendFileTaskProgressSample,
  calculateCurrentItemSpeed,
  calculateItemSpeedSeries,
} from "./fileTaskProgress";

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

  it("速度图序列保留每段真实吞吐率", () => {
    expect(calculateItemSpeedSeries([
      { timestamp: 0, completedItems: 0 },
      { timestamp: 500, completedItems: 2 },
      { timestamp: 1_500, completedItems: 5 },
    ])).toEqual([
      { timestamp: 500, itemsPerSecond: 4 },
      { timestamp: 1_500, itemsPerSecond: 3 },
    ]);
  });
});
