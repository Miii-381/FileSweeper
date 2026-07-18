import { FolderOpen, ScrollText, Settings, Star, StarOff, Video } from "lucide-react";

type Props = {
  isFavorite: boolean;
  hasWorkspace: boolean;
  onChooseWorkspace: () => void;
  onToggleFavorite: () => void;
  onOpenSettings: () => void;
  onOpenLogs: () => void;
};

export function AppTitlebar({
  isFavorite,
  hasWorkspace,
  onChooseWorkspace,
  onToggleFavorite,
  onOpenSettings,
  onOpenLogs,
}: Props) {
  return (
    <header className="titlebar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">
          <Video size={17} strokeWidth={2.2} />
        </div>
        <span>VideoSweeper</span>
      </div>
      <div className="titlebar-actions">
        <button className="command-button" type="button" onClick={onChooseWorkspace}>
          <FolderOpen size={16} />
          打开文件夹
        </button>
        <button
          className={`icon-button ${isFavorite ? "active" : ""}`}
          type="button"
          disabled={!hasWorkspace}
          aria-label={isFavorite ? "取消收藏当前文件夹" : "收藏当前文件夹"}
          title={isFavorite ? "取消收藏当前文件夹" : "收藏当前文件夹"}
          onClick={onToggleFavorite}
        >
          {isFavorite ? <StarOff size={17} /> : <Star size={17} />}
        </button>
        <button className="icon-button" type="button" aria-label="偏好设置" title="偏好设置" onClick={onOpenSettings}>
          <Settings size={17} />
        </button>
        <button className="icon-button" type="button" aria-label="日志" title="日志" onClick={onOpenLogs}>
          <ScrollText size={17} />
        </button>
      </div>
    </header>
  );
}
