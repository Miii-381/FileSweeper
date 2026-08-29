import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FolderEntry } from "../app-types";
import { FolderThumbnail } from "./FolderThumbnail";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

function folder(modifiedAt: number): FolderEntry {
  return {
    entryType: "folder",
    path: "D:\\media\\album",
    name: "album",
    createdAt: 1,
    modifiedAt,
    canRecycle: true,
  };
}

describe("FolderThumbnail", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (_command: string, args: { paths: string[] }) => (
      args.paths.map((path) => ({ folderPath: path, files: [] }))
    ));
    Reflect.deleteProperty(window, "IntersectionObserver");
  });

  it("目录修改时间变化后重新读取缩略图来源", async () => {
    const props = {
      thumbnailPathOverrides: new Map<string, string>(),
      visibilityRevision: 0,
      onEnsureThumbnail: vi.fn(),
    };
    const view = render(<FolderThumbnail folder={folder(100)} {...props} />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenLastCalledWith("list_folder_thumbnail_sources", {
      paths: ["D:\\media\\album"],
    });

    view.rerender(<FolderThumbnail folder={folder(200)} {...props} />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
  });
});
