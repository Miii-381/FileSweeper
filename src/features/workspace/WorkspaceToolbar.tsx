import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Grid2X2,
  List,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";

import type { SortKey, ViewMode } from "../../app-types";

export function WorkspaceToolbar({
  workspacePath,
  sortKey,
  sortAscending,
  viewMode,
  previewOpen,
  metadataLoading,
  onSortKeyChange,
  onToggleSortDirection,
  onViewModeChange,
  onTogglePreview,
  canNavigateBack,
  canNavigateForward,
  canNavigateUp,
  onNavigateBack,
  onNavigateForward,
  onNavigateUp,
  onNavigateTo,
}: {
  workspacePath: string | null;
  sortKey: SortKey;
  sortAscending: boolean;
  viewMode: ViewMode;
  previewOpen: boolean;
  metadataLoading: boolean;
  onSortKeyChange: (key: SortKey) => void;
  onToggleSortDirection: () => void;
  onViewModeChange: (mode: ViewMode) => void;
  onTogglePreview: () => void;
  canNavigateBack: boolean;
  canNavigateForward: boolean;
  canNavigateUp: boolean;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
  onNavigateUp: () => void;
  onNavigateTo: (path: string) => void;
}) {
  const hasWorkspace = workspacePath !== null;
  const breadcrumbs = workspacePath
    ? workspacePath.replace(/\//g, "\\").replace(/[\\/]+$/, "").split("\\").filter(Boolean).map((name, index, parts) => ({
      name,
      path: index === 0 && name.endsWith(":") ? `${name}\\` : parts.slice(0, index + 1).join("\\"),
    }))
    : [];

  return (
    <div className="workspace-toolbar">
      <div className="directory-navigation" aria-label="目录导航">
        <button className="quiet-icon-button" type="button" aria-label="后退" title="后退" disabled={!canNavigateBack} onClick={onNavigateBack}><ChevronLeft size={17} /></button>
        <button className="quiet-icon-button" type="button" aria-label="前进" title="前进" disabled={!canNavigateForward} onClick={onNavigateForward}><ChevronRight size={17} /></button>
        <button className="quiet-icon-button" type="button" aria-label="向上一级" title="向上一级" disabled={!canNavigateUp} onClick={onNavigateUp}><ChevronUp size={17} /></button>
      </div>
      <span className="workspace-path" title={workspacePath ?? undefined}>
        {breadcrumbs.length > 0 ? breadcrumbs.map((crumb, index) => (
          <span className="breadcrumb-part" key={crumb.path}>
            {index > 0 && <span className="breadcrumb-separator">›</span>}
            <button type="button" onClick={() => onNavigateTo(crumb.path)}>{crumb.name}</button>
          </span>
        )) : "未选择文件夹"}
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
