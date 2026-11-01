import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MobileTasks } from "./MobileTasks";
import type { MobileTask } from "./mobile-api";

const task: MobileTask = { id: "failed-task", operation: "copy", state: "failed", items: [
  { source: "/storage/emulated/0/Download/first.txt", name: "first.txt", destination: "/storage/emulated/0/Documents/first.txt", stage: "completed" },
  { source: "/storage/emulated/0/Download/second.txt", name: "second.txt", destination: "/storage/emulated/0/Documents/second.txt", stage: "pending" },
], totalItems: 2, completedItems: 1, transferredBytes: 10, revision: 3, currentIndex: 1, error: "目标已存在" };

describe("手机文件任务明细与重试", () => {
  it("显示具体文件名、来源目标和失败原因，重试时传递原任务并防止重复提交", async () => {
    let finish!: () => void;
    const retry = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<MobileTasks tasks={[task]} cancel={vi.fn()} retry={retry} />);
    fireEvent.click(screen.getByText("first.txt 等 2 项"));
    expect(screen.getByText("first.txt")).toBeTruthy();
    expect(screen.getByText("second.txt")).toBeTruthy();
    expect(screen.getByText("来源：/storage/emulated/0/Download/second.txt")).toBeTruthy();
    expect(screen.getByText("目标：/storage/emulated/0/Documents/second.txt")).toBeTruthy();
    expect(screen.getByText("目标已存在")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新执行" }));
    expect(retry).toHaveBeenCalledWith(task);
    expect((screen.getByRole("button", { name: "正在提交…" }) as HTMLButtonElement).disabled).toBe(true);
    finish();
    await waitFor(() => expect(screen.getByRole("button", { name: "重新执行" })).toBeTruthy());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("恢复与清空使用原文件名，不把回收站内部的 content 显示为文件名", () => {
    render(<MobileTasks tasks={[{ ...task, operation: "purge", state: "completed", items: [{ source: "/storage/emulated/0/.FileSweeperTrash/id/content", name: "照片.jpg", originalPath: "/storage/emulated/0/Pictures/照片.jpg", stage: "completed" }], totalItems: 1, completedItems: 1, error: undefined }]} cancel={vi.fn()} retry={vi.fn()} />);
    expect(screen.getByText("照片.jpg")).toBeTruthy();
    expect(screen.getByText("原位置：/storage/emulated/0/Pictures/照片.jpg")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重新执行" })).toBeNull();
  });
});
