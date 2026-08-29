import { describe, expect, it } from "vitest";

import {
  appendFileTaskProgressSample,
  calculateByteSpeedSeries,
  calculateCurrentByteSpeed,
  selectMonotonicFileTaskSnapshot,
} from "./fileTaskProgress";

function snapshot(
  id: number,
  state: "queued" | "running" | "completed",
  completedItems: number,
  transferredBytes = completedItems * 1_024,
) {
  return {
    id,
    operation: "copy" as const,
    state,
    destinationPath: "D:\\target",
    totalItems: 10,
    completedItems,
    totalBytes: 10_240,
    transferredBytes,
    results: Array.from({ length: completedItems }, (_, index) => ({
      sourcePath: `D:\\source\\${index}.txt`,
      destinationPath: `D:\\target\\${index}.txt`,
      status: "completed" as const,
      error: null,
    })),
  };
}

describe("文件任务实时速度", () => {
  it("使用最近时间窗口内的真实传输字节计算速度", () => {
    const samples = [
      { timestamp: 0, transferredBytes: 0 },
      { timestamp: 1_000, transferredBytes: 4_000 },
      { timestamp: 2_000, transferredBytes: 10_000 },
    ];
    expect(calculateCurrentByteSpeed(samples)).toBe(5_000);
  });

  it("任务停止产生进度后速度会衰减为零", () => {
    const samples = [
      { timestamp: 0, transferredBytes: 0 },
      { timestamp: 1_000, transferredBytes: 8_000 },
      { timestamp: 4_000, transferredBytes: 8_000 },
    ];
    expect(calculateCurrentByteSpeed(samples, 2_000)).toBe(0);
  });

  it("切换到进度轴后不再删除十二秒以前的速度历史", () => {
    const samples = appendFileTaskProgressSample(
      [{ timestamp: 0, transferredBytes: 0 }, { timestamp: 5_000, transferredBytes: 5_000 }],
      { timestamp: 13_000, transferredBytes: 13_000 },
    );
    expect(samples).toEqual([
      { timestamp: 0, transferredBytes: 0 },
      { timestamp: 5_000, transferredBytes: 5_000 },
      { timestamp: 13_000, transferredBytes: 13_000 },
    ]);
  });

  it("超过点数上限后保留任务起点和最近十二秒并压缩中间历史", () => {
    const samples = appendFileTaskProgressSample(
      [
        { timestamp: 0, transferredBytes: 0 },
        { timestamp: 5_000, transferredBytes: 5_000 },
        { timestamp: 10_000, transferredBytes: 10_000 },
        { timestamp: 15_000, transferredBytes: 15_000 },
      ],
      { timestamp: 20_000, transferredBytes: 20_000 },
      4,
    );

    expect(samples).toEqual([
      { timestamp: 0, transferredBytes: 0 },
      { timestamp: 10_000, transferredBytes: 10_000 },
      { timestamp: 15_000, transferredBytes: 15_000 },
      { timestamp: 20_000, transferredBytes: 20_000 },
    ]);
  });

  it("速度图序列使用与当前速度相同的平滑窗口", () => {
    const series = calculateByteSpeedSeries([
      { timestamp: 0, transferredBytes: 0 },
      { timestamp: 500, transferredBytes: 2_000 },
      { timestamp: 1_500, transferredBytes: 5_000 },
    ]);
    expect(series[0]).toEqual({ timestamp: 500, transferredBytes: 2_000, bytesPerSecond: 4_000 });
    expect(series[1].timestamp).toBe(1_500);
    expect(series[1].transferredBytes).toBe(5_000);
    expect(series[1].bytesPerSecond).toBeCloseTo(10_000 / 3);
  });

  it("相邻的短间隔采样不会制造瞬时速度尖峰", () => {
    const series = calculateByteSpeedSeries([
      { timestamp: 0, transferredBytes: 0 },
      { timestamp: 400, transferredBytes: 0 },
      { timestamp: 401, transferredBytes: 1_000 },
    ]);

    expect(series.at(-1)?.bytesPerSecond).toBeCloseTo(1_000 / 0.401);
    expect(series.at(-1)?.bytesPerSecond).toBeLessThan(3_000);
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

  it("同一文件任务允许单个大文件的字节进度单调前进", () => {
    const earlier = snapshot(8, "running", 0, 4_096);
    const progressed = snapshot(8, "running", 0, 8_192);
    const stale = snapshot(8, "running", 0, 6_144);

    expect(selectMonotonicFileTaskSnapshot(earlier, progressed)).toBe(progressed);
    expect(selectMonotonicFileTaskSnapshot(progressed, stale)).toBe(progressed);
  });
});
