import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { AppConfig } from "../../app-types";
import { errorMessage, writeClientLog } from "../../app-utils";

export function useAudioPreferences(setConfig: Dispatch<SetStateAction<AppConfig>>) {
  const timer = useRef<number | null>(null);
  const pendingConfig = useRef<{ volume: number; muted: boolean } | null>(null);
  const update = useCallback((volume: number, muted: boolean, persistImmediately = false) => {
    const nextVolume = Math.round(Math.min(100, Math.max(0, volume)));
    pendingConfig.current = { volume: nextVolume, muted };
    setConfig((current) => ({ ...current, settings: { ...current.settings, volume: nextVolume, muted } }));
    const persist = () => {
      const pending = pendingConfig.current;
      pendingConfig.current = null;
      if (!pending) { writeClientLog("debug", "音频偏好持久化被跳过：没有待保存值"); return; }
      writeClientLog("debug", `保存播放器音频偏好：音量 ${pending.volume}，静音 ${pending.muted}`);
      void invoke<AppConfig>("set_audio_preferences", pending).then((nextConfig) => {
        setConfig((current) => ({ ...current, version: nextConfig.version, settings: { ...current.settings, volume: nextConfig.settings.volume, muted: nextConfig.settings.muted } }));
        writeClientLog("debug", `播放器音频偏好保存完成：音量 ${nextConfig.settings.volume}，静音 ${nextConfig.settings.muted}`);
      }).catch((persistError) => writeClientLog("error", `保存播放器音量失败：${errorMessage(persistError)}`));
    };
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    if (persistImmediately) { writeClientLog("debug", "播放器音频偏好要求立即持久化"); persist(); }
    else {
      writeClientLog("debug", "播放器音频偏好将在 400ms 后合并持久化");
      timer.current = window.setTimeout(() => { timer.current = null; persist(); }, 400);
    }
  }, [setConfig]);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  return update;
}
