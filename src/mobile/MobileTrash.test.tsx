import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MobileTrash } from "./MobileTrash";
import type { MobileTask, TrashItem } from "./mobile-api";

const { mobileCall } = vi.hoisted(() => ({ mobileCall: vi.fn() }));
vi.mock("./mobile-api", () => ({ mobileCall }));
vi.mock("../app-utils", () => ({ errorMessage: String, formatBytes: (size: number) => `${size} B`, writeClientLog: vi.fn() }));
vi.mock("@tanstack/react-virtual", () => ({ useVirtualizer: ({ count }: { count: number }) => ({ getTotalSize: () => count * 90, getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ key: index, index, size: 90, start: index * 90 })) }) }));

const entries: TrashItem[] = ["alpha.txt", "beta.txt", "gamma"].map((name, index) => ({ id: `id-${index}`, name, originalPath: `/storage/emulated/0/Download/${name}`, recycledAt: 1000 + index, directory: index === 2, size: index === 2 ? null : 12 }));
function setup(tasks: MobileTask[] = []) {
  const startTask = vi.fn().mockResolvedValue({ id: "task", operation: "purge" });
  const chooseDestination = vi.fn();
  render(<MobileTrash tasks={tasks} grid={false} setGrid={vi.fn()} startTask={startTask} chooseDestination={chooseDestination} />);
  return { startTask, chooseDestination };
}

describe("回收站多选和彻底删除边界", () => {
  beforeEach(() => { mobileCall.mockReset(); mobileCall.mockResolvedValue({ items: entries }); });

  it("多选仅提交勾选的 ID，取消确认保留勾选，确认前不执行删除", async () => {
    const { startTask } = setup();
    await screen.findByRole("button", { name: "alpha.txt" });
    fireEvent.click(screen.getByRole("button", { name: "多选回收项目" }));
    fireEvent.click(screen.getByRole("button", { name: "alpha.txt" }));
    fireEvent.click(screen.getByRole("button", { name: "beta.txt" }));
    fireEvent.click(screen.getByRole("button", { name: "彻底删除" }));
    expect(screen.getByRole("heading", { name: "确认彻底删除 2 项？" })).toBeTruthy();
    expect(startTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消，返回回收站" }));
    expect(screen.getByRole("button", { name: "alpha.txt" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "彻底删除" }));
    fireEvent.click(screen.getByRole("button", { name: "彻底删除 2 项" }));
    await waitFor(() => expect(startTask).toHaveBeenCalledWith({ operation: "purge", trashIds: ["id-0", "id-1"], confirmed: true }));
  });

  it("全部删除不受搜索条件影响，必须单独确认整个回收站的范围", async () => {
    const { startTask } = setup();
    await screen.findByRole("button", { name: "alpha.txt" });
    fireEvent.change(screen.getByRole("textbox", { name: "搜索回收站" }), { target: { value: "alpha" } });
    expect(screen.queryByRole("button", { name: "beta.txt" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "全部删除" }));
    expect(screen.getByRole("heading", { name: "确认清空回收站 3 项？" })).toBeTruthy();
    expect(screen.getByText(/包括未在当前搜索结果中显示的项目/)).toBeTruthy();
    expect(startTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "全部删除 3 项" }));
    await waitFor(() => expect(startTask).toHaveBeenCalledWith({ operation: "purge", trashIds: ["id-0", "id-1", "id-2"], confirmed: true }));
  });

  it("全选搜索结果只选择可见结果，恢复到目录也携带整组选中 ID", async () => {
    const { startTask, chooseDestination } = setup();
    await screen.findByRole("button", { name: "alpha.txt" });
    fireEvent.change(screen.getByRole("textbox", { name: "搜索回收站" }), { target: { value: ".txt" } });
    fireEvent.click(screen.getByRole("button", { name: "多选回收项目" }));
    fireEvent.click(screen.getByRole("button", { name: "全选搜索结果" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复到…" }));
    expect(chooseDestination).toHaveBeenCalledWith({ operation: "restore", trashIds: ["id-0", "id-1"] });
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    await waitFor(() => expect(startTask).toHaveBeenCalledWith({ operation: "restore", trashIds: ["id-0", "id-1"] }));
  });

  it("正在处理的条目禁止重复提交，也禁止同时清空回收站", async () => {
    setup([{ id: "running", operation: "purge", state: "running", revision: 1, items: [{ source: "content", stage: "pending", trashId: "id-0" }] } as MobileTask]);
    const row = await screen.findByRole("button", { name: "alpha.txt" });
    expect((row as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "全部删除" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
