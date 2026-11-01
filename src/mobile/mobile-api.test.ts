import { describe, expect, it } from "vitest";
import type { DirectoryItem } from "../app-types";
import { breadcrumbs, nextFile, parentPath } from "./mobile-api";

const root = "/storage/emulated/0";
const files = ["A.txt", "b.txt", "c.txt"].map((name) => ({ entryType: "file", path: `${root}/${name}`, name })) as DirectoryItem[];

describe("Android 路径和连续确认", () => {
  it("保留 POSIX 根和大小写，不允许返回共享存储之外", () => {
    expect(parentPath(`${root}/Pictures/Case`, root)).toBe(`${root}/Pictures`);
    expect(parentPath(root, root)).toBeNull();
    expect(parentPath("/storage/emulated/01/Else", root)).toBeNull();
    expect(breadcrumbs(`${root}/Pictures/Case`, root)).toEqual([
      { name: "内部存储", path: root }, { name: "Pictures", path: `${root}/Pictures` }, { name: "Case", path: `${root}/Pictures/Case` },
    ]);
  });
  it("移除当前文件后跳过文件夹和已移除项目，优先下一文件", () => {
    const entries = [files[0], { entryType: "folder", path: `${root}/folder`, name: "folder" } as DirectoryItem, ...files.slice(1)];
    expect(nextFile(entries, new Set([files[0].path, files[1].path]), files[0].path)).toBe(files[2].path);
  });
  it("末尾回退到前一个文件，全部处理后为空", () => {
    expect(nextFile(files, new Set([files[2].path]), files[2].path)).toBe(files[1].path);
    expect(nextFile(files, new Set(files.map((file) => file.path)), files[2].path)).toBeNull();
  });
});
