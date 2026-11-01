import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { FileText, Music2, Pause, Play, ExternalLink, Volume2, VolumeX } from "lucide-react";
import type { FileEntry } from "../app-types";
import { ImagePreview } from "../features/preview/ImagePreview";
import { TextPreview } from "../features/preview/TextPreview";
import { PdfPreview } from "../features/preview/PdfPreview";
import { errorMessage, writeClientLog } from "../app-utils";
import { mobileCall, type MediaState, type MobilePreferences } from "./mobile-api";

function NativeMedia({ file, visible, autoplay }: { file: FileEntry; visible: boolean; autoplay: boolean }) {
  const slot = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const visibility = useRef(visible); visibility.current = visible;
  useEffect(() => {
    const element = slot.current;
    if (!element) return;
    let active = true;
    const bounds = () => { const rect = element.getBoundingClientRect(); return { path: file.path, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: visibility.current, renderVideo: file.kind === "video" }; };
    setError(null);
    void mobileCall("playMedia", { autoplay, ...bounds() }).catch((reason) => active && setError(errorMessage(reason)));
    const observer = new ResizeObserver(() => { if (active) void mobileCall("setPlayerBounds", bounds()).catch((reason) => writeClientLog("warn", errorMessage(reason))); });
    observer.observe(element);
    const update = () => { void mobileCall("setPlayerBounds", bounds()).catch((reason) => writeClientLog("warn", errorMessage(reason))); };
    const failure = (event: Event) => {
      const detail = (event as CustomEvent<{ path: string; message: string }>).detail;
      if (detail.path === file.path) { setError(detail.message); void mobileCall("closeMedia", { path: file.path }); }
    };
    window.addEventListener("resize", update);
    window.addEventListener("mobile-media-error", failure);
    return () => { active = false; observer.disconnect(); window.removeEventListener("resize", update); window.removeEventListener("mobile-media-error", failure); void mobileCall("closeMedia", { path: file.path }); };
  }, [file.path]);
  useEffect(() => {
    const rect = slot.current?.getBoundingClientRect();
    if (rect) void mobileCall("setPlayerBounds", { path: file.path, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: visible && !error, renderVideo: file.kind === "video" });
  }, [visible, error]);
  return <div className="mobile-native-slot" ref={slot}>
    {error ? <div className="mobile-empty"><p>{error}</p><button onClick={() => void invoke("open_file_externally", { path: file.path })}><ExternalLink size={16} />其他应用打开</button></div>
      : file.kind === "audio" ? <div className="mobile-empty"><Music2 size={34} /><span>{file.name}</span></div> : null}
  </div>;
}

export function MobilePreview({ file, visible, preferences }: { file: FileEntry | null; visible: boolean; preferences: MobilePreferences }) {
  if (!file) return <div className="mobile-empty"><FileText size={36} /><p>选择文件，开始确认</p><small>点按预览 · 长按操作</small></div>;
  switch (file.kind) {
    case "video": case "audio": return <NativeMedia key={file.path} file={file} visible={visible} autoplay={preferences.autoplay} />;
    case "image": return <ImagePreview key={file.path} file={file} />;
    case "pdf": return <PdfPreview key={file.path} file={file} />;
    case "text": return <TextPreview key={file.path} file={file} languageMap={preferences.textLanguageMap} codeTheme={preferences.codeTheme} latinFont={preferences.textPreviewLatinFont} cjkFont={preferences.textPreviewCjkFont} />;
    default: return <div className="mobile-empty"><FileText size={36} /><p>此类型暂不支持应用内预览</p><button onClick={() => void invoke("open_file_externally", { path: file.path })}>使用其他应用打开</button></div>;
  }
}

function time(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Sibling of the preview surface, so native video never covers the controls. */
export function MobileMediaControls({ path, preferences, save, visible }: { path: string; preferences: MobilePreferences; save: (patch: Partial<MobilePreferences>) => Promise<void>; visible: boolean }) {
  const [state, setState] = useState<MediaState | null>(null);
  const [seeking, setSeeking] = useState<number | null>(null);
  const report = (reason: unknown) => writeClientLog("warn", `手机媒体操作失败：${errorMessage(reason)}`);
  useEffect(() => {
    let active = true;
    const poll = async () => {
      if (document.hidden) return;
      try { const next = await mobileCall<MediaState>("mediaState"); if (active) setState(next.path === path ? next : null); } catch (reason) { report(reason); }
    };
    void poll(); const timer = setInterval(() => void poll(), 300);
    return () => { active = false; clearInterval(timer); };
  }, [path]);
  const control = (action: string, position?: number) => void mobileCall("controlMedia", { path, action, position }).catch(report);
  return <div className="mobile-media-controls" aria-label="媒体播放控制">
    <button aria-label={state?.playing ? "暂停" : "播放"} disabled={!visible || !state || !!state.error} onClick={() => control(state?.playing ? "pause" : "play")}>{state?.playing ? <Pause size={20} /> : <Play size={20} />}</button>
    <span>{time(seeking ?? state?.position ?? 0)}</span>
    <input type="range" aria-label="播放进度" min={0} max={Math.max(1, state?.duration ?? 0)} value={seeking ?? state?.position ?? 0} disabled={!visible || !state?.duration || !!state.error} onPointerDown={(event) => event.currentTarget.setPointerCapture?.(event.pointerId)} onChange={(event) => setSeeking(Number(event.target.value))} onPointerUp={(event) => { control("seek", Number(event.currentTarget.value)); setSeeking(null); }} onKeyUp={(event) => { control("seek", Number(event.currentTarget.value)); setSeeking(null); }} onPointerCancel={() => setSeeking(null)} />
    <span>{time(state?.duration ?? 0)}</span>
    <button aria-label={preferences.muted ? "取消静音" : "静音"} onClick={() => void save({ muted: !preferences.muted })}>{preferences.muted ? <VolumeX size={18} /> : <Volume2 size={18} />}</button>
  </div>;
}
