import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PreviewPlayer } from "./PreviewPlayer";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./VideoThumbnail", () => ({ loadThumbnailData: vi.fn() }));
vi.mock("../app-utils", async () => {
  const actual = await vi.importActual<typeof import("../app-utils")>("../app-utils");
  return { ...actual, writeClientLog: vi.fn() };
});

const video = {
  path: "C:\\Videos\\sample.mp4",
  name: "sample.mp4",
  extension: ".mp4",
  size: 1,
  createdAt: null,
  modifiedAt: null,
  duration: 60,
  width: null,
  height: null,
  thumbnailPath: null,
};

describe("PreviewPlayer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockReset();
    let paused = true;
    Object.defineProperty(HTMLMediaElement.prototype, "paused", { configurable: true, get: () => paused });
    Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: vi.fn(() => { paused = false; return Promise.resolve(); }) });
    Object.defineProperty(HTMLMediaElement.prototype, "pause", { configurable: true, value: vi.fn(() => { paused = true; }) });
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
    await vi.advanceTimersByTimeAsync(250);
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
});
