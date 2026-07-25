#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod application_commands;
mod config_store;
mod domain;
mod file_commands;
mod file_operations;
mod log_commands;
mod maintenance_commands;
mod media_commands;
mod media_processing;
mod media_stream;
mod models;
#[cfg(test)]
mod regression_tests;
mod runtime_api;
mod sidecar;
mod storage;
mod window_state;
mod windows_shell;
mod workspace;

use config_store::folder_name;
use media_processing::{
    generate_thumbnail_batch_impl, probe_video_metadata_batch, thumbnail_capture_cache_key,
    thumbnail_data_impl, MediaSidecarPermits, MediaSidecarPool, MetadataBatchResult,
};
use media_stream::{TranscodeController, VideoStreamServer};
use models::*;
use runtime_api::*;
use sidecar::{configure_sidecar_command, resolve_sidecar, wait_for_child};
use storage::*;
use workspace::{
    available_roots, is_recyclable_directory, list_directory_impl,
    list_folder_thumbnail_sources_impl, list_subdirectories_impl, DirectoryTreeWatchState,
    WorkspaceWatchState, WORKSPACE_SCAN_CANCELLED,
};

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
    collections::{HashMap, HashSet, VecDeque},
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
use tauri::{Emitter, Manager};
use tauri_plugin_log::{Target, TargetKind};
use tower::ServiceExt;
use tower_http::{cors::CorsLayer, services::ServeFile};
#[cfg(target_os = "windows")]
use windows::{
    core::{Interface, HRESULT, HSTRING, PCWSTR},
    Win32::{
        Foundation::{
            GlobalFree, DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, HGLOBAL,
            HWND, LPARAM, S_FALSE, S_OK, WPARAM,
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
                DoDragDrop, IDropSource, IDropSource_Impl, OleFlushClipboard, OleInitialize,
                OleSetClipboard, OleUninitialize, CF_HDROP, DROPEFFECT, DROPEFFECT_COPY,
                DROPEFFECT_MOVE,
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

fn main() {
    let configuration = config_store::ConfigStore::open(
        config_path().expect("failed to resolve FileSweeper configuration path"),
    )
    .expect("failed to initialize FileSweeper configuration");
    CONFIG_STORE
        .set(configuration)
        .unwrap_or_else(|_| panic!("FileSweeper configuration was initialized more than once"));
    let log_directory = log_dir().expect("failed to create FileSweeper log directory");
    let thumbnail_cache_directory =
        thumbnail_cache_dir().expect("failed to create FileSweeper thumbnail cache directory");
    let (loaded_thumbnail_index, media_cache_load_diagnostic) =
        load_thumbnail_index_with_diagnostic(&thumbnail_cache_directory);
    let thumbnail_index = Arc::new(Mutex::new(loaded_thumbnail_index));
    let thumbnail_cache_maintenance_lock = Arc::new(Mutex::new(()));
    let initial_config = load_config().expect("failed to load FileSweeper configuration");
    let cache_limit_bytes = thumbnail_cache_limit_bytes(initial_config.settings.thumbnail_cache_gb);
    let initial_cache_maintenance_error = maintain_thumbnail_cache(
        &thumbnail_cache_directory,
        &thumbnail_index,
        &thumbnail_cache_maintenance_lock,
        cache_limit_bytes,
    )
    .err();
    if let Some(error) = &initial_cache_maintenance_error {
        eprintln!("Unable to maintain the thumbnail cache: {error}");
    }
    let thumbnail_cache_directory_for_maintenance = thumbnail_cache_directory.clone();
    let transcode_controller = Arc::new(TranscodeController::new());
    let (video_stream_server, video_stream_start_error) =
        match media_stream::start_video_stream_server(Arc::clone(&transcode_controller)) {
            Ok(base_url) => (
                VideoStreamServer {
                    base_url: Some(base_url),
                    transcode_controller,
                },
                None,
            ),
            Err(error) => {
                eprintln!("Unable to start the local video stream server: {error}");
                (
                    VideoStreamServer {
                        base_url: None,
                        transcode_controller,
                    },
                    Some(error),
                )
            }
        };
    tauri::Builder::default()
        .manage(WorkspaceWatchState::new())
        .manage(DirectoryTreeWatchState::new())
        .manage(MediaSidecarPool(Arc::new(MediaSidecarPermits::new(
            initial_config.settings.background_sidecar_concurrency,
        ))))
        .manage(MediaCacheIndexState(Arc::clone(&thumbnail_index)))
        .manage(ThumbnailCacheDirectory(thumbnail_cache_directory))
        .manage(ThumbnailCacheMaintenanceState {
            index: thumbnail_index,
            directory: thumbnail_cache_directory_for_maintenance,
            lock: thumbnail_cache_maintenance_lock,
        })
        .manage(video_stream_server)
        .manage(file_operations::start_file_operation_queue())
        // Plugins are registered here so their native capabilities are available to the webview.
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .clear_targets()
                .level(log::LevelFilter::Debug)
                .max_file_size(1024 * 1024)
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::Folder {
                        path: log_directory,
                        file_name: Some("file-sweeper".to_string()),
                    }),
                ])
                .build(),
        )
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                window_state::restore_main_window(&window);
            }
            for (level, message) in config_store::take_startup_diagnostics() {
                log::log!(level, "Startup configuration diagnostic: {message}");
            }
            if let Some((level, message)) = &media_cache_load_diagnostic {
                log::log!(*level, "Startup media cache diagnostic: {message}");
            }
            if let Some(error) = &initial_cache_maintenance_error {
                log::error!("Initial media cache maintenance failed; startup continued with the existing cache: {error}");
            }
            if let Some(error) = &video_stream_start_error {
                log::error!("Local video stream server startup failed; embedded preview is unavailable until restart: {error}");
            }
            match load_config() {
                Ok(config) => log::info!(
                    "FileSweeper backend initialized: version={}, last_workspace={}, favorites={}, sidecar_concurrency={}",
                    env!("CARGO_PKG_VERSION"),
                    config.last_workspace.as_deref().unwrap_or("<none>"),
                    config.favorites.len(),
                    config.settings.background_sidecar_concurrency
                ),
                Err(error) => log::error!("Backend initialized but configuration snapshot logging failed: {error}"),
            }
            if app.state::<VideoStreamServer>().base_url.is_none() {
                log::error!("Local video stream server is unavailable; embedded preview will fail until restart");
            }
            Ok(())
        })
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            // A second launch should surface the existing main window instead of opening another one.
            log::info!("Second application launch detected; focusing the existing main window");
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = window.unminimize() {
                    log::warn!("Unable to restore the existing main window: {error}");
                }
                if let Err(error) = window.set_focus() {
                    log::warn!("Unable to focus the existing main window: {error}");
                }
            } else {
                log::error!("Second launch could not find the existing main window");
            }
        }))
        .on_window_event(|window, event| {
            if window.label() != "main"
                || !matches!(event, tauri::WindowEvent::CloseRequested { .. })
            {
                return;
            }
            log::info!("Main window close requested; stopping active preview processes");
            let server = window.state::<VideoStreamServer>();
            match server.transcode_controller.stop_all() {
                Ok(stopped) => log::info!("Preview shutdown completed: stopped_processes={stopped}"),
                Err(error) => log::warn!("Unable to stop all FFmpeg previews during shutdown: {error}"),
            }
            let queue = window.state::<FileOperationQueue>();
            if let Err(error) = file_operations::flush_file_clipboard(&queue) {
                log::warn!("Unable to persist the Explorer file clipboard during shutdown: {error}");
            }
        })
        .invoke_handler(tauri::generate_handler![
            application_commands::load_application_state,
            application_commands::is_running_as_administrator,
            application_commands::list_subdirectories,
            application_commands::set_directory_tree_watch_paths,
            application_commands::workspace_is_accessible,
            application_commands::list_directory,
            application_commands::list_folder_thumbnail_sources,
            application_commands::save_configuration,
            application_commands::set_audio_preferences,
            application_commands::set_list_columns,
            application_commands::set_last_workspace,
            application_commands::set_workspace_focus,
            application_commands::set_workspace_sort,
            application_commands::toggle_favorite,
            media_commands::generate_thumbnails,
            media_commands::generate_image_thumbnails,
            media_commands::generate_audio_thumbnails,
            media_commands::probe_video_metadata_batch_command,
            media_commands::read_thumbnail,
            media_commands::read_audio_embedded_cover,
            media_commands::read_text_preview,
            media_commands::inspect_image_preview,
            media_commands::get_preview_file_url,
            media_commands::get_audio_stream_url,
            media_commands::get_video_stream_url,
            media_commands::stop_transcoded_preview,
            file_commands::open_file_externally,
            file_commands::start_file_drag,
            log_commands::poll_log_file,
            file_commands::recycle_items,
            file_commands::recycle_directory,
            file_commands::rename_item,
            file_commands::start_file_task,
            file_commands::get_file_task,
            file_commands::cancel_file_task,
            file_commands::write_items_to_clipboard,
            file_commands::paste_files_from_clipboard,
            file_commands::reveal_path,
            maintenance_commands::get_data_management_summary,
            maintenance_commands::import_background_image,
            maintenance_commands::read_background_image,
            maintenance_commands::clear_thumbnail_cache,
            maintenance_commands::clear_old_logs,
            maintenance_commands::get_about_info,
            maintenance_commands::export_diagnostics,
            window_state::get_window_state,
            window_state::save_window_layout
        ])
        .run(tauri::generate_context!())
        .expect("failed to run FileSweeper");
}
