use super::*;

pub(super) const CONFIG_VERSION: u32 = 5;
pub(super) const DEFAULT_EXTENSIONS: [&str; 14] = [
    ".mp4", ".mkv", ".webm", ".avi", ".mov", ".wmv", ".flv", ".m4v", ".mpeg", ".mpg", ".3gp",
    ".rm", ".rmvb", ".ts",
];

pub(super) static CONFIG_STORE: OnceLock<config_store::ConfigStore> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FavoriteFolder {
    pub(super) path: String,
    pub(super) name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ListColumn {
    pub(super) id: String,
    pub(super) visible: bool,
    pub(super) width: u16,
}

pub(super) fn default_list_columns() -> Vec<ListColumn> {
    vec![
        ListColumn {
            id: "name".to_string(),
            visible: true,
            width: 280,
        },
        ListColumn {
            id: "size".to_string(),
            visible: true,
            width: 112,
        },
        ListColumn {
            id: "duration".to_string(),
            visible: true,
            width: 94,
        },
        ListColumn {
            id: "resolution".to_string(),
            visible: true,
            width: 112,
        },
        ListColumn {
            id: "modifiedAt".to_string(),
            visible: true,
            width: 170,
        },
    ]
}

pub(super) fn default_thumbnail_capture_position() -> String {
    "middle".to_string()
}

pub(super) fn default_code_theme() -> String {
    "tomorrow".to_string()
}

pub(super) fn default_text_preview_latin_font() -> String {
    "Consolas".to_string()
}

pub(super) fn default_text_preview_cjk_font() -> String {
    "Microsoft YaHei".to_string()
}

pub(super) fn default_remember_workspace_focus() -> bool {
    true
}

pub(super) fn default_background_opacity() -> u8 {
    50
}

pub(super) fn available_parallelism() -> usize {
    match std::thread::available_parallelism() {
        Ok(parallelism) => parallelism.get(),
        Err(error) => {
            log::warn!("Unable to read logical CPU count; falling back to one worker: {error}");
            1
        }
    }
}

pub(super) fn recommended_background_sidecar_concurrency() -> usize {
    background_sidecar_concurrency_for(available_parallelism())
}

pub(super) fn background_sidecar_concurrency_for(parallelism: usize) -> usize {
    parallelism.saturating_mul(2).saturating_div(3).max(1)
}

pub(super) fn default_video_extensions() -> Vec<String> {
    DEFAULT_EXTENSIONS
        .iter()
        .map(|item| item.to_string())
        .collect()
}

pub(super) fn default_image_extensions() -> Vec<String> {
    [
        ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".tif", ".tiff",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

pub(super) fn default_audio_extensions() -> Vec<String> {
    [
        ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wav", ".wma", ".aiff", ".aif", ".ape",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

pub(super) fn default_text_extensions() -> Vec<String> {
    [
        ".txt", ".md", ".json", ".js", ".jsx", ".ts", ".tsx", ".html", ".htm", ".css", ".yaml",
        ".yml", ".sh", ".ps1", ".sql", ".py", ".rs", ".java", ".c", ".cc", ".cpp", ".h", ".hpp",
        ".go",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

pub(super) fn default_text_language_map() -> HashMap<String, String> {
    [
        (".html", "markup"),
        (".htm", "markup"),
        (".css", "css"),
        (".js", "javascript"),
        (".jsx", "javascript"),
        (".ts", "typescript"),
        (".tsx", "tsx"),
        (".json", "json"),
        (".md", "markdown"),
        (".yaml", "yaml"),
        (".yml", "yaml"),
        (".sh", "bash"),
        (".ps1", "powershell"),
        (".sql", "sql"),
        (".py", "python"),
        (".rs", "rust"),
        (".java", "java"),
        (".c", "cpp"),
        (".cc", "cpp"),
        (".cpp", "cpp"),
        (".h", "cpp"),
        (".hpp", "cpp"),
        (".go", "go"),
    ]
    .into_iter()
    .map(|(extension, language)| (extension.to_string(), language.to_string()))
    .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Preferences {
    pub(super) appearance: String,
    pub(super) accent_theme: String,
    #[serde(default = "default_code_theme")]
    pub(super) code_theme: String,
    pub(super) thumbnail_cache_gb: f64,
    #[serde(default = "default_thumbnail_capture_position")]
    pub(super) thumbnail_capture_position: String,
    pub(super) autoplay: bool,
    pub(super) volume: u8,
    #[serde(default)]
    pub(super) muted: bool,
    #[serde(default = "default_remember_workspace_focus")]
    pub(super) remember_workspace_focus: bool,
    pub(super) show_hidden_items: bool,
    pub(super) show_nomedia_media: bool,
    pub(super) video_extensions: Vec<String>,
    #[serde(default = "default_audio_extensions")]
    pub(super) audio_extensions: Vec<String>,
    #[serde(default = "default_image_extensions")]
    pub(super) image_extensions: Vec<String>,
    #[serde(default = "default_text_extensions")]
    pub(super) text_extensions: Vec<String>,
    #[serde(default = "default_text_language_map")]
    pub(super) text_language_map: HashMap<String, String>,
    #[serde(default = "default_text_preview_latin_font")]
    pub(super) text_preview_latin_font: String,
    #[serde(default = "default_text_preview_cjk_font")]
    pub(super) text_preview_cjk_font: String,
    #[serde(default = "default_image_max_megabytes")]
    pub(super) image_max_megabytes: u16,
    #[serde(default = "default_image_max_megapixels")]
    pub(super) image_max_megapixels: u16,
    #[serde(default = "default_video_extensions")]
    pub(super) managed_video_extensions: Vec<String>,
    #[serde(default = "recommended_background_sidecar_concurrency")]
    pub(super) background_sidecar_concurrency: usize,
    #[serde(default = "default_list_columns")]
    pub(super) list_columns: Vec<ListColumn>,
    #[serde(default)]
    pub(super) background_image: Option<String>,
    #[serde(default = "default_background_opacity")]
    pub(super) background_opacity: u8,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            appearance: "dark".to_string(),
            accent_theme: "teal".to_string(),
            code_theme: default_code_theme(),
            thumbnail_cache_gb: 0.5,
            thumbnail_capture_position: default_thumbnail_capture_position(),
            autoplay: true,
            volume: 100,
            muted: false,
            remember_workspace_focus: default_remember_workspace_focus(),
            show_hidden_items: false,
            show_nomedia_media: false,
            video_extensions: default_video_extensions(),
            audio_extensions: default_audio_extensions(),
            image_extensions: default_image_extensions(),
            text_extensions: default_text_extensions(),
            text_language_map: default_text_language_map(),
            text_preview_latin_font: default_text_preview_latin_font(),
            text_preview_cjk_font: default_text_preview_cjk_font(),
            image_max_megabytes: default_image_max_megabytes(),
            image_max_megapixels: default_image_max_megapixels(),
            managed_video_extensions: default_video_extensions(),
            background_sidecar_concurrency: recommended_background_sidecar_concurrency(),
            list_columns: default_list_columns(),
            background_image: None,
            background_opacity: default_background_opacity(),
        }
    }
}

pub(super) fn default_image_max_megabytes() -> u16 {
    50
}
pub(super) fn default_image_max_megapixels() -> u16 {
    100
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkspaceFocus {
    #[serde(alias = "videoPath")]
    pub(super) file_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkspaceSort {
    pub(super) key: String,
    pub(super) ascending: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AppConfig {
    pub(super) version: u32,
    pub(super) favorites: Vec<FavoriteFolder>,
    pub(super) last_workspace: Option<String>,
    #[serde(default)]
    pub(super) workspace_focus: HashMap<String, WorkspaceFocus>,
    #[serde(default)]
    pub(super) workspace_sort: HashMap<String, WorkspaceSort>,
    pub(super) settings: Preferences,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            favorites: Vec::new(),
            last_workspace: None,
            workspace_focus: HashMap::new(),
            workspace_sort: HashMap::new(),
            settings: Preferences::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DirectoryEntry {
    pub(super) path: String,
    pub(super) name: String,
    pub(super) has_children: bool,
    pub(super) can_recycle: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileEntry {
    pub(super) entry_type: &'static str,
    pub(super) path: String,
    pub(super) name: String,
    pub(super) extension: String,
    pub(super) size: u64,
    pub(super) created_at: Option<u128>,
    pub(super) modified_at: Option<u128>,
    pub(super) duration: Option<f64>,
    pub(super) width: Option<u32>,
    pub(super) height: Option<u32>,
    pub(super) thumbnail_path: Option<String>,
    pub(super) kind: FileKind,
    pub(super) preview_capability: PreviewCapability,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FolderEntry {
    pub(super) entry_type: &'static str,
    pub(super) path: String,
    pub(super) name: String,
    pub(super) created_at: Option<u128>,
    pub(super) modified_at: Option<u128>,
    pub(super) can_recycle: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub(super) enum DirectoryItem {
    Folder(FolderEntry),
    File(FileEntry),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FolderThumbnailSources {
    pub(super) folder_path: String,
    pub(super) files: Vec<FileEntry>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum FileKind {
    Video,
    Audio,
    Image,
    Text,
    Pdf,
    Other,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum PreviewCapability {
    Inline,
    MetadataOnly,
    Unavailable,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DirectoryChildren {
    pub(super) path: String,
    pub(super) folders: Vec<DirectoryEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DirectoryListing {
    pub(super) path: String,
    pub(super) items: Vec<DirectoryItem>,
    pub(super) media_suppressed: bool,
    pub(super) is_available: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ApplicationState {
    pub(super) config: AppConfig,
    pub(super) roots: Vec<DirectoryEntry>,
    pub(super) settings_limits: SettingsLimits,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SettingsLimits {
    pub(super) background_sidecar_concurrency_min: usize,
    pub(super) background_sidecar_concurrency_max: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DataManagementSummary {
    pub(super) data_path: String,
    pub(super) thumbnail_bytes: u64,
    pub(super) log_bytes: u64,
    pub(super) background_bytes: u64,
    pub(super) total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AboutInfo {
    pub(super) app_version: String,
    pub(super) data_path: String,
    pub(super) licenses_path: Option<String>,
    pub(super) sidecars: HashMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BackgroundImportResult {
    pub(super) file_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WindowState {
    pub(super) version: u32,
    pub(super) x: i32,
    pub(super) y: i32,
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) maximized: bool,
    #[serde(default = "default_left_panel_size")]
    pub(super) left_panel_size: u8,
    #[serde(default = "default_preview_open")]
    pub(super) preview_open: bool,
}

pub(super) fn default_left_panel_size() -> u8 {
    20
}
pub(super) fn default_preview_open() -> bool {
    true
}

impl Default for WindowState {
    fn default() -> Self {
        Self {
            version: 1,
            x: 80,
            y: 80,
            width: 1440,
            height: 900,
            maximized: false,
            left_panel_size: default_left_panel_size(),
            preview_open: default_preview_open(),
        }
    }
}

pub(super) const MEDIA_CACHE_VERSION: u32 = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CachedThumbnail {
    #[serde(default = "default_thumbnail_capture_position")]
    pub(super) capture_position: String,
    #[serde(default = "default_thumbnail_preview_type")]
    pub(super) preview_type: String,
    #[serde(default = "default_thumbnail_processor_version")]
    pub(super) processor_version: String,
    pub(super) thumbnail_file: String,
    #[serde(default)]
    pub(super) last_accessed_at: u128,
}

pub(super) fn default_thumbnail_preview_type() -> String {
    "video".to_string()
}
pub(super) fn default_thumbnail_processor_version() -> String {
    "v1".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CachedMediaMetadata {
    pub(super) duration: Option<f64>,
    pub(super) width: Option<u32>,
    pub(super) height: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MediaCacheEntry {
    pub(super) size: u64,
    pub(super) modified_at: u128,
    #[serde(default)]
    pub(super) thumbnail: Option<CachedThumbnail>,
    #[serde(default)]
    pub(super) metadata: Option<CachedMediaMetadata>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct MediaCacheIndex {
    pub(super) version: u32,
    pub(super) entries: HashMap<String, MediaCacheEntry>,
}

impl Default for MediaCacheIndex {
    fn default() -> Self {
        Self {
            version: MEDIA_CACHE_VERSION,
            entries: HashMap::new(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LegacyThumbnailIndexEntry {
    pub(super) size: u64,
    pub(super) modified_at: u128,
    #[serde(default = "default_thumbnail_capture_position")]
    pub(super) capture_position: String,
    pub(super) thumbnail_file: String,
    #[serde(default)]
    pub(super) last_accessed_at: u128,
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct LegacyThumbnailIndex {
    pub(super) entries: HashMap<String, LegacyThumbnailIndexEntry>,
}

pub(super) struct MediaCacheIndexState(pub(super) Arc<Mutex<MediaCacheIndex>>);

pub(super) struct ThumbnailCacheDirectory(pub(super) PathBuf);

#[derive(Clone)]
pub(super) struct ThumbnailCacheMaintenanceState {
    pub(super) index: Arc<Mutex<MediaCacheIndex>>,
    pub(super) directory: PathBuf,
    pub(super) lock: Arc<Mutex<()>>,
}

#[derive(Debug, Deserialize)]
pub(super) struct VideoStreamQuery {
    pub(super) path: String,
    #[serde(default)]
    pub(super) mode: VideoStreamMode,
    pub(super) start: Option<f64>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum VideoStreamMode {
    #[default]
    Direct,
    Transcode,
    Audio,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VideoStreamUrl {
    pub(super) url: String,
    pub(super) is_transcoded: bool,
    pub(super) duration: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RecycleResult {
    pub(super) recycled_paths: Vec<String>,
    pub(super) failed_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DirectoryRecycleResult {
    pub(super) recycled_path: String,
    pub(super) config: AppConfig,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RenameResult {
    pub(super) old_path: String,
    pub(super) new_path: String,
    pub(super) name: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum FileTaskOperation {
    Copy,
    Move,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum FileTaskState {
    Queued,
    Running,
    Completed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum FileTaskItemStatus {
    Completed,
    Skipped,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileTaskItemResult {
    pub(super) source_path: String,
    pub(super) destination_path: Option<String>,
    pub(super) status: FileTaskItemStatus,
    pub(super) error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileTaskSnapshot {
    pub(super) id: u64,
    pub(super) operation: FileTaskOperation,
    pub(super) state: FileTaskState,
    pub(super) destination_path: String,
    pub(super) total_items: usize,
    pub(super) completed_items: usize,
    pub(super) results: Vec<FileTaskItemResult>,
}

#[derive(Clone)]
pub(super) struct FileTaskControl {
    pub(super) snapshot: Arc<Mutex<FileTaskSnapshot>>,
    pub(super) cancel: Arc<AtomicBool>,
}

pub(super) struct ClipboardFiles {
    pub(super) paths: Vec<String>,
    pub(super) operation: FileTaskOperation,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThumbnailResult {
    pub(super) path: String,
    pub(super) thumbnail_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThumbnailFailure {
    pub(super) path: String,
    pub(super) error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThumbnailBatchResult {
    pub(super) thumbnails: Vec<ThumbnailResult>,
    pub(super) failures: Vec<ThumbnailFailure>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThumbnailData {
    pub(super) path: String,
    pub(super) thumbnail_path: String,
    pub(super) data_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TextPreviewData {
    pub(super) content: String,
    pub(super) encoding: String,
    pub(super) total_bytes: u64,
    pub(super) readable: bool,
    pub(super) reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ImagePreviewInfo {
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) allowed: bool,
    pub(super) reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LogSnapshot {
    pub(super) path: String,
    pub(super) hash: String,
    pub(super) changed: bool,
    pub(super) content: Option<String>,
    pub(super) size: u64,
}

pub(super) fn log_snapshot_from_bytes(
    path: &Path,
    bytes: &[u8],
    previous_hash: Option<&str>,
    limit: usize,
) -> LogSnapshot {
    let hash = format!("{:016x}", fnv1a_hash(bytes));
    let changed = previous_hash != Some(hash.as_str());
    let start = bytes.len().saturating_sub(limit);
    LogSnapshot {
        path: path_string(path),
        hash,
        changed,
        content: changed.then(|| String::from_utf8_lossy(&bytes[start..]).to_string()),
        size: bytes.len() as u64,
    }
}

pub(super) enum FileOperationTask {
    Recycle {
        paths: Vec<PathBuf>,
        response: mpsc::Sender<RecycleResult>,
    },
    Rename {
        path: PathBuf,
        new_stem: String,
        response: mpsc::Sender<Result<RenameResult, String>>,
    },
    Transfer {
        control: FileTaskControl,
        paths: Vec<String>,
        destination: PathBuf,
        operation: FileTaskOperation,
        app_handle: tauri::AppHandle,
    },
}

pub(super) enum ClipboardOperationTask {
    WriteClipboard {
        paths: Vec<PathBuf>,
        operation: FileTaskOperation,
        owner: Option<isize>,
        response: mpsc::Sender<Result<(), String>>,
    },
    ReadClipboard {
        response: mpsc::Sender<Result<ClipboardFiles, String>>,
    },
    Flush {
        response: mpsc::Sender<Result<(), String>>,
    },
}

pub(super) struct FileOperationQueue {
    pub(super) sender: mpsc::Sender<FileOperationTask>,
    pub(super) clipboard_sender: mpsc::Sender<ClipboardOperationTask>,
    #[cfg(target_os = "windows")]
    pub(super) clipboard_thread_id: u32,
    pub(super) tasks: Arc<Mutex<HashMap<u64, FileTaskControl>>>,
    pub(super) next_task_id: AtomicU64,
}
