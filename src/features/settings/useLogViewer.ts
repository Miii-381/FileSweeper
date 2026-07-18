import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { LogSnapshot } from "../../app-types";
import {
  errorMessage,
  filterLogContent,
  type LogMinimumLevel,
  writeClientLog,
} from "../../app-utils";

export function useLogViewer(notify: (message: string) => void) {
  const [isOpen, setIsOpen] = useState(false);
  const [minimumLevel, setMinimumLevel] = useState<LogMinimumLevel>("warn");
  const [snapshot, setSnapshot] = useState<LogSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const pollTimer = useRef<number | null>(null);
  const pollInFlight = useRef(false);
  const hash = useRef<string | null>(null);

  const content = useMemo(
    () => filterLogContent(snapshot?.content ?? "", minimumLevel),
    [minimumLevel, snapshot],
  );

  const pollLogs = useCallback(async (force = false) => {
    if (pollInFlight.current) {
      return;
    }
    pollInFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      const nextSnapshot = await invoke<LogSnapshot>("poll_log_file", {
        previousHash: force ? null : hash.current,
        maxBytes: 512 * 1024,
      });
      hash.current = nextSnapshot.hash;
      if (nextSnapshot.changed) {
        setSnapshot(nextSnapshot);
      }
    } catch (pollError) {
      const message = errorMessage(pollError);
      setError(message);
      writeClientLog("error", `读取日志失败：${message}`);
    } finally {
      setLoading(false);
      pollInFlight.current = false;
    }
  }, []);

  const open = useCallback(() => {
    setSnapshot(null);
    hash.current = null;
    setError(null);
    setIsOpen(true);
    writeClientLog("info", "打开日志面板");
  }, []);

  const close = useCallback(() => {
    writeClientLog("info", "关闭日志面板并停止文件轮询");
    setIsOpen(false);
    setSnapshot(null);
    hash.current = null;
    setError(null);
  }, []);

  const copy = useCallback(async () => {
    const text = content.trim();
    if (!text) {
      notify("暂无日志内容可复制");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      notify("日志内容已复制");
      writeClientLog("info", "复制日志内容");
    } catch (copyError) {
      const message = errorMessage(copyError);
      notify(message);
      writeClientLog("error", `复制日志失败：${message}`);
    }
  }, [content, notify]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    let active = true;
    const schedule = () => {
      if (!active) {
        return;
      }
      pollTimer.current = window.setTimeout(async () => {
        if (document.visibilityState === "visible") {
          await pollLogs();
        }
        schedule();
      }, 2500);
    };
    void pollLogs(true).finally(schedule);
    return () => {
      active = false;
      if (pollTimer.current !== null) {
        window.clearTimeout(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [isOpen, pollLogs]);

  return {
    isOpen,
    snapshot,
    content,
    error,
    loading,
    minimumLevel,
    setMinimumLevel,
    pollLogs,
    open,
    close,
    copy,
  };
}
