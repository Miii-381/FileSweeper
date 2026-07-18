import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { startTransition, useCallback, useEffect, useRef, useState } from "react";

import type { ThumbnailBatchResult, ThumbnailResult, VideoEntry } from "../../app-types";
import { errorMessage, writeClientLog } from "../../app-utils";
import {
  clearThumbnailDataCache,
  invalidateThumbnailData,
} from "../../components/VideoThumbnail";

export function useThumbnailQueue({
  workspacePath,
  videos,
  concurrency,
}: {
  workspacePath: string | null;
  videos: VideoEntry[];
  concurrency: number;
}) {
  const [pathOverrides, setPathOverrides] = useState<Map<string, string>>(() => new Map());
  const [visibilityRevision, setVisibilityRevision] = useState(0);
  const currentVideoPaths = useRef<Set<string>>(new Set());
  const requests = useRef<Set<string>>(new Set());
  const pathOverrideRef = useRef<Map<string, string>>(new Map());
  const queuedPaths = useRef<Set<string>>(new Set());
  const queue = useRef<VideoEntry[]>([]);
  const runQueue = useRef<() => void>(() => {});
  const dispatchScheduled = useRef(false);
  const scrollActive = useRef(false);
  const scrollTimer = useRef<number | null>(null);
  const failures = useRef<Set<string>>(new Set());

  useEffect(() => {
    currentVideoPaths.current = new Set(videos.map((video) => video.path));
  }, [videos]);

  const handleViewportScroll = useCallback(() => {
    if (!scrollActive.current) {
      writeClientLog("debug", "缩略图视口开始滚动：暂停发现新任务，保留既有队列和运行任务");
    }
    scrollActive.current = true;
    if (scrollTimer.current) {
      window.clearTimeout(scrollTimer.current);
    }
    scrollTimer.current = window.setTimeout(() => {
      scrollActive.current = false;
      scrollTimer.current = null;
      writeClientLog("debug", "缩略图视口停止滚动：恢复可见区域检查与新任务入队");
      setVisibilityRevision((revision) => revision + 1);
    }, 180);
  }, []);

  const applyResult = useCallback((thumbnail: ThumbnailResult) => {
    if (!currentVideoPaths.current.has(thumbnail.path)) {
      writeClientLog("debug", `缩略图已写入缓存但不属于当前工作区，跳过 UI 更新：${thumbnail.path}`);
      return;
    }
    invalidateThumbnailData(thumbnail.thumbnailPath);
    pathOverrideRef.current.set(thumbnail.path, thumbnail.thumbnailPath);
    startTransition(() => {
      setPathOverrides(new Map(pathOverrideRef.current));
    });
    writeClientLog("debug", `缩略图结果已应用到当前工作区：${thumbnail.path}`);
  }, []);

  runQueue.current = () => {
    const tasks: VideoEntry[] = [];
    const transportWindow = Math.max(1, concurrency);
    while (requests.current.size + tasks.length < transportWindow) {
      const video = queue.current.shift();
      if (!video) {
        break;
      }
      queuedPaths.current.delete(video.path);
      if (
        video.thumbnailPath ||
        pathOverrideRef.current.has(video.path) ||
        requests.current.has(video.path) ||
        failures.current.has(video.path)
      ) {
        continue;
      }
      tasks.push(video);
    }
    if (tasks.length === 0) {
      return;
    }

    writeClientLog(
      "info",
      `分发缩略图批次：本批 ${tasks.length} 个，逻辑队列剩余 ${queue.current.length} 个，运行中 ${requests.current.size} 个`,
    );
    tasks.forEach((video) => requests.current.add(video.path));
    void invoke<ThumbnailBatchResult>("generate_thumbnails", {
      paths: tasks.map((video) => video.path),
    })
      .then((result) => {
        writeClientLog(
          result.failures.length > 0 ? "warn" : "info",
          `缩略图批次返回：成功 ${result.thumbnails.length} 个，失败 ${result.failures.length} 个`,
        );
        result.thumbnails.forEach((thumbnail) => {
          if (pathOverrideRef.current.get(thumbnail.path) !== thumbnail.thumbnailPath) {
            applyResult(thumbnail);
          }
        });
        result.failures.forEach((failure) => {
          failures.current.add(failure.path);
          writeClientLog("error", `缩略图生成失败：${failure.path}，${failure.error}`);
        });
      })
      .catch((batchError) => {
        const message = errorMessage(batchError);
        tasks.forEach((video) => {
          failures.current.add(video.path);
          writeClientLog("error", `缩略图生成失败：${video.path}，${message}`);
        });
      })
      .finally(() => {
        tasks.forEach((video) => requests.current.delete(video.path));
        writeClientLog(
          "debug",
          `缩略图批次清理完成：逻辑队列剩余 ${queue.current.length} 个，运行中 ${requests.current.size} 个`,
        );
        runQueue.current();
      });
  };

  const enqueue = useCallback(
    (video: VideoEntry) => {
      if (
        !workspacePath ||
        scrollActive.current ||
        video.thumbnailPath ||
        pathOverrideRef.current.has(video.path) ||
        requests.current.has(video.path) ||
        queuedPaths.current.has(video.path) ||
        failures.current.has(video.path)
      ) {
        return;
      }
      queuedPaths.current.add(video.path);
      queue.current.push(video);
      if (!dispatchScheduled.current) {
        dispatchScheduled.current = true;
        queueMicrotask(() => {
          dispatchScheduled.current = false;
          runQueue.current();
        });
      }
    },
    [workspacePath],
  );

  const clearDisplayOverrides = useCallback(() => {
    pathOverrideRef.current.clear();
    setPathOverrides(new Map());
  }, []);

  const resetForCapturePosition = useCallback(() => {
    clearThumbnailDataCache();
    failures.current.clear();
    clearDisplayOverrides();
  }, [clearDisplayOverrides]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<ThumbnailResult>("thumbnail-generated", (event) => applyResult(event.payload))
      .then((cleanup) => {
        unlisten = cleanup;
        writeClientLog("debug", "缩略图完成事件监听已启动");
      })
      .catch((listenError: unknown) => {
        writeClientLog("warn", `缩略图完成事件监听不可用，将依赖批次返回结果：${errorMessage(listenError)}`);
      });
    return () => unlisten?.();
  }, [applyResult]);

  useEffect(
    () => () => {
      if (scrollTimer.current) {
        window.clearTimeout(scrollTimer.current);
      }
    },
    [],
  );

  return {
    pathOverrides,
    visibilityRevision,
    handleViewportScroll,
    enqueue,
    clearDisplayOverrides,
    resetForCapturePosition,
  };
}
