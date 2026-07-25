import { invoke } from "@tauri-apps/api/core";
import { Music2, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import type { FileEntry } from "../../app-types";
import { errorMessage, formatPlaybackTime, writeClientLog } from "../../app-utils";
import { loadThumbnailData } from "../../components/FileThumbnail";
import { PreviewError } from "./ImagePreview";

const WAVEFORM_IDLE_DELAY_MS = 2200;

export function AudioPreview({
  file,
  thumbnailPath,
  autoplay,
  volume,
  muted,
  onEnsureThumbnail,
  onAudioPreferenceChange,
}: {
  file: FileEntry;
  thumbnailPath: string | null;
  autoplay: boolean;
  volume: number;
  muted: boolean;
  onEnsureThumbnail: (file: FileEntry) => void;
  onAudioPreferenceChange: (volume: number, muted: boolean, persistImmediately?: boolean) => void;
}) {
  const spectrumCanvas = useRef<HTMLCanvasElement>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const spectrumAnimationFrame = useRef<number | null>(null);
  const spectrumResizeObserver = useRef<ResizeObserver | null>(null);
  const waveformIdleTimer = useRef<number | null>(null);
  // Kept separate from loading state: a late URL, fallback, or canplay event must never
  // override an explicit user pause.
  const playbackIntent = useRef(false);
  const sourceRequest = useRef(0);
  const isScrubbing = useRef(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(muted);
  const [playerVolume, setPlayerVolume] = useState(volume);
  const [thumbnailSrc, setThumbnailSrc] = useState<string | null>(null);
  const [waveformVisible, setWaveformVisible] = useState(false);

  const clearWaveformTimer = () => {
    if (waveformIdleTimer.current !== null) {
      window.clearTimeout(waveformIdleTimer.current);
      waveformIdleTimer.current = null;
    }
  };
  const showWaveform = () => {
    clearWaveformTimer();
    setWaveformVisible(true);
  };
  const deferWaveformUntilIdle = () => {
    clearWaveformTimer();
    setWaveformVisible(false);
    waveformIdleTimer.current = window.setTimeout(() => {
      waveformIdleTimer.current = null;
      setWaveformVisible(true);
    }, WAVEFORM_IDLE_DELAY_MS);
  };

  useEffect(() => {
    setThumbnailSrc(null);
    let active = true;
    writeClientLog("debug", `读取音频标签内嵌原始封面：${file.path}`);
    void invoke<string>("read_audio_embedded_cover", { path: file.path })
      .then((source) => {
        if (active) setThumbnailSrc(source);
      })
      .catch((error) => {
        writeClientLog("warn", `读取音频标签原始封面失败，回退到网格缩略图缓存：${file.path}，${errorMessage(error)}`);
        if (thumbnailPath) {
          void loadThumbnailData(file, thumbnailPath)
            .then((source) => { if (active) setThumbnailSrc(source); })
            .catch((fallbackError) => writeClientLog("warn", `读取音频封面缓存失败：${file.path}，${errorMessage(fallbackError)}`));
        } else {
          onEnsureThumbnail(file);
        }
      });
    return () => { active = false; };
  }, [file.path, onEnsureThumbnail, thumbnailPath]);

  useEffect(() => {
    deferWaveformUntilIdle();
    return clearWaveformTimer;
  }, [file.path]);

  useEffect(() => {
    setPlayerVolume(volume);
    setIsMuted(muted);
  }, [muted, volume]);

  useEffect(() => {
    const player = audioElement.current;
    if (!player) return;
    player.muted = isMuted;
    player.volume = Math.min(1, Math.max(0, playerVolume / 100));
  }, [isMuted, playerVolume]);

  useEffect(() => {
    let active = true;
    let usingFallback = false;
    let ready = false;
    let loadStartedAt = 0;
    playbackIntent.current = autoplay;
    sourceRequest.current = 0;
    writeClientLog("info", `创建音频预览会话：${file.path}`);
    const player = document.createElement("audio");
    player.preload = "metadata";
    player.crossOrigin = "anonymous";
    player.muted = muted;
    player.volume = Math.min(1, Math.max(0, volume / 100));
    audioElement.current = player;

    const initializeRealtimeSpectrum = () => {
      const canvas = spectrumCanvas.current;
      if (!canvas || audioContext.current) return;
      try {
        const context = new AudioContext();
        const source = context.createMediaElementSource(player);
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.72;
        source.connect(analyser);
        analyser.connect(context.destination);
        audioContext.current = context;
        const frequencyData = new Uint8Array(analyser.frequencyBinCount);
        const minimumFrequency = 30;
        const maximumFrequency = Math.min(20_000, context.sampleRate / 2);
        const frequencyPerBin = context.sampleRate / analyser.fftSize;
        const resizeCanvas = () => {
          const { width, height } = canvas.getBoundingClientRect();
          const ratio = window.devicePixelRatio || 1;
          canvas.width = Math.max(1, Math.round(width * ratio));
          canvas.height = Math.max(1, Math.round(height * ratio));
          canvas.getContext("2d")?.setTransform(ratio, 0, 0, ratio, 0, 0);
        };
        const drawSpectrum = () => {
          const context2d = canvas.getContext("2d");
          if (!context2d) return;
          const { width, height } = canvas.getBoundingClientRect();
          analyser.getByteFrequencyData(frequencyData);
          context2d.clearRect(0, 0, width, height);
          const barCount = 48;
          const gap = 2;
          const barWidth = Math.max(2, (width - gap * (barCount - 1)) / barCount);
          const centerY = height / 2;
          for (let index = 0; index < barCount; index += 1) {
            const lowerFrequency = minimumFrequency * (maximumFrequency / minimumFrequency) ** (index / barCount);
            const upperFrequency = minimumFrequency * (maximumFrequency / minimumFrequency) ** ((index + 1) / barCount);
            const firstBin = Math.max(0, Math.floor(lowerFrequency / frequencyPerBin));
            const lastBin = Math.min(frequencyData.length - 1, Math.ceil(upperFrequency / frequencyPerBin));
            let peak = 0;
            for (let bin = firstBin; bin <= lastBin; bin += 1) peak = Math.max(peak, frequencyData[bin]);
            const energy = (peak / 255) ** 0.8;
            const barHeight = Math.max(5, energy * height * 0.86);
            const x = index * (barWidth + gap);
            context2d.fillStyle = `rgba(255, 255, 255, ${0.56 + energy * 0.36})`;
            context2d.fillRect(x, centerY - barHeight / 2, barWidth, barHeight);
          }
          spectrumAnimationFrame.current = window.requestAnimationFrame(drawSpectrum);
        };
        resizeCanvas();
        spectrumResizeObserver.current = new ResizeObserver(resizeCanvas);
        spectrumResizeObserver.current.observe(canvas);
        drawSpectrum();
        writeClientLog("debug", `已启用实时音频频谱：${file.path}，采样率 ${context.sampleRate} Hz，FFT ${analyser.fftSize}，展示范围 ${minimumFrequency}-${maximumFrequency} Hz`);
      } catch (error) {
        writeClientLog("warn", `无法创建实时音频频谱，将只保留播放控制：${file.path}，${errorMessage(error)}`);
      }
    };

    const playWhenRequested = (reason: string) => {
      if (!playbackIntent.current || !player.paused) return;
      void player.play().catch((error) => {
        if (active) writeClientLog("debug", `音频${reason}播放被浏览器阻止：${file.path}，${errorMessage(error)}`);
      });
    };

    const markReadyFromMetadata = () => {
      if (!active || ready) return;
      ready = true;
      const nextDuration = Number.isFinite(player.duration) ? player.duration : 0;
      setDuration(nextDuration);
      setState("ready");
      initializeRealtimeSpectrum();
      writeClientLog(
        "info",
        `音频元数据已就绪：${file.path}，时长 ${nextDuration.toFixed(3)} 秒，回退 ${usingFallback}，耗时 ${(performance.now() - loadStartedAt).toFixed(0)} ms`,
      );
      playWhenRequested("自动");
    };

    const updateDuration = () => {
      if (!active || !Number.isFinite(player.duration)) return;
      setDuration(player.duration);
    };

    const loadSource = async (forceTranscode: boolean) => {
      const request = ++sourceRequest.current;
      try {
        writeClientLog("debug", `请求${forceTranscode ? " FFmpeg 回退" : "原文件"}音频流：${file.path}`);
        const url = await invoke<string>("get_audio_stream_url", { path: file.path, forceTranscode });
        if (!active || request !== sourceRequest.current) {
          writeClientLog("debug", `忽略过期音频流地址：${file.path}，请求 ${request}`);
          return;
        }
        loadStartedAt = performance.now();
        ready = false;
        writeClientLog("debug", `音频流地址已获取，开始按需加载元数据：${file.path}，请求 ${request}，恢复播放 ${playbackIntent.current}`);
        setState("loading");
        setPreviewError(null);
        setCurrentTime(0);
        setDuration(0);
        player.pause();
        player.src = url;
        player.load();
      } catch (error) {
        if (!active || request !== sourceRequest.current) return;
        if (!forceTranscode) {
          if (!usingFallback) {
            usingFallback = true;
            writeClientLog("warn", `原始音频无法加载，改用 FFmpeg 回退：${file.path}，${errorMessage(error)}`);
            void loadSource(true);
          }
          return;
        }
        setState("error");
        setPreviewError(errorMessage(error));
        writeClientLog("error", `音频预览加载失败：${file.path}，${errorMessage(error)}`);
      }
    };
    const handlePlayerError = () => {
      if (!active) return;
      const error = player.error ? `${player.error.code}: ${player.error.message}` : "浏览器音频元素报告未知错误";
      if (!usingFallback) {
        usingFallback = true;
        writeClientLog("warn", `浏览器无法解码原始音频，改用 FFmpeg 回退：${file.path}，${error}`);
        void loadSource(true);
      } else {
        setState("error");
        setPreviewError(error);
        writeClientLog("error", `音频预览加载失败：${file.path}，${error}`);
      }
    };
    const handleTimeUpdate = () => { if (active && !isScrubbing.current) setCurrentTime(player.currentTime); };
    const handlePlay = () => {
      if (!active) return;
      if (!playbackIntent.current) {
        writeClientLog("warn", `拒绝非预期音频播放事件并恢复暂停：${file.path}`);
        player.pause();
        return;
      }
      setIsPlaying(true);
      void audioContext.current?.resume();
    };
    const handlePause = () => { if (active) setIsPlaying(false); };
    const handleCanPlay = () => {
      if (!active) return;
      writeClientLog("debug", `音频首段缓冲可播放：${file.path}，耗时 ${(performance.now() - loadStartedAt).toFixed(0)} ms`);
      playWhenRequested("自动");
    };
    player.addEventListener("loadedmetadata", markReadyFromMetadata);
    player.addEventListener("durationchange", updateDuration);
    player.addEventListener("canplay", handleCanPlay);
    player.addEventListener("timeupdate", handleTimeUpdate);
    player.addEventListener("play", handlePlay);
    player.addEventListener("pause", handlePause);
    player.addEventListener("ended", handlePause);
    player.addEventListener("error", handlePlayerError);
    void loadSource(false);
    return () => {
      active = false;
      player.pause();
      player.removeAttribute("src");
      player.load();
      player.removeEventListener("loadedmetadata", markReadyFromMetadata);
      player.removeEventListener("durationchange", updateDuration);
      player.removeEventListener("canplay", handleCanPlay);
      player.removeEventListener("timeupdate", handleTimeUpdate);
      player.removeEventListener("play", handlePlay);
      player.removeEventListener("pause", handlePause);
      player.removeEventListener("ended", handlePause);
      player.removeEventListener("error", handlePlayerError);
      if (spectrumAnimationFrame.current !== null) window.cancelAnimationFrame(spectrumAnimationFrame.current);
      spectrumResizeObserver.current?.disconnect();
      spectrumResizeObserver.current = null;
      void audioContext.current?.close();
      audioContext.current = null;
      writeClientLog("debug", `销毁原生音频预览会话：${file.path}`);
      if (audioElement.current === player) audioElement.current = null;
      void invoke("stop_transcoded_preview", { path: file.path }).catch((error: unknown) =>
        writeClientLog("warn", `停止音频 FFmpeg 回退失败：${file.path}，${errorMessage(error)}`),
      );
    };
  }, [file.path]);

  const togglePlayback = () => {
    const player = audioElement.current;
    if (state !== "ready" || !player) return;
    if (player.paused) {
      playbackIntent.current = true;
      writeClientLog("info", `用户请求播放音频：${file.path}`);
      void player.play().catch((error) => writeClientLog("warn", `播放音频失败：${file.path}，${errorMessage(error)}`));
    } else {
      playbackIntent.current = false;
      writeClientLog("info", `用户请求暂停音频：${file.path}`);
      player.pause();
    }
  };
  const seek = (nextTime: number) => {
    if (state !== "ready" || duration <= 0 || !Number.isFinite(nextTime)) return;
    const target = Math.min(Math.max(0, nextTime), duration);
    const player = audioElement.current;
    if (!player) return;
    player.currentTime = target;
    setCurrentTime(target);
    writeClientLog("info", `音频进度条定位：${file.path} -> ${target.toFixed(3)} 秒`);
  };
  const updateVolume = (nextVolume: number) => {
    if (nextVolume > 0) {
      setPlayerVolume(nextVolume);
      setIsMuted(false);
      onAudioPreferenceChange(nextVolume, false);
    } else {
      setIsMuted(true);
      onAudioPreferenceChange(playerVolume, true);
    }
  };
  const toggleMuted = () => {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    onAudioPreferenceChange(playerVolume, nextMuted, true);
  };

  if (previewError) return <PreviewError message={`无法预览此音频：${previewError}`} file={file} />;
  return (
    <section
      className="audio-preview"
      aria-label="音频预览"
      onPointerMove={(event) => {
        if (!(event.target instanceof Element && event.target.closest(".audio-preview-artwork"))) deferWaveformUntilIdle();
      }}
      onPointerLeave={deferWaveformUntilIdle}
    >
      <div className="audio-preview-visual">
        <div className="audio-preview-artwork" onPointerEnter={showWaveform}>
          {thumbnailSrc ? <img src={thumbnailSrc} alt="音频内嵌封面" /> : <Music2 size={52} aria-hidden="true" />}
        </div>
        <div className={`audio-waveform ${waveformVisible ? "is-visible" : ""}`} aria-label="当前播放音频的实时频谱">
          <canvas ref={spectrumCanvas} />
        </div>
        <p className="audio-preview-name" title={file.name}>{file.name}</p>
        {state === "loading" && <div className="audio-preview-status">正在加载音频与实时频谱…</div>}
      </div>
      <div className="player-controls audio-player-controls" aria-label="音频播放器控制" onPointerDown={deferWaveformUntilIdle}>
        <button type="button" disabled={state !== "ready"} onClick={togglePlayback} aria-label={isPlaying ? "暂停" : "播放"}>
          {isPlaying ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <span className="player-time">{formatPlaybackTime(currentTime)} / {formatPlaybackTime(duration)}</span>
        <input
          className="player-progress"
          type="range"
          min="0"
          max={duration || 0}
          step="0.1"
          value={Math.min(currentTime, duration || 0)}
          style={{ "--range-progress": `${duration > 0 ? Math.min(currentTime / duration, 1) * 100 : 0}%` } as CSSProperties}
          aria-label="播放进度"
          disabled={state !== "ready" || duration <= 0}
          onPointerDown={() => { isScrubbing.current = true; }}
          onInput={(event) => setCurrentTime(Number(event.currentTarget.value))}
          onPointerUp={(event) => { isScrubbing.current = false; seek(Number(event.currentTarget.value)); }}
          onPointerCancel={() => { isScrubbing.current = false; }}
          onKeyUp={(event) => {
            if (["ArrowLeft", "ArrowRight", "Home", "End", "PageDown", "PageUp"].includes(event.key)) seek(Number(event.currentTarget.value));
          }}
        />
        <button type="button" disabled={state !== "ready"} onClick={toggleMuted} aria-label={isMuted ? "取消静音" : "静音"}>
          {isMuted ? <VolumeX size={15} /> : <Volume2 size={15} />}
        </button>
        <input className="player-volume" type="range" min="0" max="100" value={isMuted ? 0 : playerVolume} style={{ "--range-progress": `${isMuted ? 0 : playerVolume}%` } as CSSProperties} disabled={state !== "ready"} onInput={(event) => updateVolume(Number(event.currentTarget.value))} aria-label="音量" />
      </div>
    </section>
  );
}
