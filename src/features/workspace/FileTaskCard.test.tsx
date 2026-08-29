import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { FileTaskSnapshot } from "../../app-types";
import { FileTaskCard } from "./FileTaskCard";

vi.mock("../../app-utils", () => ({
  writeClientLog: vi.fn(),
}));

describe("FileTaskCard", () => {
  it("取消后区分已完成与取消项目，并说明已完成项目会被保留", () => {
    const task: FileTaskSnapshot = {
      id: 18,
      operation: "move",
      state: "cancelled",
      destinationPath: "D:\\target",
      totalItems: 3,
      completedItems: 3,
      totalBytes: 3_072,
      transferredBytes: 1_024,
      results: [
        {
          sourcePath: "D:\\source\\done.txt",
          destinationPath: "D:\\target\\done.txt",
          status: "completed",
          error: null,
        },
        {
          sourcePath: "D:\\source\\cancelled-a.txt",
          destinationPath: null,
          status: "cancelled",
          error: null,
        },
        {
          sourcePath: "D:\\source\\cancelled-b.txt",
          destinationPath: null,
          status: "cancelled",
          error: null,
        },
      ],
    };

    render(<FileTaskCard task={task} onCancel={vi.fn()} />);

    expect(screen.getByText("已停止 · 已完成 1 · 已取消 2")).not.toBeNull();
    expect(screen.getByText("剩余时间：已停止")).not.toBeNull();
    expect(screen.getByText("取消项目：2")).not.toBeNull();
    expect(screen.getByText("取消 2")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  });

  it("单个超大文件传输期间显示字节进度与剩余量", () => {
    const gibibyte = 1_024 ** 3;
    const task: FileTaskSnapshot = {
      id: 19,
      operation: "copy",
      state: "running",
      destinationPath: "D:\\target",
      totalItems: 1,
      completedItems: 0,
      totalBytes: 10 * gibibyte,
      transferredBytes: 4 * gibibyte,
      results: [],
    };

    const { container } = render(<FileTaskCard task={task} onCancel={vi.fn()} />);

    expect(screen.getByText("已完成 40%")).not.toBeNull();
    expect(screen.getByText("剩余：6 GB（1 个项目）")).not.toBeNull();
    expect(screen.getByText("速度：0 字节/秒")).not.toBeNull();
    expect(screen.queryByText(/个项目\/秒/)).toBeNull();
    const progressFill = screen.getByRole("progressbar", { name: "复制进度" });
    expect(progressFill.getAttribute("aria-valuenow")).toBe("40");
    expect(progressFill.getAttribute("width")).toBe("40");
    expect(container.querySelector(".file-task-current-speed-marker")).not.toBeNull();
  });

  it("速度折线随复制进度向右延伸，并让当前速度对应进度边界", () => {
    vi.useFakeTimers();
    try {
      const task: FileTaskSnapshot = {
        id: 20,
        operation: "copy",
        state: "running",
        destinationPath: "D:\\target",
        totalItems: 1,
        completedItems: 0,
        totalBytes: 10_000,
        transferredBytes: 0,
        results: [],
      };
      const { container, rerender } = render(<FileTaskCard task={task} onCancel={vi.fn()} />);

      rerender(<FileTaskCard task={{ ...task, transferredBytes: 1_000 }} onCancel={vi.fn()} />);
      act(() => vi.advanceTimersByTime(400));
      rerender(<FileTaskCard task={{ ...task, transferredBytes: 2_000 }} onCancel={vi.fn()} />);
      act(() => vi.advanceTimersByTime(400));

      const points = container
        .querySelector(".file-task-speed-line")
        ?.getAttribute("points")
        ?.split(" ") ?? [];
      expect(points).toHaveLength(3);
      expect(Number(points[0].split(",")[0])).toBe(0);
      expect(Number(points[0].split(",")[1])).not.toBe(44);
      expect(Number(points[1].split(",")[0])).toBeCloseTo(10, 5);
      expect(Number(points[2].split(",")[0])).toBeCloseTo(20, 5);
      expect(points.every((point) => Number(point.split(",")[1]) >= 8.8)).toBe(true);
      expect(Number(container.querySelector(".file-task-current-speed-marker")?.getAttribute("y1"))).toBeCloseTo(8.8, 8);
      expect(Number(container.querySelector(".file-task-current-speed-marker")?.getAttribute("x2"))).toBeCloseTo(20, 5);
      expect(screen.getByRole("progressbar", { name: "复制进度" }).getAttribute("width")).toBe("20");
      expect(container.querySelector(".file-task-progress-clip")?.getAttribute("width")).toBe("20");
      expect(container.querySelector(".file-task-speed-plot")?.getAttribute("clip-path")).toBe("url(#file-task-progress-clip-20)");
      expect(Number(container.querySelector(".file-task-current-progress-boundary")?.getAttribute("x1"))).toBeCloseTo(20, 5);
      expect(container.querySelector(".file-task-speed-area")?.getAttribute("points")?.startsWith("0,44 0.00,")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
