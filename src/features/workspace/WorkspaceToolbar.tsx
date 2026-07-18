import {
  ChevronDown,
  Grid2X2,
  List,
  PanelRightClose,
  PanelRightOpen,
  Search,
} from "lucide-react";

import type { SortKey, ViewMode } from "../../app-types";

export function WorkspaceToolbar({
  workspacePath,
  searchQuery,
  sortKey,
  sortAscending,
  viewMode,
  previewOpen,
  metadataLoading,
  onSearchChange,
  onSortKeyChange,
  onToggleSortDirection,
  onViewModeChange,
  onTogglePreview,
}: {
  workspacePath: string | null;
  searchQuery: string;
  sortKey: SortKey;
  sortAscending: boolean;
  viewMode: ViewMode;
  previewOpen: boolean;
  metadataLoading: boolean;
  onSearchChange: (query: string) => void;
  onSortKeyChange: (key: SortKey) => void;
  onToggleSortDirection: () => void;
  onViewModeChange: (mode: ViewMode) => void;
  onTogglePreview: () => void;
}) {
  const hasWorkspace = workspacePath !== null;

  return (
    <div className="workspace-toolbar">
      <label className="search-field">
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
      <span className="workspace-path" title={workspacePath ?? undefined}>
        {workspacePath ?? "未选择工作区"}
      </span>
      <div className="toolbar-divider" />
      <label className="sort-select">
        <span className="sr-only">排序字段</span>
        <select
          value={sortKey}
          onChange={(event) => onSortKeyChange(event.target.value as SortKey)}
          disabled={!hasWorkspace || metadataLoading}
        >
          <option value="createdAt">创建日期</option>
          <option value="name">名称</option>
          <option value="size">大小</option>
          <option value="duration">时长</option>
          <option value="resolution">分辨率</option>
        </select>
      </label>
      <button
        className="sort-button"
        type="button"
        disabled={!hasWorkspace}
        aria-label={sortAscending ? "改为降序" : "改为升序"}
        title={sortAscending ? "降序" : "升序"}
        onClick={onToggleSortDirection}
      >
        <ChevronDown size={16} className={sortAscending ? "sort-ascending" : ""} />
      </button>
      <div className="view-toggle" aria-label="视图模式">
        <button
          className={viewMode === "grid" ? "active" : ""}
          type="button"
          aria-label="网格视图"
          title="网格视图"
          onClick={() => onViewModeChange("grid")}
        >
          <Grid2X2 size={16} />
        </button>
        <button
          className={viewMode === "list" ? "active" : ""}
          type="button"
          aria-label="列表视图"
          title="列表视图"
          onClick={() => onViewModeChange("list")}
        >
          <List size={17} />
        </button>
      </div>
      <button
        className="quiet-icon-button preview-toggle"
        type="button"
        aria-label={previewOpen ? "折叠预览面板" : "展开预览面板"}
        title={previewOpen ? "折叠预览面板" : "展开预览面板"}
        onClick={onTogglePreview}
      >
        {previewOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
      </button>
    </div>
  );
}
