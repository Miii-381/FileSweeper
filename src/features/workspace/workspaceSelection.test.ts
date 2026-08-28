import { describe, expect, it } from "vitest";

import { calculateWorkspaceSelectionGeometry, findNextPathAfterRemoval } from "./workspaceSelection";

describe("findNextPathAfterRemoval", () => {
  const orderedPaths = ["A", "B", "C", "D"];

  it("焦点项移除后选择它后面的第一个保留项", () => {
    expect(findNextPathAfterRemoval(orderedPaths, new Set(["B", "C"]), "B")).toBe("D");
  });

  it("末项移除后回退到前一个保留项", () => {
    expect(findNextPathAfterRemoval(orderedPaths, new Set(["C", "D"]), "D")).toBe("B");
  });

  it("焦点项未移除时不生成替代焦点", () => {
    expect(findNextPathAfterRemoval(orderedPaths, new Set(["C"]), "B")).toBeNull();
  });

  it("没有剩余项时返回空焦点", () => {
    expect(findNextPathAfterRemoval(orderedPaths, new Set(orderedPaths), "B")).toBeNull();
  });
});

describe("calculateWorkspaceSelectionGeometry", () => {
  it("工作区偏移不会重复叠加到矩形框位置", () => {
    const geometry = calculateWorkspaceSelectionGeometry({
      rootLeft: 320,
      rootTop: 96,
      scrollLeft: 0,
      scrollTop: 0,
      startContentX: 40,
      startContentY: 30,
      clientX: 460,
      clientY: 206,
    });
    expect(geometry.contentBox).toEqual({ left: 40, top: 30, width: 100, height: 80 });
    expect(geometry.viewportBox).toEqual({ left: 360, top: 126, width: 100, height: 80 });
  });

  it("滚动后仍以最初的内容位置为框选起点", () => {
    const geometry = calculateWorkspaceSelectionGeometry({
      rootLeft: 320,
      rootTop: 96,
      scrollLeft: 0,
      scrollTop: 120,
      startContentX: 40,
      startContentY: 30,
      clientX: 460,
      clientY: 206,
    });
    expect(geometry.contentBox).toEqual({ left: 40, top: 30, width: 100, height: 200 });
    expect(geometry.viewportBox).toEqual({ left: 360, top: 6, width: 100, height: 200 });
  });
});
