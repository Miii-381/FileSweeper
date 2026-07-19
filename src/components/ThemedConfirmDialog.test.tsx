import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemedConfirmDialog } from "./ThemedConfirmDialog";

describe("ThemedConfirmDialog", () => {
  it("通过键盘 Escape 取消，并允许确认危险操作", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ThemedConfirmDialog title="确认移到回收站" message="测试文件" onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "移到回收站" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
