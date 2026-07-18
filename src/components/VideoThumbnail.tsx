import { invoke } from "@tauri-apps/api/core";
import { Video } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import type { ThumbnailData, VideoEntry } from "../app-types";
import { errorMessage, writeClientLog } from "../app-utils";

const thumbnailDataUrls = new Map<string, string>();
const thumbnailDataRequests = new Map<string, Promise<string>>();
const MAX_THUMBNAIL_DATA_CACHE_BYTES = 64 * 1024 * 1024;
let thumbnailDataCacheBytes = 0;

function dataUrlMemorySize(dataUrl: string) {
  return dataUrl.length * 2;
}

function getCachedThumbnailData(thumbnailPath: string) {
  const dataUrl = thumbnailDataUrls.get(thumbnailPath);
  if (!dataUrl) {
    return null;
  }
  thumbnailDataUrls.delete(thumbnailPath);
  thumbnailDataUrls.set(thumbnailPath, dataUrl);
  return dataUrl;
}

function cacheThumbnailData(thumbnailPath: string, dataUrl: string) {
  const previous = thumbnailDataUrls.get(thumbnailPath);
  if (previous) {
    thumbnailDataCacheBytes -= dataUrlMemorySize(previous);
    thumbnailDataUrls.delete(thumbnailPath);
  }
  thumbnailDataUrls.set(thumbnailPath, dataUrl);
  thumbnailDataCacheBytes += dataUrlMemorySize(dataUrl);
  let evicted = 0;
  while (thumbnailDataCacheBytes > MAX_THUMBNAIL_DATA_CACHE_BYTES && thumbnailDataUrls.size > 1) {
    const oldest = thumbnailDataUrls.entries().next().value;
    if (!oldest) {
      break;
    }
    const [oldestPath, oldestDataUrl] = oldest;
    thumbnailDataUrls.delete(oldestPath);
    thumbnailDataCacheBytes -= dataUrlMemorySize(oldestDataUrl);
    evicted += 1;
  }
  if (evicted > 0) {
    writeClientLog(
      "debug",
      `缩略图内存缓存执行 LRU 淘汰：淘汰 ${evicted} 项，保留 ${thumbnailDataUrls.size} 项，估算字节 ${thumbnailDataCacheBytes}`,
    );
  }
}

export function invalidateThumbnailData(thumbnailPath: string) {
  const dataUrl = thumbnailDataUrls.get(thumbnailPath);
  if (dataUrl) {
    thumbnailDataCacheBytes -= dataUrlMemorySize(dataUrl);
    thumbnailDataUrls.delete(thumbnailPath);
    writeClientLog("debug", `缩略图内存缓存失效：${thumbnailPath}`);
  }
}

export function clearThumbnailDataCache() {
  const entries = thumbnailDataUrls.size;
  thumbnailDataUrls.clear();
  thumbnailDataRequests.clear();
  thumbnailDataCacheBytes = 0;
  writeClientLog("info", `清空缩略图内存缓存：${entries} 项`);
}


export function loadThumbnailData(video: VideoEntry, thumbnailPath: string | null) {
  if (!thumbnailPath) {
    return Promise.resolve<string | null>(null);
  }

  const cached = getCachedThumbnailData(thumbnailPath);
  if (cached) {
    return Promise.resolve(cached);
  }

  const pending = thumbnailDataRequests.get(thumbnailPath);
  if (pending) {
    writeClientLog("debug", `复用进行中的缩略图读取请求：${thumbnailPath}`);
    return pending;
  }

  const request = invoke<ThumbnailData>("read_thumbnail", { path: video.path })
    .then((result) => {
      cacheThumbnailData(result.thumbnailPath, result.dataUrl);
      return result.dataUrl;
    })
    .finally(() => {
      thumbnailDataRequests.delete(thumbnailPath);
    });
  thumbnailDataRequests.set(thumbnailPath, request);
  return request;
}

export const VideoThumbnail = memo(function VideoThumbnail({
  video,
  thumbnailPath,
  visibilityRevision,
  compact = false,
  onVisible,
}: {
  video: VideoEntry;
  thumbnailPath: string | null;
  visibilityRevision: number;
  compact?: boolean;
  onVisible?: (video: VideoEntry) => void;
}) {
  const thumbnailElement = useRef<HTMLSpanElement>(null);
  const [failedPath, setFailedPath] = useState<string | null>(null);
  const [thumbnailSrc, setThumbnailSrc] = useState<string | null>(() =>
    thumbnailPath ? getCachedThumbnailData(thumbnailPath) : null,
  );

  useEffect(() => {
    let active = true;
    setFailedPath(null);

    if (!thumbnailPath) {
      setThumbnailSrc(null);
      return () => {
        active = false;
      };
    }

    const cached = getCachedThumbnailData(thumbnailPath);
    if (cached) {
      setThumbnailSrc(cached);
      return () => {
        active = false;
      };
    }

    setThumbnailSrc(null);
    void loadThumbnailData(video, thumbnailPath)
      .then((source) => {
        if (active) {
          setThumbnailSrc(source);
        }
      })
      .catch((error) => {
        if (active) {
          setFailedPath(thumbnailPath);
          writeClientLog("error", `读取缩略图缓存失败：${thumbnailPath}，${errorMessage(error)}`);
        }
      });

    return () => {
      active = false;
    };
  }, [thumbnailPath, video.path]);

  useEffect(() => {
    if (thumbnailPath || !onVisible) {
      return;
    }

    const element = thumbnailElement.current;
    if (!element) {
      return;
    }
    if (!("IntersectionObserver" in window)) {
      writeClientLog("warn", `浏览器不支持 IntersectionObserver，回退为立即请求缩略图：${video.path}`);
      onVisible(video);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onVisible(video);
          observer.disconnect();
        }
      },
      { rootMargin: "240px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [onVisible, thumbnailPath, video, visibilityRevision]);

  const hasImage = thumbnailSrc !== null && thumbnailPath !== failedPath;

  return (
    <span
      ref={thumbnailElement}
      className={`video-thumbnail ${compact ? "compact-thumbnail" : ""} ${hasImage ? "has-image" : ""}`}
    >
      {hasImage ? (
        <img
          src={thumbnailSrc ?? ""}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => {
            setFailedPath(thumbnailPath);
            writeClientLog("error", `缩略图显示失败：${thumbnailPath}`);
          }}
        />
      ) : (
        <>
          <Video size={compact ? 15 : 26} />
          {!compact && <span>{video.extension.slice(1).toUpperCase()}</span>}
        </>
      )}
    </span>
  );
});
