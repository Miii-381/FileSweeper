import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemedContextMenu } from "./ThemedContextMenu";

describe("ThemedContextMenu", () => {
  it("只为可回收的目录显示删除操作", () => {
    const onAction = vi.fn();
    const baseMenu = {
      x: 12,
      y: 12,
      kind: "directory" as const,
      workspacePath: null,
      paths: ["C:\\files\\Child"],
      primaryPath: "C:\\files\\Child",
    };
    const { rerender } = render(<ThemedContextMenu menu={{ ...baseMenu, canRecycleDirectory: false }} onAction={onAction} onClose={vi.fn()} />);
    expect(screen.queryByText("移到回收站")).toBeNull();

    rerender(<ThemedContextMenu menu={{ ...baseMenu, canRecycleDirectory: true }} onAction={onAction} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("移到回收站"));
    expect(onAction).toHaveBeenCalledWith("deleteDirectory");
  });
});
