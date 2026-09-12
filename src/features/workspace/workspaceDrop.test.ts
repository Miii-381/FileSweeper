import { describe, expect, it } from "vitest";

import { filterCrossFolderDropPaths } from "./workspaceDrop";

describe("filterCrossFolderDropPaths", () => {
  it("阻止当前文件夹内的单文件拖放复制", () => {
    expect(filterCrossFolderDropPaths(
      ["D:\\media\\clip.mp4"],
      "D:\\media",
    )).toEqual([]);
  });

  it("阻止当前文件夹内的多文件拖放复制并忽略大小写与分隔符差异", () => {
    expect(filterCrossFolderDropPaths(
      ["D:\\Media\\one.mp4", "D:/Media/two.jpg"],
      "d:\\media\\",
    )).toEqual([]);
  });

  it("保留从其他文件夹拖入的文件", () => {
    expect(filterCrossFolderDropPaths(
      ["D:\\incoming\\one.mp4", "E:\\photos\\two.jpg"],
      "D:\\media",
    )).toEqual(["D:\\incoming\\one.mp4", "E:\\photos\\two.jpg"]);
  });

  it("混合拖放时只复制来自其他文件夹的项目", () => {
    expect(filterCrossFolderDropPaths(
      ["D:\\media\\existing.mp4", "D:\\incoming\\new.mp4"],
      "D:\\media",
    )).toEqual(["D:\\incoming\\new.mp4"]);
  });

  it("阻止把当前工作区文件夹拖入其自身", () => {
    expect(filterCrossFolderDropPaths(["D:\\media"], "D:\\media")).toEqual([]);
  });

  it("在磁盘根目录中也能阻止同目录复制", () => {
    expect(filterCrossFolderDropPaths(["D:\\clip.mp4"], "D:\\")).toEqual([]);
  });
});
