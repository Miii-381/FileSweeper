import { ClipboardCopy, RefreshCw, X } from "lucide-react";

import type { LogSnapshot } from "../../app-types";
import { formatBytes, type LogMinimumLevel } from "../../app-utils";

export function LogDialog({
  snapshot,
  content,
  error,
  loading,
  minimumLevel,
  onMinimumLevelChange,
  onRefresh,
  onCopy,
  onClose,
}: {
  snapshot: LogSnapshot | null;
  content: string;
  error: string | null;
  loading: boolean;
  minimumLevel: LogMinimumLevel;
  onMinimumLevelChange: (level: LogMinimumLevel) => void;
  onRefresh: () => void;
  onCopy: () => void;
  onClose: () => void;
}) {
  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="logs-dialog" role="dialog" aria-modal="true" aria-labelledby="logs-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="settings-header">
          <div><span>诊断</span><h2 id="logs-title">运行日志</h2></div>
          <div className="logs-actions">
            <select
              className="logs-level-select"
              aria-label="日志最低级别"
              value={minimumLevel}
              onChange={(event) => onMinimumLevelChange(event.target.value as LogMinimumLevel)}
            >
              <option value="warn">警告及以上</option>
              <option value="info">信息及以上</option>
              <option value="debug">调试及以上</option>
            </select>
            <button className="quiet-icon-button" type="button" aria-label="刷新日志" title="刷新" disabled={loading} onClick={onRefresh}>
              <RefreshCw size={17} />
            </button>
            <button className="quiet-icon-button" type="button" aria-label="复制日志" title="复制" disabled={!content.trim()} onClick={onCopy}>
              <ClipboardCopy size={17} />
            </button>
            <button className="quiet-icon-button" type="button" aria-label="关闭日志" title="关闭" onClick={onClose}>
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="logs-body">
          <div className="log-meta">
            <span title={snapshot?.path}>{snapshot?.path ?? "日志文件尚未创建"}</span>
            <span>{snapshot ? formatBytes(snapshot.size) : "-"}</span>
          </div>
          {error && <div className="log-error">{error}</div>}
          <section className="log-section">
            <h3>文件日志</h3>
            <pre className="log-output">{loading ? "正在读取日志..." : content.trim() || "当前级别下暂无日志"}</pre>
          </section>
        </div>
      </section>
    </div>
  );
}
