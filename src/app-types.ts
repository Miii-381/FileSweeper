import type { ThemeId } from "./theme";
import type { LogLevel } from "@tauri-apps/plugin-log";

export type ViewMode = "grid" | "list";
export type ColorMode = "dark" | "light";
export type SortKey = "createdAt" | "name" | "size" | "duration" | "resolution";
export type ListColumnId = "name" | "size" | "duration" | "resolution" | "modifiedAt";
export type ThumbnailCapturePosition = "opening" | "early" | "middle" | "late" | "ending";

export const MAX_THUMBNAIL_CONCURRENCY = 10;
export const GRID_CARD_WIDTH = 220;
// 180px card height plus the 16px vertical track gap kept between virtual rows.
export const GRID_ROW_HEIGHT = 196;
export const LIST_ROW_HEIGHT = 40;

export type DirectoryEntry = {
  path: string;
  name: string;
  hasChildren: boolean;
};

export type VideoEntry = {
  path: string;
  name: string;
  extension: string;
  size: number;
  createdAt: number | null;
  modifiedAt: number | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  thumbnailPath: string | null;
};

export type WorkspaceSelectionBox = {
  viewMode: ViewMode;
  left: number;
  top: number;
  width: number;
  height: number;
};

export type WorkspaceSelectionGesture = {
  viewMode: ViewMode;
  pointerId: number;
  root: HTMLDivElement;
  startClientX: number;
  startClientY: number;
  lastClientX: number;
  lastClientY: number;
  initialSelection: Set<string>;
  intersectedPaths: Set<string>;
  additive: boolean;
  moved: boolean;
  hasAutoScrolled: boolean;
};

export type FileDragGesture = {
  pointerId: number;
  root: HTMLDivElement;
  startClientX: number;
  startClientY: number;
  paths: string[];
  started: boolean;
};

export type DirectoryChildren = {
  path: string;
  folders: DirectoryEntry[];
};

export type WorkspaceListing = {
  path: string;
  videos: VideoEntry[];
  mediaSuppressed: boolean;
  isAvailable: boolean;
};

export type RecycleResult = {
  recycledPaths: string[];
  failedPaths: string[];
};

export type RenameResult = {
  oldPath: string;
  newPath: string;
  name: string;
};

export type CopyResult = {
  copiedPaths: string[];
  skippedPaths: string[];
  failedPaths: string[];
};

export type FileTaskOperation = "copy" | "move";
export type FileTaskState = "queued" | "running" | "completed" | "cancelled";
export type FileTaskItemStatus = "completed" | "skipped" | "failed" | "cancelled";

export type FileTaskItemResult = {
  sourcePath: string;
  destinationPath: string | null;
  status: FileTaskItemStatus;
  error: string | null;
};

export type FileTaskSnapshot = {
  id: number;
  operation: FileTaskOperation;
  state: FileTaskState;
  destinationPath: string;
  totalItems: number;
  completedItems: number;
  results: FileTaskItemResult[];
};

export type WorkspaceContextMenu = {
  x: number;
  y: number;
  workspacePath: string;
  paths: string[];
  primaryPath: string | null;
};

export type VideoStreamUrl = {
  url: string;
  isTranscoded: boolean;
  duration: number | null;
};

export type VideoMetadata = {
  path: string;
  duration: number | null;
  width: number | null;
  height: number | null;
};

export type MetadataBatchResult = {
  metadata: VideoMetadata[];
  failedPaths: string[];
};

export type ThumbnailResult = {
  path: string;
  thumbnailPath: string;
};

export type ThumbnailFailure = {
  path: string;
  error: string;
};

export type ThumbnailBatchResult = {
  thumbnails: ThumbnailResult[];
  failures: ThumbnailFailure[];
};

export type ThumbnailData = {
  path: string;
  thumbnailPath: string;
  dataUrl: string;
};

export type ThumbnailTask = {
  video: VideoEntry;
};

export type LogSnapshot = {
  path: string;
  content: string;
  size: number;
};

export type LiveLogEntry = {
  id: number;
  level: LogLevel;
  message: string;
};

export type Preferences = {
  appearance: "system" | ColorMode;
  accentTheme: ThemeId;
  thumbnailCacheGb: number;
  thumbnailCapturePosition: ThumbnailCapturePosition;
  autoplay: boolean;
  volume: number;
  muted: boolean;
  rememberWorkspaceFocus: boolean;
  showHiddenItems: boolean;
  showNomediaMedia: boolean;
  videoExtensions: string[];
  managedVideoExtensions: string[];
  openUnsupportedExternally: boolean;
  listColumns: ListColumn[];
};

export type FavoriteFolder = {
  path: string;
  name: string;
};

export type WorkspaceFocus = {
  videoPath: string;
};

export type WorkspaceSort = {
  key: SortKey;
  ascending: boolean;
};

export type ListColumn = {
  id: ListColumnId;
  visible: boolean;
  width: number;
};

export type AppConfig = {
  version: number;
  favorites: FavoriteFolder[];
  lastWorkspace: string | null;
  workspaceFocus: Record<string, WorkspaceFocus>;
  workspaceSort: Record<string, WorkspaceSort>;
  settings: Preferences;
};

export type ApplicationState = {
  config: AppConfig;
  roots: DirectoryEntry[];
};

export type TreeStatus = "idle" | "loading" | "loaded" | "error";
export type TreeState = Record<string, { status: TreeStatus; folders: DirectoryEntry[] }>;

export const fallbackConfig: AppConfig = {
  version: 2,
  favorites: [],
  lastWorkspace: null,
  workspaceFocus: {},
  workspaceSort: {},
  settings: {
    appearance: "dark",
    accentTheme: "teal",
    thumbnailCacheGb: 2,
    thumbnailCapturePosition: "middle",
    autoplay: true,
    volume: 100,
    muted: false,
    rememberWorkspaceFocus: true,
    showHiddenItems: false,
    showNomediaMedia: false,
    videoExtensions: [
      ".mp4",
      ".mkv",
      ".webm",
      ".avi",
      ".mov",
      ".wmv",
      ".flv",
      ".m4v",
      ".mpeg",
      ".mpg",
      ".3gp",
      ".rm",
      ".rmvb",
      ".ts",
    ],
    managedVideoExtensions: [
      ".mp4",
      ".mkv",
      ".webm",
      ".avi",
      ".mov",
      ".wmv",
      ".flv",
      ".m4v",
      ".mpeg",
      ".mpg",
      ".3gp",
      ".rm",
      ".rmvb",
      ".ts",
    ],
    openUnsupportedExternally: true,
    listColumns: [
      { id: "name", visible: true, width: 280 },
      { id: "size", visible: true, width: 112 },
      { id: "duration", visible: true, width: 94 },
      { id: "resolution", visible: true, width: 112 },
      { id: "modifiedAt", visible: true, width: 170 },
    ],
  },
};

export const listColumnLabels: Record<ListColumnId, string> = {
  name: "名称",
  size: "大小",
  duration: "时长",
  resolution: "分辨率",
  modifiedAt: "最后修改时间",
};
