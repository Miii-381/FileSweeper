import type { Virtualizer } from "@tanstack/react-virtual";
import { Panel } from "react-resizable-panels";
import { ChevronsUp, CircleDot, File, Folder, FolderOpen } from "lucide-react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, RefObject } from "react";

import { isFileEntry, isFolderEntry, listColumnLabels, type FileEntry, type ListColumn, type ListColumnId, type SortKey, type DirectoryItem, type ViewMode, type WorkspaceListing, type WorkspaceSelectionBox } from "../../app-types";
import { formatBytes, formatDate, formatDuration, formatResolution, writeClientLog } from "../../app-utils";
import { FileThumbnail } from "../../components/FileThumbnail";
import { FolderThumbnail } from "../../components/FolderThumbnail";
import { WorkspaceToolbar } from "./WorkspaceToolbar";

type WorkspacePanelProps = {
  isPreviewOpen: boolean;
  workspaceMinSize: number;
  workspace: WorkspaceListing | null;
  workspaceLoading: boolean;
  searchQuery: string;
  sortKey: SortKey;
  sortAscending: boolean;
  viewMode: ViewMode;
  metadataLoading: boolean;
  changeWorkspaceSortKey: (key: SortKey) => void;
  toggleWorkspaceSortDirection: () => void;
  changeWorkspaceViewMode: (mode: ViewMode) => void;
  togglePreviewPanel: () => void;
  canNavigateBack: boolean;
  canNavigateForward: boolean;
  canNavigateUp: boolean;
  navigateBack: () => void;
  navigateForward: () => void;
  navigateUp: () => void;
  navigateTo: (path: string) => void;
  chooseWorkspaceFolder: () => void;
  visibleFiles: DirectoryItem[];
  openFolder: (path: string) => void;
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
  selectedFiles: Set<string>;
  renamingPath: string | null;
  startWorkspaceFileDrag: (event: ReactPointerEvent<HTMLDivElement>, path: string) => void;
  updateWorkspaceFileDrag: (event: ReactPointerEvent<HTMLDivElement>) => void;
  finishWorkspaceFileDrag: (event: ReactPointerEvent<HTMLDivElement>) => void;
  selectFile: (event: ReactMouseEvent<HTMLElement>, path: string) => void;
  showFileContextMenu: (event: ReactMouseEvent<HTMLElement>, path: string) => void;
  thumbnailPathOverrides: Map<string, string>;
  thumbnailVisibilityRevision: number;
  enqueueThumbnail: (file: FileEntry) => void;
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
    isPreviewOpen, workspaceMinSize, workspace, workspaceLoading, searchQuery,
    sortKey, sortAscending, viewMode, metadataLoading, changeWorkspaceSortKey,
    toggleWorkspaceSortDirection, changeWorkspaceViewMode, togglePreviewPanel, chooseWorkspaceFolder,
    canNavigateBack, canNavigateForward, canNavigateUp, navigateBack, navigateForward, navigateUp, navigateTo,
    visibleFiles, openFolder, clearWorkspaceSelection, showWorkspaceContextMenu, setGridScrollRef,
    handleThumbnailViewportScroll, clearSelectionFromBackground, startWorkspaceRectangleSelection,
    updateWorkspaceRectangleSelection, finishWorkspaceRectangleSelection, gridRowVirtualizer,
    gridColumns, selectedFiles, renamingPath, startWorkspaceFileDrag, updateWorkspaceFileDrag,
    finishWorkspaceFileDrag, selectFile, showFileContextMenu, thumbnailPathOverrides,
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
          sortKey={sortKey}
          sortAscending={sortAscending}
          viewMode={viewMode}
          previewOpen={isPreviewOpen}
          metadataLoading={metadataLoading}
          onSortKeyChange={changeWorkspaceSortKey}
          onToggleSortDirection={toggleWorkspaceSortDirection}
          onViewModeChange={changeWorkspaceViewMode}
          onTogglePreview={togglePreviewPanel}
          canNavigateBack={canNavigateBack}
          canNavigateForward={canNavigateForward}
          canNavigateUp={canNavigateUp}
          onNavigateBack={navigateBack}
          onNavigateForward={navigateForward}
          onNavigateUp={navigateUp}
          onNavigateTo={navigateTo}
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
        ) : visibleFiles.length === 0 ? (
          <div
            className="empty-workspace compact-empty"
            onClick={clearWorkspaceSelection}
            onContextMenu={(event) => showWorkspaceContextMenu(event)}
          >
            <div className="empty-symbol" aria-hidden="true">
              <File size={28} />
            </div>
            <h1>
              {!workspace.isAvailable
                ? "此位置暂不可用，正在等待设备或网络位置恢复"
                : workspace.mediaSuppressed
                ? "此目录中的媒体已被 .nomedia 隐藏"
                : searchQuery
                  ? "没有匹配的文件"
                  : "此目录没有文件"}
            </h1>
          </div>
        ) : viewMode === "grid" ? (
          <div
            ref={setGridScrollRef}
            className="file-grid"
            role="list"
            aria-label="文件"
            onScroll={handleThumbnailViewportScroll}
            onClick={clearSelectionFromBackground}
            onContextMenu={(event) => showWorkspaceContextMenu(event)}
            onPointerDown={(event) => startWorkspaceRectangleSelection(event, "grid")}
            onPointerMove={updateWorkspaceRectangleSelection}
            onPointerUp={finishWorkspaceRectangleSelection}
            onPointerCancel={finishWorkspaceRectangleSelection}
          >
            <div className="file-grid-virtualizer" style={{ height: gridRowVirtualizer.getTotalSize() }}>
              {gridRowVirtualizer.getVirtualItems().map((virtualRow) => (
                <div
                  className="file-grid-row"
                  key={virtualRow.key}
                  style={{
                    "--grid-columns": String(gridColumns),
                    transform: `translateY(${virtualRow.start}px)`,
                  } as CSSProperties}
                >
                  {visibleFiles
                    .slice(virtualRow.index * gridColumns, (virtualRow.index + 1) * gridColumns)
                    .map((file) => (
                      <div
                        className={`file-card ${selectedFiles.has(file.path) ? "selected" : ""}`}
                        key={file.path}
                        data-file-path={file.path}
                        draggable={false}
                        role="listitem"
                        tabIndex={0}
                        title={renamingPath === file.path ? undefined : file.name}
                        onPointerDown={(event) => startWorkspaceFileDrag(event, file.path)}
                        onPointerMove={updateWorkspaceFileDrag}
                        onPointerUp={finishWorkspaceFileDrag}
                        onPointerCancel={finishWorkspaceFileDrag}
                        onDragStart={(event) => {
                          event.preventDefault();
                          writeClientLog("debug", `已阻止浏览器原生缩略图拖拽：${file.path}`);
                        }}
                        onClick={(event) => selectFile(event, file.path)}
                        onDoubleClick={() => { if (isFolderEntry(file)) openFolder(file.path); }}
                        onContextMenu={(event) => showFileContextMenu(event, file.path)}
                      >
                        {isFolderEntry(file) ? (
                          <FolderThumbnail
                            folder={file}
                            thumbnailPathOverrides={thumbnailPathOverrides}
                            visibilityRevision={thumbnailVisibilityRevision}
                            onEnsureThumbnail={enqueueThumbnail}
                          />
                        ) : (
                          <FileThumbnail
                            file={file}
                            thumbnailPath={thumbnailPathOverrides.get(file.path) ?? file.thumbnailPath}
                            visibilityRevision={thumbnailVisibilityRevision}
                            onVisible={enqueueThumbnail}
                          />
                        )}
                        {renamingPath === file.path ? (
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
                            <span className="rename-extension">{isFileEntry(file) ? file.extension : ""}</span>
                          </span>
                        ) : (
                          <span className="file-name">{file.name}</span>
                        )}
                        <span className="file-meta">
                          {isFolderEntry(file) ? `文件夹 · ${formatDate(file.modifiedAt)}` : `${formatBytes(file.size)} · ${formatDate(file.createdAt)}`}
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
            className="file-list"
            role="table"
            aria-label="文件"
            style={listGridStyle}
            onScroll={handleThumbnailViewportScroll}
            onClick={clearSelectionFromBackground}
            onContextMenu={(event) => showWorkspaceContextMenu(event)}
            onPointerDown={(event) => startWorkspaceRectangleSelection(event, "list")}
            onPointerMove={updateWorkspaceRectangleSelection}
            onPointerUp={finishWorkspaceRectangleSelection}
            onPointerCancel={finishWorkspaceRectangleSelection}
          >
            <div className="file-list-header" role="row">
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
            <div className="file-list-virtualizer" style={{ height: listRowVirtualizer.getTotalSize() }}>
              {listRowVirtualizer.getVirtualItems().map((virtualRow) => {
                const file = visibleFiles[virtualRow.index];
                return (
                  <div
                    className={`file-list-row ${selectedFiles.has(file.path) ? "selected" : ""}`}
                    role="row"
                    key={file.path}
                    data-file-path={file.path}
                    draggable={false}
                    tabIndex={0}
                    style={{ ...listGridStyle, transform: `translateY(${virtualRow.start}px)` }}
                    onPointerDown={(event) => startWorkspaceFileDrag(event, file.path)}
                    onPointerMove={updateWorkspaceFileDrag}
                    onPointerUp={finishWorkspaceFileDrag}
                    onPointerCancel={finishWorkspaceFileDrag}
                    onDragStart={(event) => {
                      event.preventDefault();
                      writeClientLog("debug", `已阻止浏览器原生缩略图拖拽：${file.path}`);
                    }}
                    onClick={(event) => selectFile(event, file.path)}
                    onDoubleClick={() => { if (isFolderEntry(file)) openFolder(file.path); }}
                    onContextMenu={(event) => showFileContextMenu(event, file.path)}
                  >
                    {visibleListColumns.map((column) => {
                      if (column.id === "name") {
                        return (
                          <span className="list-name" key={column.id}>
                            {isFolderEntry(file) ? <Folder size={17} /> : (
                              <FileThumbnail
                                file={file}
                                thumbnailPath={thumbnailPathOverrides.get(file.path) ?? file.thumbnailPath}
                                visibilityRevision={thumbnailVisibilityRevision}
                                compact
                                onVisible={enqueueThumbnail}
                              />
                            )}
                            {renamingPath === file.path ? (
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
                                <span className="rename-extension">{isFileEntry(file) ? file.extension : ""}</span>
                              </span>
                            ) : (
                              <span title={file.name}>{file.name}</span>
                            )}
                          </span>
                        );
                      }
                      if (column.id === "size") {
                        return <span key={column.id}>{isFileEntry(file) ? formatBytes(file.size) : "—"}</span>;
                      }
                      if (column.id === "type") {
                        return <span key={column.id}>{isFolderEntry(file) ? "文件夹" : file.kind === "video" ? "视频" : file.kind === "image" ? "图片" : file.kind === "text" ? "文本" : "其他"}</span>;
                      }
                      if (column.id === "modifiedAt") {
                        return <span key={column.id}>{formatDate(file.modifiedAt)}</span>;
                      }
                      if (column.id === "duration") {
                        return <span key={column.id}>{isFileEntry(file) ? formatDuration(file.duration) : "—"}</span>;
                      }
                      if (column.id === "resolution") {
                        return <span key={column.id}>{isFileEntry(file) ? formatResolution(file) : "—"}</span>;
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
        {workspace && visibleFiles.length > 0 && (
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
            <span>松开以复制文件到当前工作区</span>
          </div>
        )}
      </section>
      </Panel>
  );
}
