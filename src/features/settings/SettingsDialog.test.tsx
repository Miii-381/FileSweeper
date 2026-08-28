import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Preferences } from "../../app-types";
import { SettingsDialog } from "./SettingsDialog";

vi.mock("../../app-utils", async () => {
  const actual = await vi.importActual<typeof import("../../app-utils")>("../../app-utils");
  return { ...actual, writeClientLog: vi.fn() };
});

const settings: Preferences = {
  appearance: "dark",
  accentTheme: "teal",
  codeTheme: "tomorrow",
  thumbnailCacheGb: 0.5,
  thumbnailCapturePosition: "opening",
  autoplay: true,
  volume: 100,
  muted: false,
  rememberWorkspaceFocus: true,
  showHiddenItems: false,
  showNomediaMedia: false,
  videoExtensions: [".mp4"],
  audioExtensions: [".flac", ".mp3"],
  imageExtensions: [".jpg", ".png"],
  textExtensions: [".md", ".txt"],
  textLanguageMap: { ".md": "markdown", ".txt": "plain" },
  textPreviewLatinFont: "Consolas",
  textPreviewCjkFont: "Microsoft YaHei",
  imageMaxMegabytes: 50,
  imageMaxMegapixels: 100,
  managedVideoExtensions: [".mkv", ".mp4"],
  managedAudioExtensions: [".flac", ".mp3", ".wav"],
  managedImageExtensions: [".jpg", ".png", ".webp"],
  managedTextExtensions: [".json", ".md", ".txt"],
  backgroundSidecarConcurrency: 2,
  listColumns: [{ id: "name", visible: true, width: 280 }],
  backgroundImage: null,
  backgroundOpacity: 100,
  backgroundBlur: 0,
};

function renderSettings(
  onApply = vi.fn(async (_settings: Preferences) => true),
  onNotify = vi.fn<(message: string) => void>(),
) {
  render(
    <SettingsDialog
      settings={settings}
      limits={{ backgroundSidecarConcurrencyMin: 1, backgroundSidecarConcurrencyMax: 8 }}
      onApply={onApply}
      onClose={vi.fn()}
      onNotify={onNotify}
      onChooseBackground={vi.fn(async () => null)}
      onImportBackground={vi.fn(async (sourcePath: string) => sourcePath)}
      dataSummary={null}
      aboutInfo={null}
      onClearThumbnails={vi.fn(async () => undefined)}
      onClearOldLogs={vi.fn(async () => undefined)}
      onOpenPath={vi.fn(async () => undefined)}
      onExportDiagnostics={vi.fn(async () => undefined)}
    />,
  );
  return { onApply, onNotify };
}

describe("SettingsDialog 格式管理", () => {
  it("音频格式支持勾选、添加，并保留未启用候选项", async () => {
    const { onApply } = renderSettings();

    fireEvent.click(screen.getByRole("checkbox", { name: ".mp3" }));
    fireEvent.change(screen.getByRole("textbox", { name: "添加音频扩展名" }), { target: { value: "ape" } });
    fireEvent.click(screen.getAllByRole("button", { name: "添加" })[1]);
    fireEvent.click(screen.getByRole("button", { name: "应用" }));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    const applied = onApply.mock.calls[0][0];
    expect(applied.audioExtensions).toEqual([".ape", ".flac"]);
    expect(applied.managedAudioExtensions).toEqual([".ape", ".flac", ".mp3", ".wav"]);
  });

  it("拒绝取消最后一种已启用的格式", () => {
    const { onNotify } = renderSettings();

    fireEvent.click(screen.getByRole("checkbox", { name: ".mp4" }));

    expect(onNotify).toHaveBeenCalledWith("至少保留一种已启用的视频格式");
    expect((screen.getByRole("checkbox", { name: ".mp4" }) as HTMLInputElement).checked).toBe(true);
  });
});
