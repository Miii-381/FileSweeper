use super::*;

fn is_same_or_descendant(path: &str, directory: &Path) -> bool {
    let parent = path_string(directory)
        .trim_end_matches(&['\\', '/'][..])
        .to_ascii_lowercase();
    let candidate = path.trim_end_matches(&['\\', '/'][..]).to_ascii_lowercase();
    candidate == parent
        || candidate
            .strip_prefix(&parent)
            .is_some_and(|suffix| suffix.starts_with('\\') || suffix.starts_with('/'))
}

fn purge_deleted_directory_references(directory: &Path) -> Result<AppConfig, String> {
    let deleted_path = path_string(directory);
    update_config(|config| {
        config
            .favorites
            .retain(|favorite| !is_same_or_descendant(&favorite.path, directory));
        if config
            .last_workspace
            .as_deref()
            .is_some_and(|path| is_same_or_descendant(path, directory))
        {
            config.last_workspace = None;
        }
        Ok(())
    })?;
    update_workspace_state(|config| {
        config
            .workspace_focus
            .retain(|path, _| !is_same_or_descendant(path, directory));
        config
            .workspace_sort
            .retain(|path, _| !is_same_or_descendant(path, directory));
        Ok(())
    })
    .inspect(|_| log::info!("Removed persisted references for recycled directory: {deleted_path}"))
    .inspect_err(|error| {
        log::error!(
            "Unable to remove persisted references for recycled directory {deleted_path}: {error}"
        )
    })
}

#[tauri::command]
pub(super) fn recycle_videos(
    paths: Vec<String>,
    focused_video_path: Option<String>,
    queue: tauri::State<FileOperationQueue>,
    video_stream_server: tauri::State<VideoStreamServer>,
) -> Result<RecycleResult, String> {
    log::info!("Recycling {} video(s)", paths.len());
    let normalized_paths = file_operations::normalize_video_paths(paths).map_err(|error| {
        log::warn!("Recycle request rejected during path validation: {error}");
        error
    })?;
    if let Some(focused_video_path) = focused_video_path {
        let focused_path = fs::canonicalize(focused_video_path).map_err(|error| {
            format!("Unable to access the focused video before deletion: {error}")
        })?;
        if normalized_paths.iter().any(|path| path == &focused_path) {
            let stopped = video_stream_server
                .transcode_controller
                .stop_video(&focused_path)
                .map_err(|error| {
                    log::error!(
                        "Unable to stop focused preview before recycling {}: {error}",
                        path_string(&focused_path)
                    );
                    error
                })?;
            if stopped {
                log::info!(
                    "Stopped the focused FFmpeg preview before recycling: {}",
                    path_string(&focused_path)
                );
            }
        }
    }
    file_operations::enqueue_recycle(normalized_paths, &queue)
        .inspect(|result| {
            log::info!(
                "Recycle request completed: recycled={}, failed={}",
                result.recycled_paths.len(),
                result.failed_paths.len()
            );
        })
        .inspect_err(|error| log::error!("Recycle request failed: {error}"))
}

#[tauri::command]
pub(super) fn recycle_directory(
    path: String,
    queue: tauri::State<FileOperationQueue>,
) -> Result<DirectoryRecycleResult, String> {
    log::info!("Recycling directory: requested_path={path}");
    let directory = fs::canonicalize(&path)
        .map_err(|error| format!("Unable to access the selected folder: {error}"))?;
    if !directory.is_dir() {
        return Err("Only folders can be moved to the Recycle Bin.".to_string());
    }
    if !is_recyclable_directory(&directory) {
        return Err("Disk roots cannot be moved to the Recycle Bin.".to_string());
    }
    let normalized = path_string(&directory);
    let result = file_operations::enqueue_recycle(vec![directory.clone()], &queue)?;
    if !result
        .recycled_paths
        .iter()
        .any(|recycled| recycled.eq_ignore_ascii_case(&normalized))
    {
        return Err("Unable to move the selected folder to the Recycle Bin.".to_string());
    }
    let config = match purge_deleted_directory_references(&directory) {
        Ok(config) => config,
        Err(error) => {
            // The Shell operation has already succeeded. Return the confirmed filesystem result
            // so the UI can discard stale paths even if persistence needs later recovery.
            log::error!(
                "Directory was recycled but persisted reference cleanup failed: path={normalized}, error={error}"
            );
            load_config()?
        }
    };
    log::info!("Directory moved to Recycle Bin: path={normalized}");
    Ok(DirectoryRecycleResult {
        recycled_path: normalized,
        config,
    })
}

#[tauri::command]
pub(super) fn rename_video(
    path: String,
    new_stem: String,
    queue: tauri::State<FileOperationQueue>,
) -> Result<RenameResult, String> {
    log::info!("Renaming video: path={path}, requested_stem={new_stem}");
    let paths = file_operations::normalize_video_paths(vec![path]).map_err(|error| {
        log::warn!("Rename request rejected during path validation: {error}");
        error
    })?;
    file_operations::enqueue_rename(
        paths.into_iter().next().expect("one normalized video path"),
        new_stem,
        &queue,
    )
    .inspect(|result| {
        log::info!(
            "Video renamed: old_path={}, new_path={}, name={}",
            result.old_path,
            result.new_path,
            result.name
        );
    })
    .inspect_err(|error| log::error!("Video rename failed: {error}"))
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
pub(super) fn start_file_task(
    paths: Vec<String>,
    destination_path: String,
    operation: FileTaskOperation,
    app_handle: tauri::AppHandle,
    queue: tauri::State<FileOperationQueue>,
) -> Result<FileTaskSnapshot, String> {
    log::info!(
        "Received file task request: operation={operation:?}, items={}, destination={destination_path}",
        paths.len()
    );
    let destination = normalize_transfer_destination(destination_path).map_err(|error| {
        log::warn!("File task destination rejected: {error}");
        error
    })?;
    file_operations::start_transfer_task(paths, destination, operation, app_handle, &queue)
        .inspect(|snapshot| log::info!("File task accepted: task_id={}", snapshot.id))
        .inspect_err(|error| log::error!("Unable to start file task: {error}"))
}

#[tauri::command]
pub(super) fn get_file_task(
    task_id: u64,
    queue: tauri::State<FileOperationQueue>,
) -> Result<FileTaskSnapshot, String> {
    // This is a state query and may be polled; only failures are logged to avoid obscuring task transitions.
    file_operations::get_file_task(task_id, &queue).inspect_err(|error| {
        log::warn!("Unable to query file task: task_id={task_id}, error={error}")
    })
}

#[tauri::command]
pub(super) fn cancel_file_task(
    task_id: u64,
    queue: tauri::State<FileOperationQueue>,
) -> Result<bool, String> {
    log::info!("Received file task cancellation request: task_id={task_id}");
    file_operations::cancel_file_task(task_id, &queue)
        .inspect(|accepted| {
            log::info!("File task cancellation processed: task_id={task_id}, accepted={accepted}");
        })
        .inspect_err(|error| {
            log::error!("File task cancellation failed: task_id={task_id}, error={error}")
        })
}

#[tauri::command]
pub(super) fn write_files_to_clipboard(
    paths: Vec<String>,
    operation: FileTaskOperation,
    window: tauri::WebviewWindow,
    queue: tauri::State<FileOperationQueue>,
) -> Result<(), String> {
    log::info!(
        "Received file clipboard write request: operation={operation:?}, requested_paths={}",
        paths.len()
    );
    let paths = file_operations::normalize_video_paths(paths).map_err(|error| {
        log::warn!("File clipboard write rejected during path validation: {error}");
        error
    })?;
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
        .inspect(|_| log::info!("File clipboard write request completed: operation={operation:?}"))
        .inspect_err(|error| {
            log::error!(
                "File clipboard write request failed: operation={operation:?}, error={error}"
            )
        })
}

#[tauri::command]
pub(super) fn paste_files_from_clipboard(
    destination_path: String,
    app_handle: tauri::AppHandle,
    queue: tauri::State<FileOperationQueue>,
) -> Result<FileTaskSnapshot, String> {
    log::info!("Received file clipboard paste request: destination={destination_path}");
    let destination = normalize_transfer_destination(destination_path).map_err(|error| {
        log::warn!("Clipboard paste destination rejected: {error}");
        error
    })?;
    let clipboard = file_operations::enqueue_read_clipboard(&queue).map_err(|error| {
        log::error!("Unable to read system file clipboard for paste: {error}");
        error
    })?;
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
    .inspect(|snapshot| log::info!("Clipboard paste task accepted: task_id={}", snapshot.id))
    .inspect_err(|error| log::error!("Unable to create clipboard paste task: {error}"))
}

#[tauri::command]
pub(super) fn open_video_externally(path: String) -> Result<(), String> {
    log::info!("Opening video with the system default application: requested_path={path}");
    let video_path = media_stream::resolve_stream_video_path(&path).map_err(|error| {
        log::warn!("External video open rejected: path={path}, error={error}");
        error
    })?;
    let normalized = path_string(&video_path);
    Command::new("explorer.exe")
        .arg(&video_path)
        .spawn()
        .map_err(|error| {
            log::error!("Unable to launch system default video application: path={normalized}, error={error}");
            format!("Unable to open the selected video externally: {error}")
        })?;
    log::info!("Video handed to system default application: path={normalized}");
    Ok(())
}

#[tauri::command]
pub(super) fn reveal_path(path: String) -> Result<(), String> {
    log::info!("Revealing path in Explorer: requested_path={path}");
    let target = fs::canonicalize(path).map_err(|error| {
        log::warn!("Explorer reveal path could not be resolved: {error}");
        format!("Unable to access the selected path: {error}")
    })?;
    let metadata = fs::metadata(&target)
        .map_err(|error| format!("Unable to inspect the selected path: {error}"))?;
    let mut explorer = Command::new("explorer.exe");
    if metadata.is_dir() {
        explorer.arg(&target);
    } else {
        return windows_shell::reveal_windows_path(&target)
            .inspect(|_| log::info!("File revealed in Explorer: path={}", path_string(&target)))
            .inspect_err(|error| {
                log::error!(
                    "Unable to reveal file in Explorer: path={}, error={error}",
                    path_string(&target)
                )
            });
    }
    explorer.spawn().map_err(|error| {
        log::error!(
            "Unable to open directory in Explorer: path={}, error={error}",
            path_string(&target)
        );
        format!("Unable to show the selected path in Explorer: {error}")
    })?;
    log::info!(
        "Directory opened in Explorer: path={}",
        path_string(&target)
    );
    Ok(())
}

#[tauri::command]
pub(super) fn start_file_drag(paths: Vec<String>) -> Result<(), String> {
    let requested = paths.len();
    log::info!("Received file-drag request: requested_paths={requested}");
    let paths = file_operations::normalize_video_paths(paths).map_err(|error| {
        log::warn!("File-drag request rejected during path validation: {error}");
        error
    })?;
    log::debug!("Received file-drag command for {} video(s)", paths.len());
    windows_shell::start_windows_file_drag(paths)
        .inspect(|_| log::info!("File-drag session completed: paths={requested}"))
        .inspect_err(|error| {
            log::error!("File-drag session failed: paths={requested}, error={error}")
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_reference_cleanup_matches_only_whole_path_segments() {
        let deleted = Path::new(r"C:\\Videos\\Archive");
        assert!(is_same_or_descendant(r"C:\\Videos\\Archive", deleted));
        assert!(is_same_or_descendant(
            r"c:\\videos\\archive\\nested",
            deleted
        ));
        assert!(!is_same_or_descendant(r"C:\\Videos\\Archived", deleted));
        assert!(!is_same_or_descendant(r"C:\\Videos", deleted));
    }
}
