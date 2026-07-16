import {
  debug as logDebug,
  error as logErrorMessage,
  info as logInfo,
  LogLevel,
  warn as logWarn,
} from "@tauri-apps/plugin-log";

export type LogMinimumLevel = "warn" | "info" | "debug";

type VideoDimensions = {
  width: number | null;
  height: number | null;
};

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function formatBytes(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(size) / Math.log(1024)) - 1, units.length - 1);
  return `${(size / 1024 ** (unitIndex + 1)).toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function formatDate(timestamp: number | null) {
  if (!timestamp) {
    return "-";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

export function formatDuration(duration: number | null) {
  return duration === null ? "-" : formatPlaybackTime(duration);
}

export function formatResolution(video: VideoDimensions) {
  return video.width && video.height ? `${video.width} × ${video.height}` : "-";
}

export function formatPlaybackTime(value: number) {
  if (!Number.isFinite(value) || value < 0) {
    return "--:--";
  }
  const totalSeconds = Math.floor(value);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
    : `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function logLevelLabel(level: LogLevel) {
  return LogLevel[level]?.toUpperCase() ?? "LOG";
}

export function logLevelRank(level: string) {
  if (level.includes("ERROR")) {
    return 4;
  }
  if (level.includes("WARN")) {
    return 3;
  }
  if (level.includes("INFO")) {
    return 2;
  }
  if (level.includes("DEBUG")) {
    return 1;
  }
  return 0;
}

export function minimumLogLevelRank(level: LogMinimumLevel) {
  return level === "warn" ? 3 : level === "info" ? 2 : 1;
}

export function filterLogContent(content: string, minimumLevel: LogMinimumLevel) {
  const requiredRank = minimumLogLevelRank(minimumLevel);
  return content
    .split("\n")
    .filter((line) => {
      const level = line.match(/\]\[(TRACE|DEBUG|INFO|WARN|ERROR)\]/i)?.[1];
      return level ? logLevelRank(level.toUpperCase()) >= requiredRank : false;
    })
    .join("\n");
}

export function writeClientLog(level: "debug" | "info" | "warn" | "error", message: string) {
  const logger =
    level === "debug" ? logDebug : level === "info" ? logInfo : level === "warn" ? logWarn : logErrorMessage;
  void logger(message, { file: "src/App.tsx" }).catch(() => {
    // The Vite browser shell has no Tauri log plugin; ignore that path during local UI-only previews.
  });
}
