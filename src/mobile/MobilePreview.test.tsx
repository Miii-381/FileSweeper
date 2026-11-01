import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "../app-types";
import { MobileMediaControls, MobilePreview } from "./MobilePreview";
import type { MobilePreferences } from "./mobile-api";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../features/preview/PdfPreview", () => ({ PdfPreview: () => null }));
vi.mock("@tauri-apps/plugin-log", () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }));
const file = { path: "/storage/emulated/0/test.mp4", name: "test.mp4", kind: "video" } as FileEntry;
const preferences = { autoplay: true, muted: false } as MobilePreferences;
const commands = (name: string) => invoke.mock.calls.filter((args) => args[1]?.command === name);

describe("手机原生预览播放行为", () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue({});
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  });

  it("切换文件遵守自动播放设置，收起与展开不会重新准备并自动续播", async () => {
    const { rerender } = render(<MobilePreview file={file} visible preferences={preferences} />);
    expect(commands("playMedia")[0][1].payload.autoplay).toBe(true);
    rerender(<MobilePreview file={file} visible={false} preferences={preferences} />);
    expect(commands("setPlayerBounds").at(-1)![1].payload.visible).toBe(false);
    rerender(<MobilePreview file={file} visible preferences={preferences} />);
    expect(commands("playMedia")).toHaveLength(1);
    rerender(<MobilePreview file={{ ...file, path: "/storage/emulated/0/next.mp4" }} visible preferences={{ ...preferences, autoplay: false }} />);
    expect(commands("playMedia").at(-1)![1].payload.autoplay).toBe(false);
    await waitFor(() => expect(commands("closeMedia").length).toBeGreaterThan(0));
  });

  it("独立控制条向当前文件发送暂停、定位和静音操作", async () => {
    invoke.mockImplementation((_command, args) => Promise.resolve(args.command === "mediaState" ? { path: file.path, playing: true, position: 2000, duration: 10000, state: 3 } : {}));
    const save = vi.fn().mockResolvedValue(undefined);
    render(<MobileMediaControls path={file.path} visible preferences={preferences} save={save} />);
    fireEvent.click(await screen.findByRole("button", { name: "暂停" }));
    expect(commands("controlMedia").at(-1)![1].payload).toMatchObject({ path: file.path, action: "pause" });
    const seek = screen.getByRole("slider", { name: "播放进度" });
    fireEvent.change(seek, { target: { value: "6000" } });
    fireEvent.pointerUp(seek);
    expect(commands("controlMedia").at(-1)![1].payload).toMatchObject({ action: "seek", position: 6000 });
    fireEvent.click(screen.getByRole("button", { name: "静音" }));
    expect(save).toHaveBeenCalledWith({ muted: true });
  });

  it("清空预览后忽略排队的尺寸回调，关闭命令只针对原文件", () => {
    let resized: (() => void) | undefined;
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resized = callback; } observe() {} disconnect() {} });
    const { rerender } = render(<MobilePreview file={file} visible preferences={preferences} />);
    rerender(<MobilePreview file={null} visible preferences={preferences} />);
    const count = commands("setPlayerBounds").length;
    act(() => resized?.());
    expect(commands("setPlayerBounds")).toHaveLength(count);
    expect(commands("closeMedia").at(-1)![1].payload).toEqual({ path: file.path });
    expect(screen.getByText("选择文件，开始确认")).toBeTruthy();
  });
});
