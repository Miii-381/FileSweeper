import type { ThemeId } from "./theme";

export type ViewMode = "grid" | "list";
export type ColorMode = "dark" | "light";
export type CodeTheme = "default" | "dark" | "funky" | "okaidia" | "tomorrow" | "twilight" | "coy" | "solarizedlight";
export type SortKey = "createdAt" | "modifiedAt" | "name" | "type" | "size" | "duration" | "resolution";
export type ListColumnId = "name" | "type" | "size" | "duration" | "resolution" | "modifiedAt";
export type ThumbnailCapturePosition = "opening" | "early" | "middle" | "late" | "ending";

export const GRID_CARD_WIDTH = 240;
// 180px card height plus the 16px vertical track gap kept between virtual rows.
export const GRID_ROW_HEIGHT = 196;
export const LIST_ROW_HEIGHT = 40;

export type DirectoryEntry = {
  path: string;
  name: string;
  hasChildren: boolean;
  canRecycle: boolean;
};

export type FileKind = "video" | "audio" | "image" | "text" | "pdf" | "other";
type PreviewCapability = "inline" | "metadataOnly" | "unavailable";

export type FileEntry = {
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
  kind: FileKind;
  previewCapability: PreviewCapability;
};

export type FolderEntry = {
  entryType: "folder";
  path: string;
  name: string;
  createdAt: number | null;
  modifiedAt: number | null;
  canRecycle: boolean;
};

export type DirectoryItem = FolderEntry | (FileEntry & { entryType: "file" });

export function isFileEntry(item: DirectoryItem): item is FileEntry & { entryType: "file" } {
  return item.entryType === "file";
}

export function isFolderEntry(item: DirectoryItem): item is FolderEntry {
  return item.entryType === "folder";
}

export type FolderThumbnailSources = {
  folderPath: string;
  files: FileEntry[];
};

export type WorkspaceSelectionBox = {
  viewMode: ViewMode;
  left: number;
  top: number;
  width: number;
  height: number;
};

export type WorkspaceSelectionItemBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type WorkspaceSelectionGesture = {
  viewMode: ViewMode;
  pointerId: number;
  root: HTMLDivElement;
  startClientX: number;
  startClientY: number;
  startContentX: number;
  startContentY: number;
  lastClientX: number;
  lastClientY: number;
  initialSelection: Set<string>;
  intersectedPaths: Set<string>;
  itemBounds: Map<string, WorkspaceSelectionItemBounds>;
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
  items: DirectoryItem[];
  mediaSuppressed: boolean;
  isAvailable: boolean;
};

export type RecycleResult = {
  recycledPaths: string[];
  failedPaths: string[];
};

export type DirectoryRecycleResult = {
  recycledPath: string;
  config: AppConfig;
};

export type RenameResult = {
  oldPath: string;
  newPath: string;
  name: string;
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
  totalBytes: number | null;
  transferredBytes: number;
  results: FileTaskItemResult[];
};

export type WorkspaceContextMenu = {
  x: number;
  y: number;
  kind: "workspace" | "files" | "directory";
  workspacePath: string | null;
  paths: string[];
  primaryPath: string | null;
  canRecycleDirectory?: boolean;
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

export type LogSnapshot = {
  path: string;
  hash: string;
  changed: boolean;
  content: string | null;
  size: number;
};

export type Preferences = {
  appearance: "system" | ColorMode;
  accentTheme: ThemeId;
  codeTheme: CodeTheme;
  thumbnailCacheGb: number;
  thumbnailCapturePosition: ThumbnailCapturePosition;
  autoplay: boolean;
  volume: number;
  muted: boolean;
  rememberWorkspaceFocus: boolean;
  showHiddenItems: boolean;
  showNomediaMedia: boolean;
  videoExtensions: string[];
  audioExtensions: string[];
  imageExtensions: string[];
  textExtensions: string[];
  textLanguageMap: Record<string, string>;
  textPreviewLatinFont: string;
  textPreviewCjkFont: string;
  imageMaxMegabytes: number;
  imageMaxMegapixels: number;
  managedVideoExtensions: string[];
  managedAudioExtensions: string[];
  managedImageExtensions: string[];
  managedTextExtensions: string[];
  backgroundSidecarConcurrency: number;
  listColumns: ListColumn[];
  backgroundImage: string | null;
  backgroundOpacity: number;
  backgroundBlur: number;
};

export type DataManagementSummary = {
  dataPath: string;
  thumbnailBytes: number;
  logBytes: number;
  backgroundBytes: number;
  totalBytes: number;
};

export type AboutInfo = {
  appVersion: string;
  dataPath: string;
  licensesPath: string | null;
  sidecars: Record<string, string>;
};

export type WindowState = {
  version: number;
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
  leftPanelSize: number;
  previewOpen: boolean;
};

export type FavoriteFolder = {
  path: string;
  name: string;
};

export type WorkspaceFocus = {
  filePath: string;
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
  settingsLimits: SettingsLimits;
};

export type SettingsLimits = {
  backgroundSidecarConcurrencyMin: number;
  backgroundSidecarConcurrencyMax: number;
};

type TreeStatus = "idle" | "loading" | "loaded" | "error";
export type TreeState = Record<string, { status: TreeStatus; folders: DirectoryEntry[] }>;

export const listColumnLabels: Record<ListColumnId, string> = {
  name: "名称",
  type: "类型",
  size: "大小",
  duration: "时长",
  resolution: "分辨率",
  modifiedAt: "最后修改时间",
};
