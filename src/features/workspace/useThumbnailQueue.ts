import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { startTransition, useCallback, useEffect, useRef, useState } from "react";

import type { FileEntry, ThumbnailBatchResult, ThumbnailResult } from "../../app-types";
import { errorMessage, writeClientLog } from "../../app-utils";
import {
  clearThumbnailDataCache,
  invalidateThumbnailData,
} from "../../components/FileThumbnail";

export function useThumbnailQueue({
  workspacePath,
  concurrency,
}: {
  workspacePath: string | null;
  concurrency: number;
}) {
  const [pathOverrides, setPathOverrides] = useState<Map<string, string>>(() => new Map());
  const [visibilityRevision, setVisibilityRevision] = useState(0);
  const requests = useRef<Set<string>>(new Set());
  const pathOverrideRef = useRef<Map<string, string>>(new Map());
  const queuedPaths = useRef<Set<string>>(new Set());
  const queue = useRef<FileEntry[]>([]);
  const runQueue = useRef<() => void>(() => {});
  const dispatchScheduled = useRef(false);
  const scrollActive = useRef(false);
  const scrollTimer = useRef<number | null>(null);
  const failures = useRef<Set<string>>(new Set());

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
    invalidateThumbnailData(thumbnail.thumbnailPath);
    pathOverrideRef.current.set(thumbnail.path, thumbnail.thumbnailPath);
    startTransition(() => {
      setPathOverrides(new Map(pathOverrideRef.current));
    });
    writeClientLog("debug", `缩略图结果已应用到当前工作区：${thumbnail.path}`);
  }, []);

  runQueue.current = () => {
    const tasks: FileEntry[] = [];
    const transportWindow = Math.max(1, concurrency);
    while (requests.current.size + tasks.length < transportWindow) {
      const file = queue.current.shift();
      if (!file) {
        break;
      }
      queuedPaths.current.delete(file.path);
      if (
        file.thumbnailPath || file.kind === "text" || file.kind === "other" ||
        pathOverrideRef.current.has(file.path) ||
        requests.current.has(file.path) ||
        failures.current.has(file.path)
      ) {
        continue;
      }
      tasks.push(file);
    }
    if (tasks.length === 0) {
      return;
    }

    writeClientLog(
      "info",
      `分发缩略图批次：本批 ${tasks.length} 个，逻辑队列剩余 ${queue.current.length} 个，运行中 ${requests.current.size} 个`,
    );
    tasks.forEach((file) => requests.current.add(file.path));
    const batches = [
      ["generate_thumbnails", tasks.filter((file) => file.kind === "video")],
      ["generate_audio_thumbnails", tasks.filter((file) => file.kind === "audio")],
      ["generate_image_thumbnails", tasks.filter((file) => file.kind === "image")],
    ] as const;
    void Promise.all(batches.filter(([, files]) => files.length > 0).map(([command, files]) =>
      invoke<ThumbnailBatchResult>(command, { paths: files.map((file) => file.path) }),
    ))
      .then((results) => {
        const result = results.reduce<ThumbnailBatchResult>((all, current) => ({ thumbnails: [...all.thumbnails, ...current.thumbnails], failures: [...all.failures, ...current.failures] }), { thumbnails: [], failures: [] });
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
        tasks.forEach((file) => {
          failures.current.add(file.path);
          writeClientLog("error", `缩略图生成失败：${file.path}，${message}`);
        });
      })
      .finally(() => {
        tasks.forEach((file) => requests.current.delete(file.path));
        writeClientLog(
          "debug",
          `缩略图批次清理完成：逻辑队列剩余 ${queue.current.length} 个，运行中 ${requests.current.size} 个`,
        );
        runQueue.current();
      });
  };

  const enqueue = useCallback(
    (file: FileEntry) => {
      if (
        !workspacePath ||
        scrollActive.current ||
        file.kind === "text" || file.kind === "other" || file.thumbnailPath ||
        pathOverrideRef.current.has(file.path) || requests.current.has(file.path) ||
        queuedPaths.current.has(file.path) || failures.current.has(file.path)
      ) {
        return;
      }
      queuedPaths.current.add(file.path);
      queue.current.push(file);
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
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen<ThumbnailResult>("thumbnail-generated", (event) => applyResult(event.payload))
      .then((cleanup) => {
        if (active) {
          unlisten = cleanup;
          writeClientLog("debug", "缩略图完成事件监听已启动");
        } else {
          cleanup();
        }
      })
      .catch((listenError: unknown) => {
        writeClientLog("warn", `缩略图完成事件监听不可用，将依赖批次返回结果：${errorMessage(listenError)}`);
      });
    return () => {
      active = false;
      unlisten?.();
    };
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
