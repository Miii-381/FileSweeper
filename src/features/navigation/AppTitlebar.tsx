import { File, FolderOpen, ScrollText, Search, Settings, Star, StarOff } from "lucide-react";

type Props = {
  isFavorite: boolean;
  hasWorkspace: boolean;
  searchQuery: string;
  onChooseWorkspace: () => void;
  onSearchChange: (query: string) => void;
  onToggleFavorite: () => void;
  onOpenSettings: () => void;
  onOpenLogs: () => void;
};

export function AppTitlebar({
  isFavorite,
  hasWorkspace,
  searchQuery,
  onChooseWorkspace,
  onSearchChange,
  onToggleFavorite,
  onOpenSettings,
  onOpenLogs,
}: Props) {
  return (
    <header className="titlebar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">
          <File size={17} strokeWidth={2.2} />
        </div>
        <span>FileSweeper</span>
      </div>
      <label className="search-field titlebar-search">
        <Search size={16} />
        <input
          type="search"
          value={searchQuery}
          disabled={!hasWorkspace}
          placeholder="搜索当前文件夹"
          aria-label="搜索当前文件夹"
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </label>
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
