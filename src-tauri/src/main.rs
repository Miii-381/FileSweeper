#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config_store;
mod domain;
mod file_operations;
mod media_processing;
mod media_stream;
mod menus;
mod sidecar;
mod windows_shell;
mod workspace;

use media_processing::MetadataBatchResult;

use axum::{
    body::{Body, Bytes},
    extract::{Query, Request, State},
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
#[cfg(target_os = "windows")]
use std::os::windows::{ffi::OsStrExt, process::CommandExt};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Condvar, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{ContextMenu, Menu, MenuItem},
    Emitter, LogicalPosition, Manager,
};
use tauri_plugin_fs::FsExt;
use tauri_plugin_log::{Target, TargetKind};
use tower::ServiceExt;
use tower_http::services::ServeFile;
#[cfg(target_os = "windows")]
use windows::{
    core::{HRESULT, HSTRING, PCWSTR},
    Win32::{
        Foundation::{DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, S_OK},
        Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH},
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IBindCtx, IDataObject,
            CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
        },
        System::{
            Ole::{
                DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize, OleUninitialize,
                DROPEFFECT, DROPEFFECT_COPY,
            },
            SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS},
        },
        UI::Shell::{
            BHID_DataObject, Common::ITEMIDLIST, FileOperation, IFileOperation, IShellItem,
            IsUserAnAdmin, SHCreateItemFromParsingName, SHCreateShellItemArrayFromIDLists,
            SHParseDisplayName, FOFX_RECYCLEONDELETE, FOF_NOCONFIRMATION,
        },
    },
};

#[cfg(target_os = "windows")]
#[windows::core::implement(IDropSource)]
struct WindowsFileDragSource;

#[cfg(target_os = "windows")]
impl WindowsFileDragSource {
    fn new() -> Self {
        Self
    }
}

#[cfg(target_os = "windows")]
impl IDropSource_Impl for WindowsFileDragSource_Impl {
    fn QueryContinueDrag(
        &self,
        escape_pressed: windows::core::BOOL,
        key_state: MODIFIERKEYS_FLAGS,
    ) -> HRESULT {
        if escape_pressed.as_bool() {
            DRAGDROP_S_CANCEL
        } else if key_state.0 & MK_LBUTTON.0 == 0 {
            DRAGDROP_S_DROP
        } else {
            S_OK
        }
    }

    fn GiveFeedback(&self, _effect: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

const CONFIG_VERSION: u32 = 1;
const DEFAULT_EXTENSIONS: [&str; 14] = [
    ".mp4", ".mkv", ".webm", ".avi", ".mov", ".wmv", ".flv", ".m4v", ".mpeg", ".mpg", ".3gp",
    ".rm", ".rmvb", ".ts",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FavoriteFolder {
    path: String,
    name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListColumn {
    id: String,
    visible: bool,
    width: u16,
}

fn default_list_columns() -> Vec<ListColumn> {
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

fn default_thumbnail_capture_position() -> String {
    "middle".to_string()
}

fn default_remember_workspace_focus() -> bool {
    true
}

fn default_video_extensions() -> Vec<String> {
    DEFAULT_EXTENSIONS
        .iter()
        .map(|item| item.to_string())
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    appearance: String,
    accent_theme: String,
    thumbnail_cache_gb: f64,
    #[serde(default = "default_thumbnail_capture_position")]
    thumbnail_capture_position: String,
    autoplay: bool,
    volume: u8,
    #[serde(default)]
    muted: bool,
    #[serde(default = "default_remember_workspace_focus")]
    remember_workspace_focus: bool,
    show_hidden_items: bool,
    show_nomedia_media: bool,
    video_extensions: Vec<String>,
    #[serde(default = "default_video_extensions")]
    managed_video_extensions: Vec<String>,
    open_unsupported_externally: bool,
    #[serde(default = "default_list_columns")]
    list_columns: Vec<ListColumn>,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            appearance: "dark".to_string(),
            accent_theme: "teal".to_string(),
            thumbnail_cache_gb: 2.0,
            thumbnail_capture_position: default_thumbnail_capture_position(),
            autoplay: true,
            volume: 100,
            muted: false,
            remember_workspace_focus: default_remember_workspace_focus(),
            show_hidden_items: false,
            show_nomedia_media: false,
            video_extensions: default_video_extensions(),
            managed_video_extensions: default_video_extensions(),
            open_unsupported_externally: true,
            list_columns: default_list_columns(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFocus {
    video_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSort {
    key: String,
    ascending: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    version: u32,
    favorites: Vec<FavoriteFolder>,
    last_workspace: Option<String>,
    #[serde(default)]
    workspace_focus: HashMap<String, WorkspaceFocus>,
    #[serde(default)]
    workspace_sort: HashMap<String, WorkspaceSort>,
    settings: Preferences,
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
struct DirectoryEntry {
    path: String,
    name: String,
    has_children: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoEntry {
    path: String,
    name: String,
    extension: String,
    size: u64,
    created_at: Option<u128>,
    modified_at: Option<u128>,
    duration: Option<f64>,
    width: Option<u32>,
    height: Option<u32>,
    thumbnail_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryListing {
    path: String,
    folders: Vec<DirectoryEntry>,
    videos: Vec<VideoEntry>,
    media_suppressed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplicationState {
    config: AppConfig,
    roots: Vec<DirectoryEntry>,
}

#[derive(Debug)]
struct ContextMenuTarget {
    path: PathBuf,
    operation_paths: Vec<PathBuf>,
    is_directory: bool,
}

struct ContextMenuState(Mutex<Option<ContextMenuTarget>>);

const MAX_PARALLEL_THUMBNAIL_TASKS: usize = 10;
const MAX_PARALLEL_THUMBNAIL_READS: usize = 4;

struct MediaSidecarPool(Arc<MediaSidecarPermits>);

struct MediaSidecarPermits {
    available: Mutex<usize>,
    available_changed: Condvar,
}

struct MediaSidecarPermit(Arc<MediaSidecarPermits>);

impl MediaSidecarPermits {
    fn new(capacity: usize) -> Self {
        Self {
            available: Mutex::new(capacity),
            available_changed: Condvar::new(),
        }
    }

    fn acquire(self: &Arc<Self>) -> Result<MediaSidecarPermit, String> {
        let mut available = self
            .available
            .lock()
            .map_err(|_| "Unable to access the media sidecar queue.".to_string())?;
        while *available == 0 {
            available = self
                .available_changed
                .wait(available)
                .map_err(|_| "Unable to access the media sidecar queue.".to_string())?;
        }
        *available -= 1;
        Ok(MediaSidecarPermit(Arc::clone(self)))
    }
}

impl Drop for MediaSidecarPermit {
    fn drop(&mut self) {
        if let Ok(mut available) = self.0.available.lock() {
            *available += 1;
            self.0.available_changed.notify_one();
        }
    }
}

struct ThumbnailReadPool(Arc<ThumbnailReadPermits>);

struct ThumbnailReadPermits {
    available: Mutex<usize>,
    available_changed: Condvar,
}

struct ThumbnailReadPermit(Arc<ThumbnailReadPermits>);

impl ThumbnailReadPermits {
    fn new(capacity: usize) -> Self {
        Self {
            available: Mutex::new(capacity),
            available_changed: Condvar::new(),
        }
    }

    fn acquire(self: &Arc<Self>) -> Result<ThumbnailReadPermit, String> {
        let mut available = self
            .available
            .lock()
            .map_err(|_| "Unable to access the thumbnail read queue.".to_string())?;
        while *available == 0 {
            available = self
                .available_changed
                .wait(available)
                .map_err(|_| "Unable to access the thumbnail read queue.".to_string())?;
        }
        *available -= 1;
        Ok(ThumbnailReadPermit(Arc::clone(self)))
    }
}

impl Drop for ThumbnailReadPermit {
    fn drop(&mut self) {
        if let Ok(mut available) = self.0.available.lock() {
            *available += 1;
            self.0.available_changed.notify_one();
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailIndexEntry {
    size: u64,
    modified_at: u128,
    #[serde(default = "default_thumbnail_capture_position")]
    capture_position: String,
    thumbnail_file: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ThumbnailIndex {
    entries: HashMap<String, ThumbnailIndexEntry>,
}

struct ThumbnailIndexState(Arc<Mutex<ThumbnailIndex>>);

struct ThumbnailCacheDirectory(PathBuf);

/// The player only receives a loopback URL; the request handler validates the file again.
struct VideoStreamServer {
    base_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct VideoStreamQuery {
    path: String,
    #[serde(default)]
    mode: VideoStreamMode,
    start: Option<f64>,
}

#[derive(Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum VideoStreamMode {
    #[default]
    Direct,
    Transcode,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoStreamUrl {
    url: String,
    is_transcoded: bool,
    duration: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecycleResult {
    recycled_paths: Vec<String>,
    failed_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RenameResult {
    old_path: String,
    new_path: String,
    name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CopyResult {
    copied_paths: Vec<String>,
    skipped_paths: Vec<String>,
    failed_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailResult {
    path: String,
    thumbnail_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailFailure {
    path: String,
    error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailBatchResult {
    thumbnails: Vec<ThumbnailResult>,
    failures: Vec<ThumbnailFailure>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailData {
    path: String,
    thumbnail_path: String,
    data_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogSnapshot {
    path: String,
    content: String,
    size: u64,
}

enum FileOperationTask {
    Recycle {
        paths: Vec<PathBuf>,
        response: mpsc::Sender<RecycleResult>,
    },
    Rename {
        path: PathBuf,
        new_stem: String,
        response: mpsc::Sender<Result<RenameResult, String>>,
    },
    Copy {
        paths: Vec<String>,
        destination: PathBuf,
        response: mpsc::Sender<CopyResult>,
    },
}

struct FileOperationQueue(mpsc::Sender<FileOperationTask>);

fn app_data_dir() -> Result<PathBuf, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("Unable to resolve the application location: {error}"))?;
    let executable_dir = executable
        .parent()
        .ok_or_else(|| "Unable to resolve the application directory.".to_string())?;
    // Keep all mutable state beside the executable, as required by the portable install model.
    let data_dir = executable_dir.join("data");
    fs::create_dir_all(data_dir.join("backups"))
        .map_err(|error| format!("Unable to create the data directory: {error}"))?;
    Ok(data_dir)
}

fn config_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("config.json"))
}

fn log_dir() -> Result<PathBuf, String> {
    let directory = app_data_dir()?.join("logs");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Unable to create the log directory: {error}"))?;
    Ok(directory)
}

fn log_path() -> Result<PathBuf, String> {
    Ok(log_dir()?.join("video-sweeper.log"))
}

fn unix_millis(time: Result<SystemTime, std::io::Error>) -> Option<u128> {
    time.ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis())
}

fn path_string(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(target_os = "windows")]
    {
        if let Some(unc_path) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{unc_path}");
        }
        if let Some(normal_path) = value.strip_prefix(r"\\?\") {
            return normal_path.to_string();
        }
    }
    value.to_string()
}

fn thumbnail_cache_dir() -> Result<PathBuf, String> {
    let directory = app_data_dir()?.join("thumbnails");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Unable to create the thumbnail cache: {error}"))?;
    Ok(directory)
}

fn fnv1a_hash(bytes: &[u8]) -> u64 {
    domain::fnv1a_64(bytes)
}

fn thumbnail_source_key(path: &Path) -> String {
    let mut source = path_string(path);
    if cfg!(target_os = "windows") {
        source = source.to_ascii_lowercase();
    }
    source
}

fn thumbnail_path_for(path: &Path) -> Result<PathBuf, String> {
    Ok(thumbnail_cache_dir()?.join(format!(
        "{:016x}.jpg",
        fnv1a_hash(thumbnail_source_key(path).as_bytes())
    )))
}

fn thumbnail_index_path() -> Result<PathBuf, String> {
    Ok(thumbnail_cache_dir()?.join("index.json"))
}

fn load_thumbnail_index() -> ThumbnailIndex {
    let Ok(path) = thumbnail_index_path() else {
        return ThumbnailIndex::default();
    };
    if !path.is_file() {
        return ThumbnailIndex::default();
    }

    match fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<ThumbnailIndex>(&bytes).ok())
    {
        Some(index) => index,
        None => {
            log::warn!(
                "Unable to read thumbnail index {}; starting with an empty index.",
                path_string(&path)
            );
            ThumbnailIndex::default()
        }
    }
}

#[cfg(target_os = "windows")]
fn replace_thumbnail_index_file(temporary_path: &Path, path: &Path) -> Result<(), String> {
    let temporary_wide: Vec<u16> = temporary_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let destination_wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        MoveFileExW(
            PCWSTR(temporary_wide.as_ptr()),
            PCWSTR(destination_wide.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|error| format!("Unable to atomically replace the thumbnail index: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn replace_thumbnail_index_file(temporary_path: &Path, path: &Path) -> Result<(), String> {
    fs::rename(temporary_path, path)
        .map_err(|error| format!("Unable to atomically replace the thumbnail index: {error}"))
}

fn persist_thumbnail_index(index: &ThumbnailIndex) -> Result<(), String> {
    let path = thumbnail_index_path()?;
    let temporary_path = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(index)
        .map_err(|error| format!("Unable to serialize the thumbnail index: {error}"))?;
    fs::write(&temporary_path, bytes)
        .map_err(|error| format!("Unable to write the thumbnail index: {error}"))?;
    replace_thumbnail_index_file(&temporary_path, &path)
}

fn cached_thumbnail_path(
    path: &Path,
    metadata: &fs::Metadata,
    thumbnail_index: &Arc<Mutex<ThumbnailIndex>>,
    thumbnail_cache_dir: &Path,
    capture_position: &str,
) -> Option<String> {
    let source_key = thumbnail_source_key(path);
    let modified_at = unix_millis(metadata.modified()).unwrap_or(0);
    let entry = thumbnail_index
        .lock()
        .ok()?
        .entries
        .get(&source_key)
        .cloned();
    if let Some(entry) = entry {
        if entry.size != metadata.len()
            || entry.modified_at != modified_at
            || entry.capture_position != thumbnail_capture_cache_key(capture_position)
        {
            log::debug!("Thumbnail index stale for {}.", path_string(path));
            return None;
        }

        return Some(path_string(&thumbnail_cache_dir.join(entry.thumbnail_file)));
    }
    None
}

fn record_thumbnail_cache(
    path: &Path,
    metadata: &fs::Metadata,
    thumbnail_path: &Path,
    thumbnail_index: &Arc<Mutex<ThumbnailIndex>>,
    capture_position: &str,
    persist_immediately: bool,
) -> Result<(), String> {
    let thumbnail_file = thumbnail_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Unable to resolve the thumbnail file name.".to_string())?
        .to_string();
    let source_key = thumbnail_source_key(path);
    let modified_at = unix_millis(metadata.modified()).unwrap_or(0);
    let mut index = thumbnail_index
        .lock()
        .map_err(|_| "Unable to access the thumbnail index.".to_string())?;
    index.entries.insert(
        source_key,
        ThumbnailIndexEntry {
            size: metadata.len(),
            modified_at,
            capture_position: thumbnail_capture_cache_key(capture_position).to_string(),
            thumbnail_file,
        },
    );
    if persist_immediately {
        persist_thumbnail_index(&index)?;
    }
    Ok(())
}

fn remove_thumbnail_cache_entry(
    path: &Path,
    thumbnail_index: &Arc<Mutex<ThumbnailIndex>>,
) -> Result<(), String> {
    let source_key = thumbnail_source_key(path);
    let mut index = thumbnail_index
        .lock()
        .map_err(|_| "Unable to access the thumbnail index.".to_string())?;
    if index.entries.remove(&source_key).is_some() {
        persist_thumbnail_index(&index)?;
    }
    Ok(())
}

fn resolve_sidecar(name: &str) -> Result<PathBuf, String> {
    sidecar::resolve_sidecar(name)
}

fn configure_sidecar_command(command: &mut Command) {
    sidecar::configure_sidecar_command(command)
}

fn wait_for_child(child: &mut Child, timeout: Duration) -> Result<(), String> {
    sidecar::wait_for_child(child, timeout)
}
fn thumbnail_capture_cache_key(position: &str) -> &str {
    media_processing::thumbnail_capture_cache_key(position)
}

fn probe_video_metadata_batch(
    paths: Vec<String>,
    media_sidecar_pool: Arc<MediaSidecarPermits>,
) -> MetadataBatchResult {
    media_processing::probe_video_metadata_batch(paths, media_sidecar_pool)
}

fn generate_thumbnail_batch_impl(
    paths: Vec<String>,
    media_sidecar_pool: Arc<MediaSidecarPermits>,
    thumbnail_index: Arc<Mutex<ThumbnailIndex>>,
    thumbnail_cache_dir: PathBuf,
    capture_position: String,
    app_handle: tauri::AppHandle,
) -> Result<ThumbnailBatchResult, String> {
    media_processing::generate_thumbnail_batch_impl(
        paths,
        media_sidecar_pool,
        thumbnail_index,
        thumbnail_cache_dir,
        capture_position,
        app_handle,
    )
}

fn thumbnail_data_impl(
    path: &Path,
    thumbnail_index: &Arc<Mutex<ThumbnailIndex>>,
    thumbnail_cache_dir: &Path,
    capture_position: &str,
) -> Result<ThumbnailData, String> {
    media_processing::thumbnail_data_impl(
        path,
        thumbnail_index,
        thumbnail_cache_dir,
        capture_position,
    )
}
fn folder_name(path: &Path) -> String {
    config_store::folder_name(path)
}

fn validate_config(config: &mut AppConfig) -> Result<(), String> {
    config_store::validate_config(config)
}

fn write_config(config: &AppConfig) -> Result<(), String> {
    config_store::write_config(config)
}

fn load_config() -> Result<AppConfig, String> {
    config_store::load_config()
}

fn is_supported_video_path(path: &Path, settings: &Preferences) -> bool {
    config_store::is_supported_video_path(path, settings)
}

fn resolve_stream_video_path(path: &str) -> Result<PathBuf, String> {
    media_stream::resolve_stream_video_path(path)
}

fn probe_preview_duration(video_path: &Path) -> Result<Option<f64>, String> {
    media_stream::probe_preview_duration(video_path)
}

fn encode_query_component(value: &str) -> String {
    media_stream::encode_query_component(value)
}

fn start_video_stream_server() -> Result<String, String> {
    media_stream::start_video_stream_server()
}

fn available_roots(settings: &Preferences) -> Vec<DirectoryEntry> {
    workspace::available_roots(settings)
}

fn list_directory_impl(
    path: &str,
    settings: &Preferences,
    thumbnail_index: &Arc<Mutex<ThumbnailIndex>>,
    thumbnail_cache_dir: &Path,
) -> Result<DirectoryListing, String> {
    workspace::list_directory_impl(path, settings, thumbnail_index, thumbnail_cache_dir)
}
#[tauri::command]
fn load_application_state() -> Result<ApplicationState, String> {
    log::info!("Loading application state");
    let config = load_config()?;
    Ok(ApplicationState {
        roots: available_roots(&config.settings),
        config,
    })
}

#[tauri::command]
fn is_running_as_administrator() -> bool {
    #[cfg(target_os = "windows")]
    unsafe {
        IsUserAnAdmin().as_bool()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[tauri::command]
async fn list_directory(
    path: String,
    thumbnail_index: tauri::State<'_, ThumbnailIndexState>,
    thumbnail_cache_directory: tauri::State<'_, ThumbnailCacheDirectory>,
    app_handle: tauri::AppHandle,
) -> Result<DirectoryListing, String> {
    let thumbnail_index = Arc::clone(&thumbnail_index.0);
    let thumbnail_cache_dir = thumbnail_cache_directory.0.clone();
    let listing = tauri::async_runtime::spawn_blocking(move || {
        log::info!("Listing directory: {path}");
        let config = load_config()?;
        let listing = list_directory_impl(
            &path,
            &config.settings,
            &thumbnail_index,
            &thumbnail_cache_dir,
        )?;
        log::info!(
            "Listed directory: {} folders={}, videos={}, media_suppressed={}",
            listing.path,
            listing.folders.len(),
            listing.videos.len(),
            listing.media_suppressed
        );
        Ok::<DirectoryListing, String>(listing)
    })
    .await
    .map_err(|error| format!("The directory worker failed: {error}"))??;
    app_handle
        .fs_scope()
        .allow_directory(Path::new(&listing.path), false)
        .map_err(|error| format!("Unable to allow workspace file watching: {error}"))?;
    Ok(listing)
}

#[tauri::command]
fn save_configuration(mut config: AppConfig) -> Result<AppConfig, String> {
    validate_config(&mut config)?;
    write_config(&config)?;
    Ok(config)
}

#[tauri::command]
fn set_last_workspace(path: Option<String>) -> Result<AppConfig, String> {
    let mut config = load_config()?;
    if let Some(path) = path {
        let directory = fs::canonicalize(path)
            .map_err(|error| format!("Unable to use this folder as a workspace: {error}"))?;
        if !directory.is_dir() {
            return Err("The selected workspace is not a folder.".to_string());
        }
        config.last_workspace = Some(path_string(&directory));
    } else {
        config.last_workspace = None;
    }
    write_config(&config)?;
    Ok(config)
}

#[tauri::command]
fn set_workspace_focus(workspace_path: String, video_path: String) -> Result<(), String> {
    log::debug!(
        "Persisting workspace focus request: workspace={}, video={}",
        workspace_path,
        video_path
    );
    let workspace = fs::canonicalize(workspace_path).map_err(|error| {
        log::warn!("Unable to resolve focus workspace: {error}");
        format!("Unable to access the workspace for focus persistence: {error}")
    })?;
    if !workspace.is_dir() {
        log::warn!(
            "Rejected focus workspace because it is not a directory: {:?}",
            workspace
        );
        return Err("The focus workspace is not a folder.".to_string());
    }
    let video = fs::canonicalize(video_path).map_err(|error| {
        log::warn!("Unable to resolve focused video: {error}");
        format!("Unable to access the focused video: {error}")
    })?;
    if !video.is_file() {
        log::warn!(
            "Rejected focus video because it is not a regular file: {:?}",
            video
        );
        return Err("The focused item is not a regular file.".to_string());
    }
    let video_parent = video
        .parent()
        .and_then(|parent| fs::canonicalize(parent).ok())
        .ok_or_else(|| {
            log::warn!(
                "Unable to resolve parent folder for focused video: {:?}",
                video
            );
            "Unable to resolve the focused video's parent folder.".to_string()
        })?;
    if video_parent != workspace {
        log::warn!(
            "Rejected focus video outside workspace: workspace={:?}, video_parent={:?}",
            workspace,
            video_parent
        );
        return Err("The focused video is not a direct item of the workspace.".to_string());
    }

    let mut config = load_config()?;
    let normalized_workspace = path_string(&workspace);
    let normalized_video = path_string(&video);
    let previous_focus = config
        .workspace_focus
        .get(&normalized_workspace)
        .map(|focus| focus.video_path.clone())
        .unwrap_or_else(|| "<none>".to_string());
    config.workspace_focus.insert(
        normalized_workspace.clone(),
        WorkspaceFocus {
            video_path: normalized_video.clone(),
        },
    );
    write_config(&config)?;
    log::debug!(
        "Persisted workspace focus: workspace={}, previous={}, current={}",
        normalized_workspace,
        previous_focus,
        normalized_video
    );
    Ok(())
}

#[tauri::command]
fn set_workspace_sort(
    workspace_path: String,
    sort_key: String,
    sort_ascending: bool,
) -> Result<(), String> {
    if !domain::is_supported_sort_key(&sort_key) {
        return Err("The workspace sort key is not supported.".to_string());
    }
    let workspace = fs::canonicalize(workspace_path)
        .map_err(|error| format!("Unable to access the workspace for sort persistence: {error}"))?;
    if !workspace.is_dir() {
        return Err("The sort workspace is not a folder.".to_string());
    }

    let normalized_workspace = path_string(&workspace);
    let mut config = load_config()?;
    config.workspace_sort.insert(
        normalized_workspace.clone(),
        WorkspaceSort {
            key: sort_key.clone(),
            ascending: sort_ascending,
        },
    );
    write_config(&config)?;
    log::debug!(
        "Persisted workspace sort: workspace={}, key={}, ascending={}",
        normalized_workspace,
        sort_key,
        sort_ascending
    );
    Ok(())
}

#[tauri::command]
fn toggle_favorite(path: String) -> Result<AppConfig, String> {
    let mut config = load_config()?;
    let directory = fs::canonicalize(path)
        .map_err(|error| format!("Unable to update the favorite folder: {error}"))?;
    if !directory.is_dir() {
        return Err("Favorites must be folders.".to_string());
    }
    let normalized_path = path_string(&directory);
    if let Some(index) = config
        .favorites
        .iter()
        .position(|favorite| favorite.path.eq_ignore_ascii_case(&normalized_path))
    {
        config.favorites.remove(index);
    } else {
        config.favorites.push(FavoriteFolder {
            name: folder_name(&directory),
            path: normalized_path,
        });
    }
    validate_config(&mut config)?;
    write_config(&config)?;
    Ok(config)
}

fn normalize_video_paths(paths: Vec<String>) -> Result<Vec<PathBuf>, String> {
    file_operations::normalize_video_paths(paths)
}

fn start_file_operation_queue() -> FileOperationQueue {
    file_operations::start_file_operation_queue()
}

fn enqueue_recycle(
    paths: Vec<PathBuf>,
    queue: &FileOperationQueue,
) -> Result<RecycleResult, String> {
    file_operations::enqueue_recycle(paths, queue)
}

fn enqueue_rename(
    path: PathBuf,
    new_stem: String,
    queue: &FileOperationQueue,
) -> Result<RenameResult, String> {
    file_operations::enqueue_rename(path, new_stem, queue)
}

fn enqueue_copy(
    paths: Vec<String>,
    destination: PathBuf,
    queue: &FileOperationQueue,
) -> Result<CopyResult, String> {
    file_operations::enqueue_copy(paths, destination, queue)
}
#[tauri::command]
fn recycle_videos(
    paths: Vec<String>,
    queue: tauri::State<FileOperationQueue>,
) -> Result<RecycleResult, String> {
    log::info!("Recycling {} video(s)", paths.len());
    enqueue_recycle(normalize_video_paths(paths)?, &queue)
}

#[tauri::command]
fn rename_video(
    path: String,
    new_stem: String,
    queue: tauri::State<FileOperationQueue>,
) -> Result<RenameResult, String> {
    let paths = normalize_video_paths(vec![path])?;
    enqueue_rename(
        paths.into_iter().next().expect("one normalized video path"),
        new_stem,
        &queue,
    )
}

#[tauri::command]
fn copy_videos_to_workspace(
    paths: Vec<String>,
    workspace_path: String,
    queue: tauri::State<FileOperationQueue>,
) -> Result<CopyResult, String> {
    let destination = fs::canonicalize(workspace_path)
        .map_err(|error| format!("Unable to access the current workspace: {error}"))?;
    if !destination.is_dir() {
        return Err("The current workspace is not a folder.".to_string());
    }
    if paths.is_empty() {
        return Err("Drop at least one file to copy it into the workspace.".to_string());
    }
    enqueue_copy(paths, destination, &queue)
}

#[tauri::command]
async fn generate_thumbnails(
    paths: Vec<String>,
    app_handle: tauri::AppHandle,
    media_sidecar_pool: tauri::State<'_, MediaSidecarPool>,
    thumbnail_index: tauri::State<'_, ThumbnailIndexState>,
    thumbnail_cache_directory: tauri::State<'_, ThumbnailCacheDirectory>,
) -> Result<ThumbnailBatchResult, String> {
    if paths.is_empty() {
        return Ok(ThumbnailBatchResult {
            thumbnails: Vec::new(),
            failures: Vec::new(),
        });
    }
    let media_sidecar_pool = Arc::clone(&media_sidecar_pool.0);
    let thumbnail_index = Arc::clone(&thumbnail_index.0);
    let thumbnail_cache_dir = thumbnail_cache_directory.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let capture_position = load_config()?.settings.thumbnail_capture_position;
        generate_thumbnail_batch_impl(
            paths,
            media_sidecar_pool,
            thumbnail_index,
            thumbnail_cache_dir,
            capture_position,
            app_handle,
        )
    })
    .await
    .map_err(|error| format!("The thumbnail worker failed: {error}"))?
}

#[tauri::command]
async fn probe_video_metadata_batch_command(
    paths: Vec<String>,
    media_sidecar_pool: tauri::State<'_, MediaSidecarPool>,
) -> Result<MetadataBatchResult, String> {
    if paths.len() > MAX_PARALLEL_THUMBNAIL_TASKS {
        return Err(format!(
            "A metadata batch may contain at most {MAX_PARALLEL_THUMBNAIL_TASKS} videos."
        ));
    }
    let media_sidecar_pool = Arc::clone(&media_sidecar_pool.0);
    tauri::async_runtime::spawn_blocking(move || {
        probe_video_metadata_batch(paths, media_sidecar_pool)
    })
    .await
    .map_err(|error| format!("The metadata worker failed: {error}"))
}

#[tauri::command]
async fn read_thumbnail(
    path: String,
    thumbnail_index: tauri::State<'_, ThumbnailIndexState>,
    thumbnail_cache_directory: tauri::State<'_, ThumbnailCacheDirectory>,
    thumbnail_read_pool: tauri::State<'_, ThumbnailReadPool>,
) -> Result<ThumbnailData, String> {
    let thumbnail_index = Arc::clone(&thumbnail_index.0);
    let thumbnail_cache_dir = thumbnail_cache_directory.0.clone();
    let thumbnail_read_pool = Arc::clone(&thumbnail_read_pool.0);
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = thumbnail_read_pool.acquire()?;
        let capture_position = load_config()?.settings.thumbnail_capture_position;
        thumbnail_data_impl(
            Path::new(&path),
            &thumbnail_index,
            &thumbnail_cache_dir,
            &capture_position,
        )
    })
    .await
    .map_err(|error| format!("The thumbnail reader failed: {error}"))?
}

#[tauri::command]
fn get_video_stream_url(
    path: String,
    start_seconds: Option<f64>,
    force_transcode: Option<bool>,
    video_stream_server: tauri::State<VideoStreamServer>,
) -> Result<VideoStreamUrl, String> {
    let video_path = resolve_stream_video_path(&path)?;
    let is_transcoded = force_transcode.unwrap_or(false);
    let duration = if is_transcoded {
        match probe_preview_duration(&video_path) {
            Ok(value) => value,
            Err(error) => {
                log::warn!(
                    "Unable to read the duration for FFmpeg preview {}: {error}",
                    path_string(&video_path)
                );
                None
            }
        }
    } else {
        None
    };
    let base_url = video_stream_server
        .base_url
        .as_ref()
        .ok_or_else(|| "The local video stream service is unavailable.".to_string())?;
    let start_seconds = start_seconds
        .filter(|start| start.is_finite() && *start > 0.0)
        .unwrap_or(0.0);
    let mode = if is_transcoded { "&mode=transcode" } else { "" };
    let start = if is_transcoded && start_seconds > 0.0 {
        format!("&start={start_seconds:.3}")
    } else {
        String::new()
    };
    Ok(VideoStreamUrl {
        url: format!(
            "{base_url}?path={}{}{}",
            encode_query_component(&path_string(&video_path)),
            mode,
            start,
        ),
        is_transcoded,
        duration,
    })
}

#[tauri::command]
fn open_video_externally(path: String) -> Result<(), String> {
    let video_path = resolve_stream_video_path(&path)?;
    Command::new("explorer.exe")
        .arg(&video_path)
        .spawn()
        .map_err(|error| format!("Unable to open the selected video externally: {error}"))?;
    Ok(())
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let target = fs::canonicalize(path)
        .map_err(|error| format!("Unable to access the selected path: {error}"))?;
    let metadata = fs::metadata(&target)
        .map_err(|error| format!("Unable to inspect the selected path: {error}"))?;
    let mut explorer = Command::new("explorer.exe");
    if metadata.is_dir() {
        explorer.arg(&target);
    } else {
        explorer.arg(format!("/select,{}", path_string(&target)));
    }
    explorer
        .spawn()
        .map_err(|error| format!("Unable to show the selected path in Explorer: {error}"))?;
    Ok(())
}

fn start_windows_file_drag(paths: Vec<PathBuf>) -> Result<(), String> {
    windows_shell::start_windows_file_drag(paths)
}

#[tauri::command]
fn start_file_drag(paths: Vec<String>) -> Result<(), String> {
    let paths = normalize_video_paths(paths)?;
    log::debug!("Received file-drag command for {} video(s)", paths.len());
    start_windows_file_drag(paths)
}

#[tauri::command]
fn read_recent_logs(max_bytes: Option<u64>) -> Result<LogSnapshot, String> {
    let path = log_path()?;
    let limit = max_bytes
        .unwrap_or(256 * 1024)
        .clamp(16 * 1024, 1024 * 1024);
    if !path.exists() {
        return Ok(LogSnapshot {
            path: path_string(&path),
            content: String::new(),
            size: 0,
        });
    }

    let metadata =
        fs::metadata(&path).map_err(|error| format!("Unable to inspect the log file: {error}"))?;
    let bytes = fs::read(&path).map_err(|error| format!("Unable to read the log file: {error}"))?;
    let start = bytes.len().saturating_sub(limit as usize);
    let content = String::from_utf8_lossy(&bytes[start..]).to_string();
    Ok(LogSnapshot {
        path: path_string(&path),
        content,
        size: metadata.len(),
    })
}

#[tauri::command]
fn show_file_context_menu(
    window: tauri::WebviewWindow,
    path: String,
    paths: Option<Vec<String>>,
    x: f64,
    y: f64,
    is_directory: bool,
    state: tauri::State<ContextMenuState>,
) -> Result<(), String> {
    menus::show_file_context_menu(window, path, paths, x, y, is_directory, state)
}

fn open_context_target(target: &ContextMenuTarget) -> Result<(), String> {
    menus::open_context_target(target)
}

fn reveal_context_target(target: &ContextMenuTarget) -> Result<(), String> {
    menus::reveal_context_target(target)
}
fn main() {
    let log_directory = log_dir().expect("failed to create VideoSweeper log directory");
    let thumbnail_cache_directory =
        thumbnail_cache_dir().expect("failed to create VideoSweeper thumbnail cache directory");
    let video_stream_server = match start_video_stream_server() {
        Ok(base_url) => VideoStreamServer {
            base_url: Some(base_url),
        },
        Err(error) => {
            eprintln!("Unable to start the local video stream server: {error}");
            VideoStreamServer { base_url: None }
        }
    };
    tauri::Builder::default()
        .manage(ContextMenuState(Mutex::new(None)))
        .manage(MediaSidecarPool(Arc::new(MediaSidecarPermits::new(
            MAX_PARALLEL_THUMBNAIL_TASKS,
        ))))
        .manage(ThumbnailReadPool(Arc::new(ThumbnailReadPermits::new(
            MAX_PARALLEL_THUMBNAIL_READS,
        ))))
        .manage(ThumbnailIndexState(Arc::new(Mutex::new(
            load_thumbnail_index(),
        ))))
        .manage(ThumbnailCacheDirectory(thumbnail_cache_directory))
        .manage(video_stream_server)
        .manage(start_file_operation_queue())
        // Plugins are registered here so their native capabilities are available to the webview.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .clear_targets()
                .level(log::LevelFilter::Debug)
                .max_file_size(1024 * 1024)
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::Webview),
                    Target::new(TargetKind::Folder {
                        path: log_directory,
                        file_name: Some("video-sweeper".to_string()),
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            // A second launch should surface the existing main window instead of opening another one.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .on_menu_event(|app, event| {
            let result = match event.id().as_ref() {
                "context-menu-open"
                | "context-menu-reveal"
                | "context-menu-refresh"
                | "context-menu-copy-to"
                | "context-menu-delete" => {
                    let target = app
                        .state::<ContextMenuState>()
                        .0
                        .lock()
                        .ok()
                        .and_then(|mut current| current.take());
                    match target {
                        Some(target) if event.id().as_ref() == "context-menu-open" => {
                            open_context_target(&target)
                        }
                        Some(_) if event.id().as_ref() == "context-menu-refresh" => {
                            app.emit("workspace-refresh-request", ()).map_err(|error| {
                                format!("Unable to request a workspace refresh: {error}")
                            })
                        }
                        Some(target) if event.id().as_ref() == "context-menu-delete" => {
                            let queue = app.state::<FileOperationQueue>().0.clone();
                            let (response_sender, response_receiver) = mpsc::channel();
                            match queue.send(FileOperationTask::Recycle {
                                paths: target.operation_paths,
                                response: response_sender,
                            }) {
                                Ok(()) => {
                                    let app_handle = app.clone();
                                    thread::spawn(move || {
                                        if let Ok(result) = response_receiver.recv() {
                                            let _ = app_handle.emit("files-recycled", result);
                                        }
                                    });
                                    Ok(())
                                }
                                Err(_) => {
                                    Err("The file operation queue is unavailable.".to_string())
                                }
                            }
                        }
                        Some(target) if event.id().as_ref() == "context-menu-copy-to" => app
                            .emit(
                                "copy-to-request",
                                target
                                    .operation_paths
                                    .iter()
                                    .map(|path| path_string(path))
                                    .collect::<Vec<_>>(),
                            )
                            .map_err(|error| {
                                format!("Unable to request a copy destination: {error}")
                            }),
                        Some(target) => reveal_context_target(&target),
                        None => Ok(()),
                    }
                }
                _ => return,
            };
            if let Err(error) = result {
                eprintln!("{error}");
            }
        })
        .invoke_handler(tauri::generate_handler![
            load_application_state,
            is_running_as_administrator,
            list_directory,
            save_configuration,
            set_last_workspace,
            set_workspace_focus,
            set_workspace_sort,
            toggle_favorite,
            show_file_context_menu,
            generate_thumbnails,
            probe_video_metadata_batch_command,
            read_thumbnail,
            get_video_stream_url,
            open_video_externally,
            start_file_drag,
            read_recent_logs,
            recycle_videos,
            rename_video,
            copy_videos_to_workspace,
            reveal_path
        ])
        .run(tauri::generate_context!())
        .expect("failed to run VideoSweeper");
}
