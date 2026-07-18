import type { Virtualizer } from "@tanstack/react-virtual";
import { Panel } from "react-resizable-panels";
import { ChevronsUp, CircleDot, Folder, FolderOpen, Video } from "lucide-react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, RefObject } from "react";

import { listColumnLabels, type ListColumn, type ListColumnId, type SortKey, type VideoEntry, type ViewMode, type WorkspaceListing, type WorkspaceSelectionBox } from "../../app-types";
import { formatBytes, formatDate, formatDuration, formatResolution, writeClientLog } from "../../app-utils";
import { VideoThumbnail } from "../../components/VideoThumbnail";
import { WorkspaceToolbar } from "./WorkspaceToolbar";

type WorkspacePanelProps = {
  isPreviewOpen: boolean;
  workspaceMinSize: number;
  workspace: WorkspaceListing | null;
  workspaceLoading: boolean;
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  sortKey: SortKey;
  sortAscending: boolean;
  viewMode: ViewMode;
  metadataLoading: boolean;
  changeWorkspaceSortKey: (key: SortKey) => void;
  toggleWorkspaceSortDirection: () => void;
  changeWorkspaceViewMode: (mode: ViewMode) => void;
  togglePreviewPanel: () => void;
  chooseWorkspaceFolder: () => void;
  visibleVideos: VideoEntry[];
  clearWorkspaceSelection: () => void;
  showWorkspaceContextMenu: (event: ReactMouseEvent<HTMLElement>, paths?: string[]) => void;
  setGridScrollRef: (element: HTMLDivElement | null) => void;
  handleThumbnailViewportScroll: () => void;
  clearSelectionFromBackground: (event: ReactMouseEvent<HTMLElement>) => void;
  startWorkspaceRectangleSelection: (event: ReactPointerEvent<HTMLDivElement>, mode: ViewMode) => void;
  updateWorkspaceRectangleSelection: (event: ReactPointerEvent<HTMLDivElement>) => void;
  finishWorkspaceRectangleSelection: (event: ReactPointerEvent<HTMLDivElement>) => void;
  gridRowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  gridColumns: number;
  selectedVideos: Set<string>;
  renamingPath: string | null;
  startVideoFileDrag: (event: ReactPointerEvent<HTMLDivElement>, path: string) => void;
  updateVideoFileDrag: (event: ReactPointerEvent<HTMLDivElement>) => void;
  finishVideoFileDrag: (event: ReactPointerEvent<HTMLDivElement>) => void;
  selectVideo: (event: ReactMouseEvent<HTMLElement>, path: string) => void;
  showVideoContextMenu: (event: ReactMouseEvent<HTMLElement>, path: string) => void;
  thumbnailPathOverrides: Map<string, string>;
  thumbnailVisibilityRevision: number;
  enqueueThumbnail: (video: VideoEntry) => void;
  renameInputRef: RefObject<HTMLInputElement | null>;
  renameDraft: string;
  setRenameDraft: (value: string) => void;
  submitInlineRename: () => Promise<void>;
  cancelInlineRename: () => void;
  workspaceSelectionBox: WorkspaceSelectionBox | null;
  listScrollElement: RefObject<HTMLDivElement | null>;
  listGridStyle: CSSProperties;
  visibleListColumns: ListColumn[];
  draggedListColumn: ListColumnId | null;
  listColumnDropTarget: ListColumnId | null;
  listColumnDropPosition: "before" | "after" | null;
  startListColumnReorder: (event: ReactPointerEvent<HTMLSpanElement>, id: ListColumnId) => void;
  startListColumnResize: (event: ReactPointerEvent<HTMLSpanElement>, id: ListColumnId) => void;
  listRowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  scrollWorkspaceToFocus: () => void;
  scrollWorkspaceToStart: () => void;
  isExternalDropActive: boolean;
};

export function WorkspacePanel(props: WorkspacePanelProps) {
  const {
    isPreviewOpen, workspaceMinSize, workspace, workspaceLoading, searchQuery, setSearchQuery,
    sortKey, sortAscending, viewMode, metadataLoading, changeWorkspaceSortKey,
    toggleWorkspaceSortDirection, changeWorkspaceViewMode, togglePreviewPanel, chooseWorkspaceFolder,
    visibleVideos, clearWorkspaceSelection, showWorkspaceContextMenu, setGridScrollRef,
    handleThumbnailViewportScroll, clearSelectionFromBackground, startWorkspaceRectangleSelection,
    updateWorkspaceRectangleSelection, finishWorkspaceRectangleSelection, gridRowVirtualizer,
    gridColumns, selectedVideos, renamingPath, startVideoFileDrag, updateVideoFileDrag,
    finishVideoFileDrag, selectVideo, showVideoContextMenu, thumbnailPathOverrides,
    thumbnailVisibilityRevision, enqueueThumbnail, renameInputRef, renameDraft, setRenameDraft,
    submitInlineRename, cancelInlineRename, workspaceSelectionBox, listScrollElement, listGridStyle,
    visibleListColumns, draggedListColumn, listColumnDropTarget, listColumnDropPosition,
    startListColumnReorder, startListColumnResize, listRowVirtualizer, scrollWorkspaceToFocus,
    scrollWorkspaceToStart, isExternalDropActive,
  } = props;
  return (
      <Panel defaultSize={isPreviewOpen ? 54 : 80} minSize={workspaceMinSize}>

      <section className="workspace">
        <WorkspaceToolbar
          workspacePath={workspace?.path ?? null}
          searchQuery={searchQuery}
          sortKey={sortKey}
          sortAscending={sortAscending}
          viewMode={viewMode}
          previewOpen={isPreviewOpen}
          metadataLoading={metadataLoading}
          onSearchChange={setSearchQuery}
          onSortKeyChange={changeWorkspaceSortKey}
          onToggleSortDirection={toggleWorkspaceSortDirection}
          onViewModeChange={changeWorkspaceViewMode}
          onTogglePreview={togglePreviewPanel}
        />

        {!workspace || workspaceLoading ? (
          <div className="empty-workspace">
            <div className="empty-symbol" aria-hidden="true">
              <Folder size={28} />
            </div>
            <h1>{workspaceLoading ? "正在读取工作区" : "选择一个文件夹以开始"}</h1>
            {!workspaceLoading && (
              <button className="command-button primary-command" type="button" onClick={chooseWorkspaceFolder}>
                <FolderOpen size={16} />
                打开文件夹
              </button>
            )}
          </div>
        ) : visibleVideos.length === 0 ? (
          <div
            className="empty-workspace compact-empty"
            onClick={clearWorkspaceSelection}
            onContextMenu={(event) => showWorkspaceContextMenu(event)}
          >
            <div className="empty-symbol" aria-hidden="true">
              <Video size={28} />
            </div>
            <h1>
              {!workspace.isAvailable
                ? "此位置暂不可用，正在等待设备或网络位置恢复"
                : workspace.mediaSuppressed
                ? "此目录的媒体已被 .nomedia 隐藏"
                : searchQuery
                  ? "没有匹配的视频"
                  : "此目录没有受支持的视频"}
            </h1>
          </div>
        ) : viewMode === "grid" ? (
          <div
            ref={setGridScrollRef}
            className="video-grid"
            role="list"
            aria-label="视频文件"
            onScroll={handleThumbnailViewportScroll}
            onClick={clearSelectionFromBackground}
            onContextMenu={(event) => showWorkspaceContextMenu(event)}
            onPointerDown={(event) => startWorkspaceRectangleSelection(event, "grid")}
            onPointerMove={updateWorkspaceRectangleSelection}
            onPointerUp={finishWorkspaceRectangleSelection}
            onPointerCancel={finishWorkspaceRectangleSelection}
          >
            <div className="video-grid-virtualizer" style={{ height: gridRowVirtualizer.getTotalSize() }}>
              {gridRowVirtualizer.getVirtualItems().map((virtualRow) => (
                <div
                  className="video-grid-row"
                  key={virtualRow.key}
                  style={{
                    "--grid-columns": String(gridColumns),
                    transform: `translateY(${virtualRow.start}px)`,
                  } as CSSProperties}
                >
                  {visibleVideos
                    .slice(virtualRow.index * gridColumns, (virtualRow.index + 1) * gridColumns)
                    .map((video) => (
                      <div
                        className={`video-card ${selectedVideos.has(video.path) ? "selected" : ""}`}
                        key={video.path}
                        data-video-path={video.path}
                        draggable={false}
                        role="listitem"
                        tabIndex={0}
                        title={renamingPath === video.path ? undefined : video.name}
                        onPointerDown={(event) => startVideoFileDrag(event, video.path)}
                        onPointerMove={updateVideoFileDrag}
                        onPointerUp={finishVideoFileDrag}
                        onPointerCancel={finishVideoFileDrag}
                        onDragStart={(event) => {
                          event.preventDefault();
                          writeClientLog("debug", `已阻止浏览器原生缩略图拖拽：${video.path}`);
                        }}
                        onClick={(event) => selectVideo(event, video.path)}
                        onContextMenu={(event) => showVideoContextMenu(event, video.path)}
                      >
                        <VideoThumbnail
                          video={video}
                          thumbnailPath={thumbnailPathOverrides.get(video.path) ?? video.thumbnailPath}
                          visibilityRevision={thumbnailVisibilityRevision}
                          onVisible={enqueueThumbnail}
                        />
                        {renamingPath === video.path ? (
                          <span className="inline-rename" onClick={(event) => event.stopPropagation()}>
                            <input
                              ref={renameInputRef}
                              value={renameDraft}
                              aria-label="新文件名"
                              onChange={(event) => setRenameDraft(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  void submitInlineRename();
                                } else if (event.key === "Escape") {
                                  event.preventDefault();
                                  cancelInlineRename();
                                }
                              }}
                              onBlur={() => void submitInlineRename()}
                            />
                            <span className="rename-extension">{video.extension}</span>
                          </span>
                        ) : (
                          <span className="video-name">{video.name}</span>
                        )}
                        <span className="video-meta">
                          {formatBytes(video.size)} · {formatDate(video.createdAt)}
                        </span>
                      </div>
                    ))}
                </div>
              ))}
            </div>
            {workspaceSelectionBox?.viewMode === "grid" && (
              <div
                className="workspace-selection-box"
                aria-hidden="true"
                style={{
                  left: workspaceSelectionBox.left,
                  top: workspaceSelectionBox.top,
                  width: workspaceSelectionBox.width,
                  height: workspaceSelectionBox.height,
                }}
              />
            )}
          </div>
        ) : (
          <div
            ref={listScrollElement}
            className="video-list"
            role="table"
            aria-label="视频文件"
            style={listGridStyle}
            onScroll={handleThumbnailViewportScroll}
            onClick={clearSelectionFromBackground}
            onContextMenu={(event) => showWorkspaceContextMenu(event)}
            onPointerDown={(event) => startWorkspaceRectangleSelection(event, "list")}
            onPointerMove={updateWorkspaceRectangleSelection}
            onPointerUp={finishWorkspaceRectangleSelection}
            onPointerCancel={finishWorkspaceRectangleSelection}
          >
            <div className="video-list-header" role="row">
              {visibleListColumns.map((column) => (
                <span
                  className={`list-header-cell ${draggedListColumn === column.id ? "dragging" : ""} ${
                    listColumnDropTarget === column.id ? "drop-target" : ""
                  } ${
                    listColumnDropTarget === column.id && listColumnDropPosition ? `drop-${listColumnDropPosition}` : ""
                  }`}
                  data-list-column-id={column.id}
                  key={column.id}
                  onPointerDown={(event) => startListColumnReorder(event, column.id)}
                >
                  <span>{listColumnLabels[column.id]}</span>
                  <span
                    className="column-resize-handle"
                    role="separator"
                    aria-label={`调整${listColumnLabels[column.id]}列宽`}
                    onPointerDown={(event) => startListColumnResize(event, column.id)}
                  />
                </span>
              ))}
            </div>
            <div className="video-list-virtualizer" style={{ height: listRowVirtualizer.getTotalSize() }}>
              {listRowVirtualizer.getVirtualItems().map((virtualRow) => {
                const video = visibleVideos[virtualRow.index];
                return (
                  <div
                    className={`video-list-row ${selectedVideos.has(video.path) ? "selected" : ""}`}
                    role="row"
                    key={video.path}
                    data-video-path={video.path}
                    draggable={false}
                    tabIndex={0}
                    style={{ ...listGridStyle, transform: `translateY(${virtualRow.start}px)` }}
                    onPointerDown={(event) => startVideoFileDrag(event, video.path)}
                    onPointerMove={updateVideoFileDrag}
                    onPointerUp={finishVideoFileDrag}
                    onPointerCancel={finishVideoFileDrag}
                    onDragStart={(event) => {
                      event.preventDefault();
                      writeClientLog("debug", `已阻止浏览器原生缩略图拖拽：${video.path}`);
                    }}
                    onClick={(event) => selectVideo(event, video.path)}
                    onContextMenu={(event) => showVideoContextMenu(event, video.path)}
                  >
                    {visibleListColumns.map((column) => {
                      if (column.id === "name") {
                        return (
                          <span className="list-name" key={column.id}>
                            <VideoThumbnail
                              video={video}
                              thumbnailPath={thumbnailPathOverrides.get(video.path) ?? video.thumbnailPath}
                              visibilityRevision={thumbnailVisibilityRevision}
                              compact
                              onVisible={enqueueThumbnail}
                            />
                            {renamingPath === video.path ? (
                              <span className="inline-rename" onClick={(event) => event.stopPropagation()}>
                                <input
                                  ref={renameInputRef}
                                  value={renameDraft}
                                  aria-label="新文件名"
                                  onChange={(event) => setRenameDraft(event.target.value)}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                      event.preventDefault();
                                      void submitInlineRename();
                                    } else if (event.key === "Escape") {
                                      event.preventDefault();
                                      cancelInlineRename();
                                    }
                                  }}
                                  onBlur={() => void submitInlineRename()}
                                />
                                <span className="rename-extension">{video.extension}</span>
                              </span>
                            ) : (
                              <span title={video.name}>{video.name}</span>
                            )}
                          </span>
                        );
                      }
                      if (column.id === "size") {
                        return <span key={column.id}>{formatBytes(video.size)}</span>;
                      }
                      if (column.id === "modifiedAt") {
                        return <span key={column.id}>{formatDate(video.modifiedAt)}</span>;
                      }
                      if (column.id === "duration") {
                        return <span key={column.id}>{formatDuration(video.duration)}</span>;
                      }
                      if (column.id === "resolution") {
                        return <span key={column.id}>{formatResolution(video)}</span>;
                      }
                      return <span key={column.id}>-</span>;
                    })}
                  </div>
                );
              })}
            </div>
            {workspaceSelectionBox?.viewMode === "list" && (
              <div
                className="workspace-selection-box"
                aria-hidden="true"
                style={{
                  left: workspaceSelectionBox.left,
                  top: workspaceSelectionBox.top,
                  width: workspaceSelectionBox.width,
                  height: workspaceSelectionBox.height,
                }}
              />
            )}
          </div>
        )}
        {workspace && visibleVideos.length > 0 && (
          <div className="workspace-scroll-actions" aria-label="工作区快速滚动">
            <button
              className="workspace-scroll-action"
              type="button"
              data-tooltip="回到焦点"
              aria-label="回到焦点"
              onClick={scrollWorkspaceToFocus}
            >
              <CircleDot size={18} />
            </button>
            <button
              className="workspace-scroll-action"
              type="button"
              data-tooltip="回到开头"
              aria-label="回到开头"
              onClick={scrollWorkspaceToStart}
            >
              <ChevronsUp size={18} />
            </button>
          </div>
        )}
        {isExternalDropActive && workspace && (
          <div className="workspace-drop-indicator" aria-hidden="true">
            <FolderOpen size={26} />
            <span>松开以复制视频到当前工作区</span>
          </div>
        )}
      </section>
      </Panel>
  );
}
