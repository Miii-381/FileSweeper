import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PreviewPlayer } from "./PreviewPlayer";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
let currentTimeValue = 0;
let currentTimeAssignments = vi.fn();
let mediaSeeking = false;
let mediaReadyState: number = HTMLMediaElement.HAVE_ENOUGH_DATA;

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./FileThumbnail", () => ({ loadThumbnailData: vi.fn() }));
vi.mock("../app-utils", async () => {
  const actual = await vi.importActual<typeof import("../app-utils")>("../app-utils");
  return { ...actual, writeClientLog: vi.fn() };
});

const video = {
  path: "C:\\Files\\sample.mp4",
  name: "sample.mp4",
  extension: ".mp4",
  size: 1,
  createdAt: null,
  modifiedAt: null,
  duration: 60,
  width: null,
  height: null,
  thumbnailPath: null,
  kind: "video" as const,
  previewCapability: "inline" as const,
};

describe("PreviewPlayer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockReset();
    currentTimeValue = 0;
    currentTimeAssignments = vi.fn();
    mediaSeeking = false;
    mediaReadyState = HTMLMediaElement.HAVE_ENOUGH_DATA;
    let paused = true;
    Object.defineProperty(HTMLMediaElement.prototype, "paused", { configurable: true, get: () => paused });
    Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: vi.fn(() => { paused = false; return Promise.resolve(); }) });
    Object.defineProperty(HTMLMediaElement.prototype, "pause", { configurable: true, value: vi.fn(() => { paused = true; }) });
    Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
      configurable: true,
      get: () => currentTimeValue,
      set: (value: number) => {
        currentTimeValue = value;
        currentTimeAssignments(value);
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "seeking", { configurable: true, get: () => mediaSeeking });
    Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => mediaReadyState });
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 1920 });
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => 1080 });
  });

  it("手动暂停后，回退转码的晚到流不会恢复播放", async () => {
    let resolveDirect!: (value: { url: string; isTranscoded: boolean; duration: number }) => void;
    let resolveTranscoded!: (value: { url: string; isTranscoded: boolean; duration: number }) => void;
    invoke.mockImplementation((command: string) => {
      if (command === "get_video_stream_url" && !resolveDirect) return new Promise((resolve) => { resolveDirect = resolve; });
      if (command === "get_video_stream_url") return new Promise((resolve) => { resolveTranscoded = resolve; });
      return Promise.resolve(false);
    });
    render(<PreviewPlayer video={video} thumbnailPath={null} autoplay volume={100} muted={false} onEnsureThumbnail={vi.fn()} onAudioPreferenceChange={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    await act(async () => {
      resolveDirect({ url: "http://stream/direct", isTranscoded: false, duration: 60 });
      await Promise.resolve();
    });
    const element = document.querySelector("video")!;
    fireEvent.canPlay(element);
    fireEvent.play(element);
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    fireEvent.error(element);
    await act(async () => {
      resolveTranscoded({ url: "http://stream/transcoded", isTranscoded: true, duration: 60 });
      await Promise.resolve();
    });
    fireEvent.canPlay(document.querySelector("video")!);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  });

  it("直连定位首次未就绪时只自动重试一次并恢复播放", async () => {
    invoke.mockImplementation((command: string) => command === "get_video_stream_url"
      ? Promise.resolve({ url: "http://stream/direct", isTranscoded: false, duration: 60 })
      : Promise.resolve(false));
    render(<PreviewPlayer video={video} thumbnailPath={null} autoplay volume={100} muted={false} onEnsureThumbnail={vi.fn()} onAudioPreferenceChange={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    const element = document.querySelector("video")!;
    fireEvent.canPlay(element);
    fireEvent.play(element);
    currentTimeAssignments.mockClear();
    mediaSeeking = true;
    mediaReadyState = HTMLMediaElement.HAVE_METADATA;

    const progress = screen.getByRole("slider", { name: "播放进度" });
    fireEvent.pointerDown(progress);
    fireEvent.input(progress, { target: { value: "30" } });
    fireEvent.pointerUp(progress);

    expect(currentTimeAssignments).toHaveBeenCalledTimes(1);
    expect(currentTimeAssignments).toHaveBeenLastCalledWith(30);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_499);
    });
    expect(currentTimeAssignments).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(currentTimeAssignments).toHaveBeenCalledTimes(2);
    expect(currentTimeAssignments).toHaveBeenLastCalledWith(30);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(currentTimeAssignments).toHaveBeenCalledTimes(2);
  });
});
