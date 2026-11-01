import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearWorkspaceMemory, readFavorites, readWorkspaces, saveWorkspaces } from "./mobile-workspace";
vi.mock("../app-utils", () => ({ writeClientLog: vi.fn() }));

describe("手机路径与焦点持久化", () => {
  beforeEach(() => localStorage.clear());
  it("旧的喜好路径迁移后保留目录，去掉重复与无效条目", () => {
    localStorage.setItem("mobile.favorites", JSON.stringify(["/storage/emulated/0/A", "/storage/emulated/0/A", { name: "资料", path: "/storage/emulated/0/B" }, null]));
    expect(readFavorites()).toEqual([{ name: "A", path: "/storage/emulated/0/A" }, { name: "资料", path: "/storage/emulated/0/B" }]);
  });
  it("分别持久化目录焦点、视图、排序和滚动，并忽略损坏记录", () => {
    const saved = { "/a": { selected: "/a/x.txt", sort: "size", grid: true, scrollTop: 450 }, "/b": { selected: "/b/y.txt", sort: "name", grid: false, scrollTop: 200 } };
    saveWorkspaces(saved);
    expect(readWorkspaces()).toEqual(saved);
    localStorage.setItem("mobile.workspaces", JSON.stringify({ ...saved, "/broken": { sort: "wrong" } }));
    expect(readWorkspaces()).toEqual(saved);
  });
  it("关闭记忆清理浏览状态并保留喜好路径", () => {
    localStorage.setItem("mobile.favorites", '["/a"]'); localStorage.setItem("mobile.lastPath", "/a");
    saveWorkspaces({ "/a": { selected: null, sort: "name", grid: false, scrollTop: 0 } });
    clearWorkspaceMemory();
    expect(readWorkspaces()).toEqual({}); expect(localStorage.getItem("mobile.lastPath")).toBeNull();
    expect(readFavorites()).toHaveLength(1);
  });
});
