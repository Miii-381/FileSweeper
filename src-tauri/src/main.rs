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
use notify::{RecursiveMode, Watcher};
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
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Condvar, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{ContextMenu, Menu, MenuItem},
    Emitter, LogicalPosition, Manager,
};
use tauri_plugin_log::{Target, TargetKind};
use tower::ServiceExt;
use tower_http::services::ServeFile;
#[cfg(target_os = "windows")]
use windows::{
    core::{HRESULT, HSTRING, PCWSTR},
    Win32::{
        Foundation::{
            GlobalFree, DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, HGLOBAL,
            HWND, LPARAM, S_OK, WPARAM,
        },
        Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH},
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IBindCtx, IDataObject,
            CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, DATADIR_GET, DVASPECT_CONTENT,
            FORMATETC, STGMEDIUM, STGMEDIUM_0, TYMED_HGLOBAL,
        },
        System::DataExchange::{
            CloseClipboard, GetClipboardData, GetClipboardSequenceNumber,
            IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW,
        },
        System::Memory::{
            GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT,
        },
        System::{
            Ole::{
                DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize, OleSetClipboard,
                OleUninitialize, CF_HDROP, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_MOVE,
            },
            SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS},
            Threading::GetCurrentThreadId,
        },
        UI::Shell::{
            BHID_DataObject, Common::ITEMIDLIST, DragQueryFileW, FileOperation, IFileOperation,
            IShellFolder, IShellItem, IsUserAnAdmin, SHBindToParent, SHCreateDataObject,
            SHCreateItemFromParsingName, SHCreateShellItemArrayFromIDLists,
            SHOpenFolderAndSelectItems, SHParseDisplayName, FOFX_RECYCLEONDELETE,
            FOF_NOCONFIRMATION, HDROP,
        },
        UI::WindowsAndMessaging::{
            DispatchMessageW, GetMessageW, PeekMessageW, PostThreadMessageW, TranslateMessage, MSG,
            PM_NOREMOVE, WM_APP,
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

const CONFIG_VERSION: u32 = 2;
const DEFAULT_EXTENSIONS: [&str; 14] = [
    ".mp4", ".mkv", ".webm", ".avi", ".mov", ".wmv", ".flv", ".m4v", ".mpeg", ".mpg", ".3gp",
    ".rm", ".rmvb", ".ts",
];

static CONFIG_STORE: OnceLock<config_store::ConfigStore> = OnceLock::new();

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
struct DirectoryChildren {
    path: String,
    folders: Vec<DirectoryEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceListing {
    path: String,
    videos: Vec<VideoEntry>,
    media_suppressed: bool,
    is_available: bool,
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

struct ActiveWorkspaceWatcher {
    path: PathBuf,
    _watcher: notify::RecommendedWatcher,
}

struct WorkspaceWatchState {
    latest_request: AtomicU64,
    active: Mutex<Option<ActiveWorkspaceWatcher>>,
}

impl WorkspaceWatchState {
    fn new() -> Self {
        Self {
            latest_request: AtomicU64::new(0),
            active: Mutex::new(None),
        }
    }

    fn begin(&self, request_id: u64) {
        self.latest_request.fetch_max(request_id, Ordering::SeqCst);
    }

    fn clear_if_latest(&self, request_id: u64) {
        if self.latest_request.load(Ordering::SeqCst) == request_id {
            if let Ok(mut active) = self.active.lock() {
                *active = None;
            }
        }
    }

    fn clear_path(&self, path: &Path) {
        if let Ok(mut active) = self.active.lock() {
            let matches = active.as_ref().is_some_and(|watcher| {
                path_string(&watcher.path).eq_ignore_ascii_case(&path_string(path))
            });
            if matches {
                *active = None;
            }
        }
    }

    fn watch_if_latest(
        &self,
        request_id: u64,
        path: &Path,
        app_handle: &tauri::AppHandle,
    ) -> Result<(), String> {
        if self.latest_request.load(Ordering::SeqCst) != request_id {
            return Ok(());
        }
        let mut active = self
            .active
            .lock()
            .map_err(|_| "Unable to access the workspace watcher.".to_string())?;
        if active.as_ref().is_some_and(|watcher| watcher.path == path) {
            return Ok(());
        }

        let event_app = app_handle.clone();
        let watched_path = path.to_path_buf();
        let event_path = path_string(path);
        let mut watcher = notify::recommended_watcher(
            move |result: notify::Result<notify::Event>| match result {
                Ok(_) => {
                    let _ = event_app.emit("workspace-file-event", &event_path);
                }
                Err(error) => {
                    log::warn!("Workspace watcher error for {event_path}: {error}");
                    let _ = event_app.emit("workspace-file-event", &event_path);
                }
            },
        )
        .map_err(|error| format!("Unable to create the workspace watcher: {error}"))?;
        watcher
            .watch(&watched_path, RecursiveMode::NonRecursive)
            .map_err(|error| format!("Unable to watch the workspace: {error}"))?;
        *active = Some(ActiveWorkspaceWatcher {
            path: watched_path,
            _watcher: watcher,
        });
        Ok(())
    }
}

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
    transcode_controller: Arc<TranscodeController>,
}

struct TranscodeController {
    generation: AtomicU64,
    active_processes: Mutex<HashMap<u32, String>>,
    processes_changed: Condvar,
}

struct TranscodeRegistration {
    controller: Arc<TranscodeController>,
    process_id: u32,
}

impl TranscodeController {
    fn new() -> Self {
        Self {
            generation: AtomicU64::new(0),
            active_processes: Mutex::new(HashMap::new()),
            processes_changed: Condvar::new(),
        }
    }

    fn register(self: &Arc<Self>, process_id: u32, video_path: &Path) -> TranscodeRegistration {
        if let Ok(mut active) = self.active_processes.lock() {
            active.insert(process_id, path_string(video_path));
        }
        TranscodeRegistration {
            controller: Arc::clone(self),
            process_id,
        }
    }

    fn stop_video(&self, video_path: &Path) -> Result<bool, String> {
        let normalized_path = path_string(video_path);
        let process_ids = self
            .active_processes
            .lock()
            .map_err(|_| "Unable to access the FFmpeg preview process list.".to_string())?
            .iter()
            .filter_map(|(process_id, active_path)| {
                active_path
                    .eq_ignore_ascii_case(&normalized_path)
                    .then_some(*process_id)
            })
            .collect::<Vec<_>>();
        if process_ids.is_empty() {
            return Ok(false);
        }

        self.generation.fetch_add(1, Ordering::SeqCst);
        for process_id in &process_ids {
            terminate_process_tree(*process_id)?;
        }

        let deadline = Instant::now() + Duration::from_secs(3);
        let mut active = self
            .active_processes
            .lock()
            .map_err(|_| "Unable to access the FFmpeg preview process list.".to_string())?;
        while process_ids
            .iter()
            .any(|process_id| active.contains_key(process_id))
        {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(
                    "FFmpeg did not exit before the delete operation timed out.".to_string()
                );
            }
            let (next, wait_result) = self
                .processes_changed
                .wait_timeout(active, remaining)
                .map_err(|_| "Unable to wait for the FFmpeg preview process.".to_string())?;
            active = next;
            if wait_result.timed_out()
                && process_ids
                    .iter()
                    .any(|process_id| active.contains_key(process_id))
            {
                return Err(
                    "FFmpeg did not exit before the delete operation timed out.".to_string()
                );
            }
        }
        Ok(true)
    }
}

impl Drop for TranscodeRegistration {
    fn drop(&mut self) {
        if let Ok(mut active) = self.controller.active_processes.lock() {
            active.remove(&self.process_id);
            self.controller.processes_changed.notify_all();
        }
    }
}

#[cfg(test)]
mod transcode_controller_tests {
    use super::*;

    #[test]
    fn registration_tracks_video_until_the_process_owner_is_dropped() {
        let controller = Arc::new(TranscodeController::new());
        let path = Path::new(r"D:\Videos\focused.mp4");
        let registration = controller.register(42, path);
        assert_eq!(
            controller
                .active_processes
                .lock()
                .unwrap()
                .get(&42)
                .map(String::as_str),
            Some(r"D:\Videos\focused.mp4")
        );
        drop(registration);
        assert!(controller.active_processes.lock().unwrap().is_empty());
        assert!(!controller.stop_video(path).unwrap());
    }
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

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum FileTaskOperation {
    Copy,
    Move,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum FileTaskState {
    Queued,
    Running,
    Completed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum FileTaskItemStatus {
    Completed,
    Skipped,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct FileTaskItemResult {
    source_path: String,
    destination_path: Option<String>,
    status: FileTaskItemStatus,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileTaskSnapshot {
    id: u64,
    operation: FileTaskOperation,
    state: FileTaskState,
    destination_path: String,
    total_items: usize,
    completed_items: usize,
    results: Vec<FileTaskItemResult>,
}

#[derive(Clone)]
struct FileTaskControl {
    snapshot: Arc<Mutex<FileTaskSnapshot>>,
    cancel: Arc<AtomicBool>,
}

struct ClipboardFiles {
    paths: Vec<String>,
    operation: FileTaskOperation,
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
    Transfer {
        control: FileTaskControl,
        paths: Vec<String>,
        destination: PathBuf,
        operation: FileTaskOperation,
        app_handle: tauri::AppHandle,
    },
}

enum ClipboardOperationTask {
    WriteClipboard {
        paths: Vec<PathBuf>,
        operation: FileTaskOperation,
        owner: Option<isize>,
        response: mpsc::Sender<Result<(), String>>,
    },
    ReadClipboard {
        response: mpsc::Sender<Result<ClipboardFiles, String>>,
    },
}

struct FileOperationQueue {
    sender: mpsc::Sender<FileOperationTask>,
    clipboard_sender: mpsc::Sender<ClipboardOperationTask>,
    #[cfg(target_os = "windows")]
    clipboard_thread_id: u32,
    tasks: Arc<Mutex<HashMap<u64, FileTaskControl>>>,
    next_task_id: AtomicU64,
}

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
fn atomic_replace_file(temporary_path: &Path, path: &Path, label: &str) -> Result<(), String> {
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
    .map_err(|error| format!("Unable to atomically replace the {label}: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn atomic_replace_file(temporary_path: &Path, path: &Path, label: &str) -> Result<(), String> {
    fs::rename(temporary_path, path)
        .map_err(|error| format!("Unable to atomically replace the {label}: {error}"))
}

fn persist_thumbnail_index(index: &ThumbnailIndex) -> Result<(), String> {
    let path = thumbnail_index_path()?;
    let temporary_path = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(index)
        .map_err(|error| format!("Unable to serialize the thumbnail index: {error}"))?;
    fs::write(&temporary_path, bytes)
        .map_err(|error| format!("Unable to write the thumbnail index: {error}"))?;
    atomic_replace_file(&temporary_path, &path, "thumbnail index")
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

fn load_config() -> Result<AppConfig, String> {
    CONFIG_STORE
        .get()
        .ok_or_else(|| "The configuration store is not initialized.".to_string())?
        .snapshot()
}

fn update_config<F>(update: F) -> Result<AppConfig, String>
where
    F: FnOnce(&mut AppConfig) -> Result<(), String>,
{
    CONFIG_STORE
        .get()
        .ok_or_else(|| "The configuration store is not initialized.".to_string())?
        .update_config(update)
}

fn update_workspace_state<F>(update: F) -> Result<AppConfig, String>
where
    F: FnOnce(&mut AppConfig) -> Result<(), String>,
{
    CONFIG_STORE
        .get()
        .ok_or_else(|| "The configuration store is not initialized.".to_string())?
        .update_workspace_state(update)
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

fn start_video_stream_server(controller: Arc<TranscodeController>) -> Result<String, String> {
    media_stream::start_video_stream_server(controller)
}

#[cfg(target_os = "windows")]
fn terminate_process_tree(process_id: u32) -> Result<(), String> {
    let mut command = Command::new("taskkill");
    configure_sidecar_command(&mut command);
    command
        .args(["/PID", &process_id.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|_| ())
        .map_err(|error| format!("Unable to stop the FFmpeg preview process: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn terminate_process_tree(process_id: u32) -> Result<(), String> {
    Command::new("kill")
        .args(["-TERM", &process_id.to_string()])
        .status()
        .map(|_| ())
        .map_err(|error| format!("Unable to stop the FFmpeg preview process: {error}"))
}

fn available_roots(settings: &Preferences) -> Vec<DirectoryEntry> {
    workspace::available_roots(settings)
}

fn list_subdirectories_impl(
    path: &str,
    settings: &Preferences,
) -> Result<DirectoryChildren, String> {
    workspace::list_subdirectories_impl(path, settings)
}

fn scan_workspace_impl(
    path: &str,
    settings: &Preferences,
    thumbnail_index: &Arc<Mutex<ThumbnailIndex>>,
    thumbnail_cache_dir: &Path,
) -> Result<WorkspaceListing, String> {
    workspace::scan_workspace_impl(path, settings, thumbnail_index, thumbnail_cache_dir)
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
async fn list_subdirectories(path: String) -> Result<DirectoryChildren, String> {
    tauri::async_runtime::spawn_blocking(move || {
        log::debug!("Listing directory tree children: {path}");
        let config = load_config()?;
        list_subdirectories_impl(&path, &config.settings)
    })
    .await
    .map_err(|error| format!("The directory tree worker failed: {error}"))?
}

#[tauri::command]
async fn workspace_is_accessible(
    path: String,
    watch_state: tauri::State<'_, WorkspaceWatchState>,
) -> Result<bool, String> {
    let checked_path = PathBuf::from(&path);
    let worker_path = checked_path.clone();
    let accessible = tauri::async_runtime::spawn_blocking(move || {
        fs::metadata(&worker_path).is_ok_and(|metadata| metadata.is_dir())
            && fs::read_dir(&worker_path).is_ok()
    })
    .await
    .map_err(|error| format!("The workspace availability worker failed: {error}"))?;
    if !accessible {
        watch_state.clear_path(&checked_path);
    }
    Ok(accessible)
}

#[tauri::command]
async fn scan_workspace(
    path: String,
    request_id: u64,
    thumbnail_index: tauri::State<'_, ThumbnailIndexState>,
    thumbnail_cache_directory: tauri::State<'_, ThumbnailCacheDirectory>,
    watch_state: tauri::State<'_, WorkspaceWatchState>,
    app_handle: tauri::AppHandle,
) -> Result<WorkspaceListing, String> {
    watch_state.begin(request_id);
    let thumbnail_index = Arc::clone(&thumbnail_index.0);
    let thumbnail_cache_dir = thumbnail_cache_directory.0.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        log::info!("Scanning workspace: {path}");
        let config = load_config()?;
        let listing = scan_workspace_impl(
            &path,
            &config.settings,
            &thumbnail_index,
            &thumbnail_cache_dir,
        )?;
        log::info!(
            "Scanned workspace: {} videos={}, media_suppressed={}",
            listing.path,
            listing.videos.len(),
            listing.media_suppressed
        );
        Ok::<WorkspaceListing, String>(listing)
    })
    .await
    .map_err(|error| format!("The workspace worker failed: {error}"))?;
    match result {
        Ok(listing) => {
            watch_state.watch_if_latest(request_id, Path::new(&listing.path), &app_handle)?;
            Ok(listing)
        }
        Err(error) => {
            watch_state.clear_if_latest(request_id);
            Err(error)
        }
    }
}

#[tauri::command]
fn save_configuration(settings: Preferences) -> Result<AppConfig, String> {
    update_config(move |config| {
        config.settings = settings;
        Ok(())
    })
}

#[tauri::command]
fn set_audio_preferences(volume: u8, muted: bool) -> Result<AppConfig, String> {
    update_config(move |config| {
        config.settings.volume = volume;
        config.settings.muted = muted;
        Ok(())
    })
}

#[tauri::command]
fn set_list_columns(list_columns: Vec<ListColumn>) -> Result<AppConfig, String> {
    update_config(move |config| {
        config.settings.list_columns = list_columns;
        Ok(())
    })
}

#[tauri::command]
fn set_last_workspace(path: Option<String>) -> Result<AppConfig, String> {
    let normalized = if let Some(path) = path {
        let directory = fs::canonicalize(path)
            .map_err(|error| format!("Unable to use this folder as a workspace: {error}"))?;
        if !directory.is_dir() {
            return Err("The selected workspace is not a folder.".to_string());
        }
        Some(path_string(&directory))
    } else {
        None
    };
    update_config(move |config| {
        config.last_workspace = normalized;
        Ok(())
    })
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

    let normalized_workspace = path_string(&workspace);
    let normalized_video = path_string(&video);
    let log_workspace = normalized_workspace.clone();
    let log_video = normalized_video.clone();
    update_workspace_state(move |config| {
        config.workspace_focus.insert(
            normalized_workspace,
            WorkspaceFocus {
                video_path: normalized_video,
            },
        );
        Ok(())
    })?;
    log::debug!(
        "Persisted workspace focus: workspace={}, current={}",
        log_workspace,
        log_video
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
    let log_workspace = normalized_workspace.clone();
    let log_sort_key = sort_key.clone();
    update_workspace_state(move |config| {
        config.workspace_sort.insert(
            normalized_workspace,
            WorkspaceSort {
                key: sort_key,
                ascending: sort_ascending,
            },
        );
        Ok(())
    })?;
    log::debug!(
        "Persisted workspace sort: workspace={}, key={}, ascending={}",
        log_workspace,
        log_sort_key,
        sort_ascending
    );
    Ok(())
}

#[tauri::command]
fn toggle_favorite(path: String) -> Result<AppConfig, String> {
    let directory = fs::canonicalize(path)
        .map_err(|error| format!("Unable to update the favorite folder: {error}"))?;
    if !directory.is_dir() {
        return Err("Favorites must be folders.".to_string());
    }
    let normalized_path = path_string(&directory);
    let name = folder_name(&directory);
    update_config(move |config| {
        if let Some(index) = config
            .favorites
            .iter()
            .position(|favorite| favorite.path.eq_ignore_ascii_case(&normalized_path))
        {
            config.favorites.remove(index);
        } else {
            config.favorites.push(FavoriteFolder {
                name,
                path: normalized_path,
            });
        }
        Ok(())
    })
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
    focused_video_path: Option<String>,
    queue: tauri::State<FileOperationQueue>,
    video_stream_server: tauri::State<VideoStreamServer>,
) -> Result<RecycleResult, String> {
    log::info!("Recycling {} video(s)", paths.len());
    let normalized_paths = normalize_video_paths(paths)?;
    if let Some(focused_video_path) = focused_video_path {
        let focused_path = fs::canonicalize(focused_video_path).map_err(|error| {
            format!("Unable to access the focused video before deletion: {error}")
        })?;
        if normalized_paths.iter().any(|path| path == &focused_path) {
            let stopped = video_stream_server
                .transcode_controller
                .stop_video(&focused_path)?;
            if stopped {
                log::info!(
                    "Stopped the focused FFmpeg preview before recycling: {}",
                    path_string(&focused_path)
                );
            }
        }
    }
    enqueue_recycle(normalized_paths, &queue)
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

fn normalize_transfer_destination(path: String) -> Result<PathBuf, String> {
    let destination = fs::canonicalize(path)
        .map_err(|error| format!("Unable to access the destination folder: {error}"))?;
    if !destination.is_dir() {
        return Err("The transfer destination is not a folder.".to_string());
    }
    Ok(destination)
}

#[tauri::command]
fn start_file_task(
    paths: Vec<String>,
    destination_path: String,
    operation: FileTaskOperation,
    app_handle: tauri::AppHandle,
    queue: tauri::State<FileOperationQueue>,
) -> Result<FileTaskSnapshot, String> {
    let destination = normalize_transfer_destination(destination_path)?;
    file_operations::start_transfer_task(paths, destination, operation, app_handle, &queue)
}

#[tauri::command]
fn get_file_task(
    task_id: u64,
    queue: tauri::State<FileOperationQueue>,
) -> Result<FileTaskSnapshot, String> {
    file_operations::get_file_task(task_id, &queue)
}

#[tauri::command]
fn cancel_file_task(task_id: u64, queue: tauri::State<FileOperationQueue>) -> Result<bool, String> {
    file_operations::cancel_file_task(task_id, &queue)
}

#[tauri::command]
fn write_files_to_clipboard(
    paths: Vec<String>,
    operation: FileTaskOperation,
    window: tauri::WebviewWindow,
    queue: tauri::State<FileOperationQueue>,
) -> Result<(), String> {
    log::info!(
        "Received file clipboard write request: operation={operation:?}, requested_paths={}",
        paths.len()
    );
    let paths = normalize_video_paths(paths)?;
    #[cfg(target_os = "windows")]
    let owner = Some(
        window
            .hwnd()
            .map_err(|error| format!("Unable to resolve the clipboard owner window: {error}"))?
            .0 as isize,
    );
    #[cfg(not(target_os = "windows"))]
    let owner = None;
    file_operations::enqueue_write_clipboard(paths, operation, owner, &queue)
}

#[tauri::command]
fn paste_files_from_clipboard(
    destination_path: String,
    app_handle: tauri::AppHandle,
    queue: tauri::State<FileOperationQueue>,
) -> Result<FileTaskSnapshot, String> {
    log::info!("Received file clipboard paste request: destination={destination_path}");
    let destination = normalize_transfer_destination(destination_path)?;
    let clipboard = file_operations::enqueue_read_clipboard(&queue)?;
    log::info!(
        "Creating file task from clipboard: operation={:?}, files={}, destination={}",
        clipboard.operation,
        clipboard.paths.len(),
        path_string(&destination)
    );
    file_operations::start_transfer_task(
        clipboard.paths,
        destination,
        clipboard.operation,
        app_handle,
        &queue,
    )
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
async fn stop_transcoded_preview(
    path: String,
    video_stream_server: tauri::State<'_, VideoStreamServer>,
) -> Result<bool, String> {
    let controller = Arc::clone(&video_stream_server.transcode_controller);
    tauri::async_runtime::spawn_blocking(move || {
        let video_path = fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(path));
        controller.stop_video(&video_path)
    })
    .await
    .map_err(|error| format!("The FFmpeg shutdown worker failed: {error}"))?
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
        return windows_shell::reveal_windows_path(&target);
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
    let configuration = config_store::ConfigStore::open(
        config_path().expect("failed to resolve VideoSweeper configuration path"),
    )
    .expect("failed to initialize VideoSweeper configuration");
    CONFIG_STORE
        .set(configuration)
        .unwrap_or_else(|_| panic!("VideoSweeper configuration was initialized more than once"));
    let log_directory = log_dir().expect("failed to create VideoSweeper log directory");
    let thumbnail_cache_directory =
        thumbnail_cache_dir().expect("failed to create VideoSweeper thumbnail cache directory");
    let transcode_controller = Arc::new(TranscodeController::new());
    let video_stream_server = match start_video_stream_server(Arc::clone(&transcode_controller)) {
        Ok(base_url) => VideoStreamServer {
            base_url: Some(base_url),
            transcode_controller,
        },
        Err(error) => {
            eprintln!("Unable to start the local video stream server: {error}");
            VideoStreamServer {
                base_url: None,
                transcode_controller,
            }
        }
    };
    tauri::Builder::default()
        .manage(ContextMenuState(Mutex::new(None)))
        .manage(WorkspaceWatchState::new())
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
                            let controller =
                                Arc::clone(&app.state::<VideoStreamServer>().transcode_controller);
                            let stop_result = target
                                .operation_paths
                                .iter()
                                .try_for_each(|path| controller.stop_video(path).map(|_| ()));
                            if let Err(error) = stop_result {
                                return eprintln!("{error}");
                            }
                            let queue = app.state::<FileOperationQueue>().sender.clone();
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
            list_subdirectories,
            workspace_is_accessible,
            scan_workspace,
            save_configuration,
            set_audio_preferences,
            set_list_columns,
            set_last_workspace,
            set_workspace_focus,
            set_workspace_sort,
            toggle_favorite,
            show_file_context_menu,
            generate_thumbnails,
            probe_video_metadata_batch_command,
            read_thumbnail,
            get_video_stream_url,
            stop_transcoded_preview,
            open_video_externally,
            start_file_drag,
            read_recent_logs,
            recycle_videos,
            rename_video,
            copy_videos_to_workspace,
            start_file_task,
            get_file_task,
            cancel_file_task,
            write_files_to_clipboard,
            paste_files_from_clipboard,
            reveal_path
        ])
        .run(tauri::generate_context!())
        .expect("failed to run VideoSweeper");
}
