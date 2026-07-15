#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use axum::{
    extract::{Query, Request},
    http::StatusCode,
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
    sync::{mpsc, Arc, Condvar, Mutex},
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
    core::{HSTRING, PCWSTR},
    Win32::{
        Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH},
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_APARTMENTTHREADED,
        },
        UI::Shell::{
            FileOperation, IFileOperation, IShellItem, IsUserAnAdmin, SHCreateItemFromParsingName,
            FOFX_RECYCLEONDELETE, FOF_NOCONFIRMATION,
        },
    },
};

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
    show_hidden_items: bool,
    show_nomedia_media: bool,
    video_extensions: Vec<String>,
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
            show_hidden_items: false,
            show_nomedia_media: false,
            video_extensions: DEFAULT_EXTENSIONS
                .iter()
                .map(|item| item.to_string())
                .collect(),
            open_unsupported_externally: true,
            list_columns: default_list_columns(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    version: u32,
    favorites: Vec<FavoriteFolder>,
    last_workspace: Option<String>,
    settings: Preferences,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            favorites: Vec::new(),
            last_workspace: None,
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
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
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

fn sidecar_filename(name: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{name}-x86_64-pc-windows-msvc.exe")
    } else {
        name.to_string()
    }
}

fn add_sidecar_candidates(base: &Path, name: &str, candidates: &mut Vec<PathBuf>) {
    let sidecar = sidecar_filename(name);
    candidates.push(base.join(&sidecar));
    candidates.push(base.join("sidecars").join(&sidecar));
    candidates.push(base.join("..").join("sidecars").join(&sidecar));
    if cfg!(target_os = "windows") {
        candidates.push(base.join(format!("{name}.exe")));
        candidates.push(base.join("bin").join(format!("{name}.exe")));
    }
}

fn resolve_sidecar(name: &str) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(current_dir) = std::env::current_dir() {
        let mut cursor = Some(current_dir.as_path());
        while let Some(directory) = cursor {
            add_sidecar_candidates(directory, name, &mut candidates);
            cursor = directory.parent();
        }
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(executable_dir) = executable.parent() {
            let mut cursor = Some(executable_dir);
            while let Some(directory) = cursor {
                add_sidecar_candidates(directory, name, &mut candidates);
                cursor = directory.parent();
            }
        }
    }

    let resolved = candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .map(|candidate| fs::canonicalize(&candidate).unwrap_or(candidate));
    match resolved {
        Some(path) => {
            log::debug!("Resolved {name} sidecar at {}", path_string(&path));
            Ok(path)
        }
        None => {
            log::error!("Unable to locate the {name} sidecar.");
            Err(format!("Unable to locate the {name} sidecar."))
        }
    }
}

fn configure_sidecar_command(command: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        // Keep background media helpers behind the interactive GUI in the Windows scheduler.
        command.creation_flags(0x0000_4000); // BELOW_NORMAL_PRIORITY_CLASS
    }
    #[cfg(not(target_os = "windows"))]
    let _ = command;
}

fn read_child_stderr(child: &mut Child) -> String {
    let Some(mut stderr) = child.stderr.take() else {
        return String::new();
    };
    let mut output = String::new();
    let _ = stderr.read_to_string(&mut output);
    output.trim().to_string()
}

fn wait_for_child(child: &mut Child, timeout: Duration) -> Result<(), String> {
    let start = Instant::now();
    loop {
        match child
            .try_wait()
            .map_err(|error| format!("Unable to wait for the media sidecar: {error}"))?
        {
            Some(status) if status.success() => return Ok(()),
            Some(status) => {
                let stderr = read_child_stderr(child);
                if stderr.is_empty() {
                    return Err(format!("The media sidecar exited with status {status}."));
                }
                return Err(format!(
                    "The media sidecar exited with status {status}: {stderr}"
                ));
            }
            None if start.elapsed() >= timeout => {
                #[cfg(target_os = "windows")]
                {
                    let _ = Command::new("taskkill")
                        .args(["/PID", &child.id().to_string(), "/T", "/F"])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status();
                }
                let _ = child.kill();
                let _ = child.wait();
                return Err("The media sidecar timed out.".to_string());
            }
            None => thread::sleep(Duration::from_millis(100)),
        }
    }
}

fn thumbnail_capture_time(position: &str) -> &str {
    match position {
        "opening" => "00:00:01",
        "early" => "25%",
        "late" => "75%",
        "ending" => "90%",
        _ => "50%",
    }
}

fn thumbnail_capture_fraction(position: &str) -> f64 {
    match position {
        "early" => 0.25,
        "late" => 0.75,
        "ending" => 0.90,
        _ => 0.50,
    }
}

fn thumbnail_capture_cache_key(position: &str) -> &str {
    match position {
        // The generator is part of the cache identity so old ffmpeg frames are regenerated.
        "opening" => "opening-1s-thumbnailer-v1",
        "early" => "early-thumbnailer-v1",
        "late" => "late-thumbnailer-v1",
        "ending" => "ending-thumbnailer-v1",
        _ => "middle-thumbnailer-v1",
    }
}

fn render_thumbnail(
    thumbnailer: &Path,
    video_path: &Path,
    output_path: &Path,
    capture_time: &str,
) -> Result<bool, String> {
    let _ = fs::remove_file(output_path);
    let mut command = Command::new(thumbnailer);
    configure_sidecar_command(&mut command);
    let mut child = command
        .args(["-i"])
        .arg(video_path)
        .args(["-o"])
        .arg(output_path)
        .args(["-s", "480", "-t", capture_time, "-q", "7", "-c", "jpeg"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Unable to start ffmpegthumbnailer: {error}"))?;

    wait_for_child(&mut child, Duration::from_secs(30))?;
    Ok(output_path.is_file())
}

fn probe_duration(video_path: &Path) -> Option<f64> {
    let ffprobe = resolve_sidecar("ffprobe").ok()?;
    let mut command = Command::new(ffprobe);
    configure_sidecar_command(&mut command);
    let output = command
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(video_path)
        .output()
        .ok()?;
    if !output.status.success() {
        log::warn!(
            "ffprobe failed for {}: {}",
            path_string(video_path),
            String::from_utf8_lossy(&output.stderr).trim()
        );
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|duration| duration.is_finite() && *duration > 0.0)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoMetadata {
    path: String,
    duration: Option<f64>,
    width: Option<u32>,
    height: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MetadataBatchResult {
    metadata: Vec<VideoMetadata>,
    failed_paths: Vec<String>,
}

fn probe_video_metadata(video_path: &Path) -> Result<VideoMetadata, String> {
    let ffprobe = resolve_sidecar("ffprobe")?;
    let mut command = Command::new(ffprobe);
    configure_sidecar_command(&mut command);
    let output = command
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "format=duration:stream=width,height",
            "-of",
            "json",
        ])
        .arg(video_path)
        .output()
        .map_err(|error| format!("Unable to start ffprobe: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let document: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Unable to read ffprobe metadata: {error}"))?;
    let duration = document
        .get("format")
        .and_then(|format| format.get("duration"))
        .and_then(|duration| duration.as_str())
        .and_then(|duration| duration.parse::<f64>().ok())
        .filter(|duration| duration.is_finite() && *duration > 0.0);
    let stream = document
        .get("streams")
        .and_then(|streams| streams.as_array())
        .and_then(|streams| streams.first());
    let width = stream
        .and_then(|stream| stream.get("width"))
        .and_then(|width| width.as_u64())
        .and_then(|width| u32::try_from(width).ok())
        .filter(|width| *width > 0);
    let height = stream
        .and_then(|stream| stream.get("height"))
        .and_then(|height| height.as_u64())
        .and_then(|height| u32::try_from(height).ok())
        .filter(|height| *height > 0);
    Ok(VideoMetadata {
        path: path_string(video_path),
        duration,
        width,
        height,
    })
}

fn probe_video_metadata_batch(
    paths: Vec<String>,
    media_sidecar_pool: Arc<MediaSidecarPermits>,
) -> MetadataBatchResult {
    let workers = paths
        .into_iter()
        .map(|path| {
            let media_sidecar_pool = Arc::clone(&media_sidecar_pool);
            thread::spawn(move || {
                let source_path = path.clone();
                let result = (|| {
                    let _permit = media_sidecar_pool.acquire()?;
                    let video_path = fs::canonicalize(&path)
                        .map_err(|error| format!("Unable to access this video: {error}"))?;
                    probe_video_metadata(&video_path)
                })();
                (source_path, result)
            })
        })
        .collect::<Vec<_>>();
    let mut metadata = Vec::new();
    let mut failed_paths = Vec::new();
    for worker in workers {
        match worker.join() {
            Ok((_, Ok(result))) => metadata.push(result),
            Ok((path, Err(error))) => {
                log::warn!("Unable to probe video metadata for {path}: {error}");
                failed_paths.push(path);
            }
            Err(_) => failed_paths.push("<unknown>".to_string()),
        }
    }
    MetadataBatchResult {
        metadata,
        failed_paths,
    }
}

fn render_thumbnail_with_ffmpeg(
    video_path: &Path,
    output_path: &Path,
    capture_position: &str,
) -> Result<bool, String> {
    let ffmpeg = resolve_sidecar("ffmpeg")?;
    let timestamp = if capture_position == "opening" {
        1.0
    } else {
        probe_duration(video_path)
            .map(|duration| {
                (duration * thumbnail_capture_fraction(capture_position))
                    .min((duration - 0.05).max(0.0))
            })
            .unwrap_or(2.0)
    };
    let timestamp = format!("{timestamp:.3}");
    let _ = fs::remove_file(output_path);
    let mut command = Command::new(ffmpeg);
    configure_sidecar_command(&mut command);
    let mut child = command
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            &timestamp,
            "-i",
        ])
        .arg(video_path)
        .args([
            "-frames:v",
            "1",
            "-vf",
            "scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2",
            "-q:v",
            "7",
        ])
        .arg(output_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Unable to start FFmpeg fallback: {error}"))?;

    wait_for_child(&mut child, Duration::from_secs(30))?;
    Ok(output_path.is_file())
}

fn generate_thumbnail_impl(
    path: &Path,
    thumbnail_index: &Arc<Mutex<ThumbnailIndex>>,
    thumbnail_cache_dir: &Path,
    capture_position: &str,
    persist_immediately: bool,
) -> Result<PathBuf, String> {
    let video_path =
        fs::canonicalize(path).map_err(|error| format!("Unable to access this video: {error}"))?;
    let metadata = fs::metadata(&video_path)
        .map_err(|error| format!("Unable to inspect this video: {error}"))?;
    if !metadata.is_file() {
        return Err("The selected path is not a video file.".to_string());
    }

    if let Some(thumbnail_path) = cached_thumbnail_path(
        &video_path,
        &metadata,
        thumbnail_index,
        thumbnail_cache_dir,
        capture_position,
    ) {
        log::debug!(
            "Thumbnail cache hit for {} -> {}",
            path_string(&video_path),
            thumbnail_path
        );
        return Ok(PathBuf::from(thumbnail_path));
    }
    let thumbnail_path = thumbnail_path_for(&video_path)?;

    log::info!(
        "Generating thumbnail for {} -> {}",
        path_string(&video_path),
        path_string(&thumbnail_path)
    );
    let thumbnailer = resolve_sidecar("ffmpegthumbnailer")?;
    let capture_time = thumbnail_capture_time(capture_position);
    let temporary_path = thumbnail_path.with_extension("tmp.jpg");
    let generated = match render_thumbnail(&thumbnailer, &video_path, &temporary_path, capture_time)
    {
        Ok(true) => true,
        Ok(false) => {
            log::warn!(
                "ffmpegthumbnailer produced no image for {}; using FFmpeg fallback.",
                path_string(&video_path)
            );
            render_thumbnail_with_ffmpeg(&video_path, &temporary_path, capture_position)?
        }
        Err(error) => {
            log::warn!(
                "ffmpegthumbnailer failed for {}; using FFmpeg fallback: {}",
                path_string(&video_path),
                error
            );
            render_thumbnail_with_ffmpeg(&video_path, &temporary_path, capture_position)?
        }
    };
    if !generated {
        let error =
            "Neither ffmpegthumbnailer nor the FFmpeg fallback created a thumbnail.".to_string();
        log::error!(
            "Thumbnail generation failed for {}: {}",
            path_string(&video_path),
            error
        );
        return Err(error);
    }
    if thumbnail_path.exists() {
        fs::remove_file(&thumbnail_path)
            .map_err(|error| format!("Unable to replace the cached thumbnail: {error}"))?;
    }
    fs::rename(&temporary_path, &thumbnail_path)
        .map_err(|error| format!("Unable to store the cached thumbnail: {error}"))?;
    record_thumbnail_cache(
        &video_path,
        &metadata,
        &thumbnail_path,
        thumbnail_index,
        capture_position,
        persist_immediately,
    )?;
    log::info!(
        "Thumbnail generated for {} -> {}",
        path_string(&video_path),
        path_string(&thumbnail_path)
    );
    Ok(thumbnail_path)
}

fn generate_thumbnail_batch_impl(
    paths: Vec<String>,
    media_sidecar_pool: Arc<MediaSidecarPermits>,
    thumbnail_index: Arc<Mutex<ThumbnailIndex>>,
    thumbnail_cache_dir: PathBuf,
    capture_position: String,
    app_handle: tauri::AppHandle,
) -> Result<ThumbnailBatchResult, String> {
    if paths.len() > MAX_PARALLEL_THUMBNAIL_TASKS {
        return Err(format!(
            "A thumbnail batch may contain at most {MAX_PARALLEL_THUMBNAIL_TASKS} videos."
        ));
    }

    let workers = paths
        .into_iter()
        .map(|path| {
            let media_sidecar_pool = Arc::clone(&media_sidecar_pool);
            let thumbnail_index = Arc::clone(&thumbnail_index);
            let thumbnail_cache_dir = thumbnail_cache_dir.clone();
            let capture_position = capture_position.clone();
            let app_handle = app_handle.clone();
            thread::spawn(move || {
                let source_path = path.clone();
                let result = (|| {
                    let _permit = media_sidecar_pool.acquire()?;
                    let video_path = fs::canonicalize(&path)
                        .map_err(|error| format!("Unable to access this video: {error}"))?;
                    let thumbnail_path = generate_thumbnail_impl(
                        &video_path,
                        &thumbnail_index,
                        &thumbnail_cache_dir,
                        &capture_position,
                        false,
                    )?;
                    Ok(ThumbnailResult {
                        path: path_string(&video_path),
                        thumbnail_path: path_string(&thumbnail_path),
                    })
                })();
                if let Ok(thumbnail) = &result {
                    // The JPEG and in-memory index are ready now; persist the index once after the batch.
                    let _ = app_handle.emit("thumbnail-generated", thumbnail.clone());
                }
                (source_path, result)
            })
        })
        .collect::<Vec<_>>();

    let mut thumbnails = Vec::new();
    let mut failures = Vec::new();
    for worker in workers {
        match worker.join() {
            Ok((_, Ok(result))) => thumbnails.push(result),
            Ok((path, Err(error))) => failures.push(ThumbnailFailure { path, error }),
            Err(_) => failures.push(ThumbnailFailure {
                path: "<unknown>".to_string(),
                error: "The thumbnail worker panicked.".to_string(),
            }),
        }
    }

    if !thumbnails.is_empty() {
        let index = thumbnail_index
            .lock()
            .map_err(|_| "Unable to access the thumbnail index.".to_string())?;
        persist_thumbnail_index(&index)?;
    }

    Ok(ThumbnailBatchResult {
        thumbnails,
        failures,
    })
}

fn thumbnail_data_impl(
    path: &Path,
    thumbnail_index: &Arc<Mutex<ThumbnailIndex>>,
    thumbnail_cache_dir: &Path,
    capture_position: &str,
) -> Result<ThumbnailData, String> {
    let video_path =
        fs::canonicalize(path).map_err(|error| format!("Unable to access this video: {error}"))?;
    let metadata = fs::metadata(&video_path)
        .map_err(|error| format!("Unable to inspect this video: {error}"))?;
    let thumbnail_path = cached_thumbnail_path(
        &video_path,
        &metadata,
        thumbnail_index,
        thumbnail_cache_dir,
        capture_position,
    )
    .map(PathBuf::from)
    .ok_or_else(|| "No valid cached thumbnail is available for this video.".to_string())?;
    let bytes = match fs::read(&thumbnail_path) {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = remove_thumbnail_cache_entry(&video_path, thumbnail_index);
            return Err(format!(
                "Unable to read the cached thumbnail {}: {error}",
                path_string(&thumbnail_path)
            ));
        }
    };

    Ok(ThumbnailData {
        path: path_string(&video_path),
        thumbnail_path: path_string(&thumbnail_path),
        data_url: format!("data:image/jpeg;base64,{}", BASE64_STANDARD.encode(bytes)),
    })
}

fn folder_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| path_string(path))
}

fn backup_corrupt_config(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    let backup_dir = app_data_dir()?.join("backups");
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let backup_path = backup_dir.join(format!("config-corrupt-{timestamp}.json"));
    fs::copy(path, backup_path)
        .map_err(|error| format!("Unable to back up the invalid configuration: {error}"))?;
    Ok(())
}

fn validate_config(config: &mut AppConfig) -> Result<(), String> {
    if !matches!(
        config.settings.appearance.as_str(),
        "system" | "dark" | "light"
    ) {
        return Err("Appearance must be system, dark, or light.".to_string());
    }
    if !matches!(
        config.settings.accent_theme.as_str(),
        "teal" | "sky" | "amber" | "coral" | "lime"
    ) {
        return Err("The selected accent theme is not supported.".to_string());
    }
    if !(0.25..=100.0).contains(&config.settings.thumbnail_cache_gb) {
        return Err("Thumbnail cache size must be between 0.25 and 100 GB.".to_string());
    }
    if !matches!(
        config.settings.thumbnail_capture_position.as_str(),
        "opening" | "early" | "middle" | "late" | "ending"
    ) {
        return Err("Thumbnail capture position is not supported.".to_string());
    }

    config.settings.volume = config.settings.volume.min(100);
    config.settings.video_extensions = config
        .settings
        .video_extensions
        .iter()
        .map(|extension| extension.trim().to_ascii_lowercase())
        .filter(|extension| !extension.is_empty())
        .map(|extension| {
            if extension.starts_with('.') {
                extension
            } else {
                format!(".{extension}")
            }
        })
        .collect();
    config.settings.video_extensions.sort();
    config.settings.video_extensions.dedup();

    if config.settings.video_extensions.is_empty() {
        return Err("At least one supported video extension is required.".to_string());
    }

    // The filename is always the first visible column; other metadata columns may be rearranged.
    let defaults = default_list_columns();
    let allowed_columns: HashSet<&str> = defaults.iter().map(|column| column.id.as_str()).collect();
    let mut seen_columns = HashSet::new();
    let mut list_columns: Vec<ListColumn> = config
        .settings
        .list_columns
        .drain(..)
        .filter_map(|mut column| {
            if !allowed_columns.contains(column.id.as_str())
                || !seen_columns.insert(column.id.clone())
            {
                return None;
            }
            column.width = column.width.clamp(80, 520);
            if column.id == "name" {
                column.visible = true;
            }
            Some(column)
        })
        .collect();
    for column in defaults {
        if !seen_columns.contains(&column.id) {
            list_columns.push(column);
        }
    }
    if let Some(name_index) = list_columns.iter().position(|column| column.id == "name") {
        let name_column = list_columns.remove(name_index);
        list_columns.insert(0, name_column);
    }
    config.settings.list_columns = list_columns;

    // Normalize and de-duplicate favorites before writing so a path has one stable identity.
    let mut known_paths = HashSet::new();
    config.favorites.retain_mut(|favorite| {
        let normalized_path = path_string(&PathBuf::from(&favorite.path));
        if !known_paths.insert(normalized_path.to_ascii_lowercase()) {
            return false;
        }
        favorite.path = normalized_path;
        if favorite.name.trim().is_empty() {
            favorite.name = folder_name(Path::new(&favorite.path));
        }
        true
    });
    config
        .favorites
        .sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    config.version = CONFIG_VERSION;
    Ok(())
}

fn write_config(config: &AppConfig) -> Result<(), String> {
    let path = config_path()?;
    let temporary_path = path.with_extension("json.tmp");
    let serialized = serde_json::to_string_pretty(config)
        .map_err(|error| format!("Unable to serialize the configuration: {error}"))?;

    fs::write(&temporary_path, serialized)
        .map_err(|error| format!("Unable to stage the configuration: {error}"))?;
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|error| format!("Unable to replace the previous configuration: {error}"))?;
    }
    fs::rename(&temporary_path, &path)
        .map_err(|error| format!("Unable to commit the configuration: {error}"))?;
    Ok(())
}

fn load_config() -> Result<AppConfig, String> {
    let path = config_path()?;
    if !path.exists() {
        let config = AppConfig::default();
        write_config(&config)?;
        return Ok(config);
    }

    let source = fs::read_to_string(&path)
        .map_err(|error| format!("Unable to read the configuration: {error}"))?;
    let mut config = match serde_json::from_str::<AppConfig>(&source) {
        Ok(config) => config,
        Err(_) => {
            backup_corrupt_config(&path)?;
            let config = AppConfig::default();
            write_config(&config)?;
            return Ok(config);
        }
    };

    if validate_config(&mut config).is_err() {
        backup_corrupt_config(&path)?;
        let config = AppConfig::default();
        write_config(&config)?;
        return Ok(config);
    }

    Ok(config)
}

fn is_supported_video_path(path: &Path, settings: &Preferences) -> bool {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| format!(".{}", extension.to_ascii_lowercase()))
        .unwrap_or_default();
    settings
        .video_extensions
        .iter()
        .any(|configured| configured == &extension)
}

fn resolve_stream_video_path(path: &str) -> Result<PathBuf, String> {
    if !Path::new(path).is_absolute() {
        return Err("The requested video path must be absolute.".to_string());
    }
    let video_path = fs::canonicalize(path)
        .map_err(|error| format!("Unable to access the requested video: {error}"))?;
    let metadata = fs::metadata(&video_path)
        .map_err(|error| format!("Unable to inspect the requested video: {error}"))?;
    if !metadata.is_file() {
        return Err("The requested path is not a regular file.".to_string());
    }
    if !is_supported_video_path(&video_path, &load_config()?.settings) {
        return Err("The requested file type is not enabled for video preview.".to_string());
    }
    Ok(video_path)
}

fn encode_query_component(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push(HEX[(byte >> 4) as usize] as char);
            encoded.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    encoded
}

async fn serve_video_stream(Query(query): Query<VideoStreamQuery>, request: Request) -> Response {
    let video_path = match resolve_stream_video_path(&query.path) {
        Ok(path) => path,
        Err(error) => {
            log::warn!("Rejected local video stream request: {error}");
            return (
                StatusCode::BAD_REQUEST,
                "A valid enabled video file is required.",
            )
                .into_response();
        }
    };

    match ServeFile::new(video_path).oneshot(request).await {
        Ok(response) => response.into_response(),
        Err(error) => {
            log::error!("Unable to serve local video stream: {error}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Unable to read the requested video.",
            )
                .into_response()
        }
    }
}

fn start_video_stream_server() -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("Unable to bind the local video stream server: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Unable to configure the local video stream server: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("Unable to read the local video stream address: {error}"))?;

    thread::Builder::new()
        .name("video-stream-server".to_string())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_io()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    log::error!("Unable to start the local video stream runtime: {error}");
                    return;
                }
            };
            runtime.block_on(async move {
                let listener = match tokio::net::TcpListener::from_std(listener) {
                    Ok(listener) => listener,
                    Err(error) => {
                        log::error!("Unable to adopt the local video stream socket: {error}");
                        return;
                    }
                };
                let app =
                    Router::new().route("/video", get(serve_video_stream).head(serve_video_stream));
                if let Err(error) = axum::serve(listener, app).await {
                    log::error!("The local video stream server stopped unexpectedly: {error}");
                }
            });
        })
        .map_err(|error| format!("Unable to start the local video stream server: {error}"))?;

    Ok(format!("http://{address}/video"))
}

#[cfg(target_os = "windows")]
fn is_hidden_or_system(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
    metadata.file_attributes() & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0
}

#[cfg(not(target_os = "windows"))]
fn is_hidden_or_system(_metadata: &fs::Metadata) -> bool {
    false
}

fn has_visible_child_directories(directory: &Path, settings: &Preferences) -> bool {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(_) => return false,
    };

    entries.flatten().any(|entry| {
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => return false,
        };
        metadata.is_dir() && (settings.show_hidden_items || !is_hidden_or_system(&metadata))
    })
}

fn cleanup_interrupted_copy_files(directory: &Path) {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        if name.starts_with('.') && name.contains(".videosweeper-copy-") && name.ends_with(".tmp") {
            if let Err(error) = fs::remove_file(entry.path()) {
                log::warn!(
                    "Unable to remove interrupted copy file {}: {error}",
                    entry.path().display()
                );
            }
        }
    }
}

fn available_roots(settings: &Preferences) -> Vec<DirectoryEntry> {
    #[cfg(target_os = "windows")]
    {
        ('A'..='Z')
            .filter_map(|letter| {
                let path = PathBuf::from(format!("{letter}:\\"));
                path.exists().then(|| DirectoryEntry {
                    path: path_string(&path),
                    name: path_string(&path),
                    has_children: has_visible_child_directories(&path, settings),
                })
            })
            .collect()
    }

    #[cfg(not(target_os = "windows"))]
    {
        let path = PathBuf::from("/");
        vec![DirectoryEntry {
            path: path_string(&path),
            name: path_string(&path),
            has_children: has_visible_child_directories(&path, settings),
        }]
    }
}

fn list_directory_impl(
    path: &str,
    settings: &Preferences,
    thumbnail_index: &Arc<Mutex<ThumbnailIndex>>,
    thumbnail_cache_dir: &Path,
) -> Result<DirectoryListing, String> {
    let directory =
        fs::canonicalize(path).map_err(|error| format!("Unable to open this folder: {error}"))?;
    if !directory.is_dir() {
        return Err("The selected location is not a folder.".to_string());
    }
    cleanup_interrupted_copy_files(&directory);

    let media_suppressed = directory.join(".nomedia").is_file() && !settings.show_nomedia_media;
    let extensions: HashSet<&str> = settings
        .video_extensions
        .iter()
        .map(String::as_str)
        .collect();
    let mut folders = Vec::new();
    let mut videos = Vec::new();

    // Workspaces intentionally scan only immediate children; the tree navigates deeper on demand.
    for entry in fs::read_dir(&directory)
        .map_err(|error| format!("Unable to enumerate this folder: {error}"))?
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if !settings.show_hidden_items && is_hidden_or_system(&metadata) {
            continue;
        }

        let entry_path = entry.path();
        if metadata.is_dir() {
            folders.push(DirectoryEntry {
                path: path_string(&entry_path),
                name: folder_name(&entry_path),
                has_children: has_visible_child_directories(&entry_path, settings),
            });
            continue;
        }

        if media_suppressed || !metadata.is_file() {
            continue;
        }
        let extension = entry_path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| format!(".{}", extension.to_ascii_lowercase()))
            .unwrap_or_default();
        if !extensions.contains(extension.as_str()) {
            continue;
        }

        videos.push(VideoEntry {
            path: path_string(&entry_path),
            name: folder_name(&entry_path),
            extension,
            size: metadata.len(),
            created_at: unix_millis(metadata.created()),
            modified_at: unix_millis(metadata.modified()),
            duration: None,
            width: None,
            height: None,
            thumbnail_path: cached_thumbnail_path(
                &entry_path,
                &metadata,
                thumbnail_index,
                thumbnail_cache_dir,
                &settings.thumbnail_capture_position,
            ),
        });
    }

    folders.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    videos.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));

    Ok(DirectoryListing {
        path: path_string(&directory),
        folders,
        videos,
        media_suppressed,
    })
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
    let config = load_config()?;
    let extensions: HashSet<&str> = config
        .settings
        .video_extensions
        .iter()
        .map(String::as_str)
        .collect();
    let mut seen_paths = HashSet::new();
    let mut normalized_paths = Vec::new();

    for path in paths {
        let normalized = fs::canonicalize(path)
            .map_err(|error| format!("Unable to access the selected video: {error}"))?;
        let metadata = fs::metadata(&normalized)
            .map_err(|error| format!("Unable to inspect the selected video: {error}"))?;
        if !metadata.is_file() {
            return Err("Only video files can be moved to the Recycle Bin.".to_string());
        }
        let extension = normalized
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| format!(".{}", extension.to_ascii_lowercase()))
            .unwrap_or_default();
        if !extensions.contains(extension.as_str()) {
            return Err("Only supported video files can be moved to the Recycle Bin.".to_string());
        }
        if seen_paths.insert(path_string(&normalized).to_ascii_lowercase()) {
            normalized_paths.push(normalized);
        }
    }

    if normalized_paths.is_empty() {
        return Err("Select at least one video to move to the Recycle Bin.".to_string());
    }
    Ok(normalized_paths)
}

fn validate_file_stem(new_stem: &str) -> Result<String, String> {
    let stem = new_stem.trim();
    if stem.is_empty() || stem.ends_with('.') || stem.ends_with(' ') {
        return Err("The new file name cannot be empty or end with a dot or space.".to_string());
    }
    if stem.len() > 240
        || stem.chars().any(|character| {
            matches!(
                character,
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            )
        })
    {
        return Err(
            "The new file name contains characters that Windows does not allow.".to_string(),
        );
    }
    let reserved = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if reserved.iter().any(|name| stem.eq_ignore_ascii_case(name)) {
        return Err("The new file name is reserved by Windows.".to_string());
    }
    Ok(stem.to_string())
}

#[cfg(target_os = "windows")]
fn shell_item(path: &Path) -> Result<IShellItem, String> {
    unsafe {
        SHCreateItemFromParsingName(&HSTRING::from(path_string(path)), None)
            .map_err(|error| format!("Unable to prepare the selected video: {error}"))
    }
}

#[cfg(target_os = "windows")]
fn shell_file_operation() -> Result<IFileOperation, String> {
    unsafe {
        let operation: IFileOperation =
            CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER)
                .map_err(|error| format!("Unable to start the file operation: {error}"))?;
        operation
            .SetOperationFlags(FOF_NOCONFIRMATION)
            .map_err(|error| format!("Unable to configure the file operation: {error}"))?;
        Ok(operation)
    }
}

#[cfg(target_os = "windows")]
fn ensure_shell_operation_completed(operation: &IFileOperation) -> Result<(), String> {
    unsafe {
        if operation
            .GetAnyOperationsAborted()
            .map_err(|error| format!("Unable to inspect the file operation: {error}"))?
            .as_bool()
        {
            return Err("The file operation was cancelled.".to_string());
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn rename_path_with_shell(path: &Path, new_name: &str) -> Result<(), String> {
    unsafe {
        let operation = shell_file_operation()?;
        let item = shell_item(path)?;
        let name = HSTRING::from(new_name);
        operation
            .RenameItem(&item, PCWSTR(name.as_ptr()), None)
            .map_err(|error| format!("Unable to queue the video rename: {error}"))?;
        operation
            .PerformOperations()
            .map_err(|error| format!("Unable to rename the selected video: {error}"))?;
        ensure_shell_operation_completed(&operation)
    }
}

#[cfg(not(target_os = "windows"))]
fn rename_path_with_shell(path: &Path, new_name: &str) -> Result<(), String> {
    fs::rename(path, path.with_file_name(new_name))
        .map_err(|error| format!("Unable to rename the selected video: {error}"))
}

#[cfg(target_os = "windows")]
fn copy_path_with_shell(
    source: &Path,
    destination_directory: &Path,
    destination_name: &str,
) -> Result<(), String> {
    unsafe {
        let operation = shell_file_operation()?;
        let source_item = shell_item(source)?;
        let destination_item = shell_item(destination_directory)?;
        let name = HSTRING::from(destination_name);
        operation
            .CopyItem(&source_item, &destination_item, PCWSTR(name.as_ptr()), None)
            .map_err(|error| format!("Unable to queue the video copy: {error}"))?;
        operation
            .PerformOperations()
            .map_err(|error| format!("Unable to copy the selected video: {error}"))?;
        ensure_shell_operation_completed(&operation)
    }
}

#[cfg(not(target_os = "windows"))]
fn copy_path_with_shell(
    source: &Path,
    destination_directory: &Path,
    destination_name: &str,
) -> Result<(), String> {
    fs::copy(source, destination_directory.join(destination_name))
        .map(|_| ())
        .map_err(|error| format!("Unable to copy the selected video: {error}"))
}

fn rename_video_path(path: PathBuf, new_stem: String) -> Result<RenameResult, String> {
    let stem = validate_file_stem(&new_stem)?;
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| format!(".{extension}"))
        .unwrap_or_default();
    let new_name = format!("{stem}{extension}");
    let destination = path.with_file_name(&new_name);
    if destination != path && destination.exists() {
        return Err("A file with the new name already exists in this folder.".to_string());
    }
    rename_path_with_shell(&path, &new_name)?;
    Ok(RenameResult {
        old_path: path_string(&path),
        new_path: path_string(&destination),
        name: new_name,
    })
}

fn unique_copy_destination(source: &Path, destination_directory: &Path) -> Result<PathBuf, String> {
    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Unable to determine the source file name.".to_string())?;
    let stem = source
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Unable to determine the source file stem.".to_string())?;
    let extension = source
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| format!(".{extension}"))
        .unwrap_or_default();
    let first = destination_directory.join(file_name);
    if !first.exists() {
        return Ok(first);
    }
    for index in 1..10_000 {
        let candidate = destination_directory.join(format!("{stem} ({index}){extension}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("Unable to find an available destination file name.".to_string())
}

fn copy_videos_to_directory(paths: Vec<String>, destination: PathBuf) -> CopyResult {
    let config = match load_config() {
        Ok(config) => config,
        Err(_) => {
            return CopyResult {
                copied_paths: Vec::new(),
                skipped_paths: Vec::new(),
                failed_paths: paths,
            }
        }
    };
    let mut copied_paths = Vec::new();
    let mut skipped_paths = Vec::new();
    let mut failed_paths = Vec::new();
    for source in paths {
        let source_path = match fs::canonicalize(&source) {
            Ok(path) => path,
            Err(_) => {
                failed_paths.push(source);
                continue;
            }
        };
        let metadata = match fs::metadata(&source_path) {
            Ok(metadata)
                if metadata.is_file()
                    && is_supported_video_path(&source_path, &config.settings) =>
            {
                metadata
            }
            _ => {
                skipped_paths.push(path_string(&source_path));
                continue;
            }
        };
        if source_path.parent() == Some(destination.as_path()) {
            skipped_paths.push(path_string(&source_path));
            continue;
        }
        let target = match unique_copy_destination(&source_path, &destination) {
            Ok(target) => target,
            Err(_) => {
                failed_paths.push(path_string(&source_path));
                continue;
            }
        };
        let temporary = target.with_file_name(format!(
            ".{}.videosweeper-copy-{}.tmp",
            target
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("video"),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0),
        ));
        let temporary_name = temporary
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("videosweeper-copy.tmp");
        let target_name = target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("video");
        let copied = copy_path_with_shell(&source_path, &destination, temporary_name)
            .and_then(|_| fs::metadata(&temporary).map_err(|error| error.to_string()))
            .and_then(|temporary_metadata| {
                (temporary_metadata.len() == metadata.len())
                    .then_some(())
                    .ok_or_else(|| "The copied byte count does not match the source.".to_string())
            })
            .and_then(|_| rename_path_with_shell(&temporary, target_name));
        if copied.is_ok() {
            copied_paths.push(path_string(&target));
        } else {
            let _ = fs::remove_file(&temporary);
            failed_paths.push(path_string(&source_path));
        }
    }
    CopyResult {
        copied_paths,
        skipped_paths,
        failed_paths,
    }
}

#[cfg(target_os = "windows")]
fn recycle_path(path: &Path) -> Result<(), String> {
    unsafe {
        let operation: IFileOperation =
            CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER)
                .map_err(|error| format!("Unable to start the Recycle Bin operation: {error}"))?;
        operation
            .SetOperationFlags(FOFX_RECYCLEONDELETE | FOF_NOCONFIRMATION)
            .map_err(|error| format!("Unable to configure the Recycle Bin operation: {error}"))?;
        let item: IShellItem = SHCreateItemFromParsingName(&HSTRING::from(path_string(path)), None)
            .map_err(|error| format!("Unable to prepare the selected video: {error}"))?;
        operation
            .DeleteItem(&item, None)
            .map_err(|error| format!("Unable to queue the selected video for deletion: {error}"))?;
        operation.PerformOperations().map_err(|error| {
            format!("Unable to move the selected video to the Recycle Bin: {error}")
        })?;
        if operation
            .GetAnyOperationsAborted()
            .map_err(|error| format!("Unable to inspect the Recycle Bin operation: {error}"))?
            .as_bool()
        {
            return Err("The Recycle Bin operation was cancelled.".to_string());
        }
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn recycle_path(_path: &Path) -> Result<(), String> {
    Err("Moving files to the Recycle Bin is only supported on Windows.".to_string())
}

fn recycle_paths(paths: Vec<PathBuf>) -> RecycleResult {
    let mut recycled_paths = Vec::new();
    let mut failed_paths = Vec::new();
    for path in paths {
        match recycle_path(&path) {
            Ok(()) => recycled_paths.push(path_string(&path)),
            Err(_) => failed_paths.push(path_string(&path)),
        }
    }
    RecycleResult {
        recycled_paths,
        failed_paths,
    }
}

fn start_file_operation_queue() -> FileOperationQueue {
    let (sender, receiver) = mpsc::channel::<FileOperationTask>();
    thread::spawn(move || {
        #[cfg(target_os = "windows")]
        let com_initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok();

        while let Ok(task) = receiver.recv() {
            match task {
                FileOperationTask::Recycle { paths, response } => {
                    let _ = response.send(recycle_paths(paths));
                }
                FileOperationTask::Rename {
                    path,
                    new_stem,
                    response,
                } => {
                    let _ = response.send(rename_video_path(path, new_stem));
                }
                FileOperationTask::Copy {
                    paths,
                    destination,
                    response,
                } => {
                    let _ = response.send(copy_videos_to_directory(paths, destination));
                }
            }
        }

        #[cfg(target_os = "windows")]
        if com_initialized {
            unsafe { CoUninitialize() };
        }
    });
    FileOperationQueue(sender)
}

fn enqueue_recycle(
    paths: Vec<PathBuf>,
    queue: &FileOperationQueue,
) -> Result<RecycleResult, String> {
    let (response_sender, response_receiver) = mpsc::channel();
    queue
        .0
        .send(FileOperationTask::Recycle {
            paths,
            response: response_sender,
        })
        .map_err(|_| "The file operation queue is unavailable.".to_string())?;
    response_receiver
        .recv()
        .map_err(|_| "The file operation did not return a result.".to_string())
}

fn enqueue_rename(
    path: PathBuf,
    new_stem: String,
    queue: &FileOperationQueue,
) -> Result<RenameResult, String> {
    let (response_sender, response_receiver) = mpsc::channel();
    queue
        .0
        .send(FileOperationTask::Rename {
            path,
            new_stem,
            response: response_sender,
        })
        .map_err(|_| "The file operation queue is unavailable.".to_string())?;
    response_receiver
        .recv()
        .map_err(|_| "The file operation did not return a result.".to_string())?
}

fn enqueue_copy(
    paths: Vec<String>,
    destination: PathBuf,
    queue: &FileOperationQueue,
) -> Result<CopyResult, String> {
    let (response_sender, response_receiver) = mpsc::channel();
    queue
        .0
        .send(FileOperationTask::Copy {
            paths,
            destination,
            response: response_sender,
        })
        .map_err(|_| "The file operation queue is unavailable.".to_string())?;
    response_receiver
        .recv()
        .map_err(|_| "The file operation did not return a result.".to_string())
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
    video_stream_server: tauri::State<VideoStreamServer>,
) -> Result<String, String> {
    let video_path = resolve_stream_video_path(&path)?;
    let base_url = video_stream_server
        .base_url
        .as_ref()
        .ok_or_else(|| "The local video stream service is unavailable.".to_string())?;
    Ok(format!(
        "{base_url}?path={}",
        encode_query_component(&path_string(&video_path))
    ))
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
    let target = fs::canonicalize(path)
        .map_err(|error| format!("Unable to access the selected item: {error}"))?;
    let metadata = fs::metadata(&target)
        .map_err(|error| format!("Unable to inspect the selected item: {error}"))?;
    if metadata.is_dir() != is_directory {
        return Err("The selected item type has changed.".to_string());
    }
    let operation_paths = if is_directory {
        vec![target.clone()]
    } else {
        normalize_video_paths(paths.unwrap_or_else(|| vec![path_string(&target)]))?
    };

    let open = MenuItem::with_id(
        &window,
        "context-menu-open",
        if is_directory {
            "打开文件夹"
        } else {
            "打开"
        },
        true,
        None::<&str>,
    )
    .map_err(|error| format!("Unable to create the context menu: {error}"))?;
    let reveal = MenuItem::with_id(
        &window,
        "context-menu-reveal",
        "在资源管理器中显示",
        true,
        None::<&str>,
    )
    .map_err(|error| format!("Unable to create the context menu: {error}"))?;
    let menu = if is_directory {
        Menu::with_items(&window, &[&open, &reveal])
    } else {
        let delete = MenuItem::with_id(
            &window,
            "context-menu-delete",
            "移到回收站",
            true,
            None::<&str>,
        )
        .map_err(|error| format!("Unable to create the context menu: {error}"))?;
        Menu::with_items(&window, &[&open, &reveal, &delete])
    }
    .map_err(|error| format!("Unable to create the context menu: {error}"))?;

    // The menu event does not carry arbitrary payloads, so retain only the latest checked target.
    *state
        .0
        .lock()
        .map_err(|_| "Unable to access the context menu state.".to_string())? =
        Some(ContextMenuTarget {
            path: target,
            operation_paths,
            is_directory,
        });
    menu.popup_at(window.as_ref().window(), LogicalPosition::new(x, y))
        .map_err(|error| format!("Unable to show the context menu: {error}"))
}

fn open_context_target(target: &ContextMenuTarget) -> Result<(), String> {
    Command::new("explorer.exe")
        .arg(&target.path)
        .spawn()
        .map_err(|error| format!("Unable to open the selected item: {error}"))?;
    Ok(())
}

fn reveal_context_target(target: &ContextMenuTarget) -> Result<(), String> {
    if target.is_directory {
        return open_context_target(target);
    }

    Command::new("explorer.exe")
        .arg(format!("/select,{}", path_string(&target.path)))
        .spawn()
        .map_err(|error| format!("Unable to show the selected item: {error}"))?;
    Ok(())
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
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            // A second launch should surface the existing main window instead of opening another one.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .on_menu_event(|app, event| {
            let result = match event.id().as_ref() {
                "context-menu-open" | "context-menu-reveal" | "context-menu-delete" => {
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
            toggle_favorite,
            show_file_context_menu,
            generate_thumbnails,
            probe_video_metadata_batch_command,
            read_thumbnail,
            get_video_stream_url,
            open_video_externally,
            read_recent_logs,
            recycle_videos,
            rename_video,
            copy_videos_to_workspace
        ])
        .run(tauri::generate_context!())
        .expect("failed to run VideoSweeper");
}
