use super::*;

fn is_same_or_descendant_path(path: &Path, parent: &Path) -> bool {
    let parent = path_string(parent)
        .trim_end_matches(&['\\', '/'][..])
        .to_ascii_lowercase();
    let path = path_string(path)
        .trim_end_matches(&['\\', '/'][..])
        .to_ascii_lowercase();
    path == parent
        || path
            .strip_prefix(&parent)
            .is_some_and(|suffix| suffix.starts_with('\\') || suffix.starts_with('/'))
}

pub(super) fn normalize_item_paths(paths: Vec<String>) -> Result<Vec<PathBuf>, String> {
    let requested = paths.len();
    let mut seen_paths = HashSet::new();
    let mut normalized_paths = Vec::new();

    for path in paths {
        let normalized = fs::canonicalize(path)
            .map_err(|error| format!("Unable to access the selected item: {error}"))?;
        let metadata = fs::metadata(&normalized)
            .map_err(|error| format!("Unable to inspect the selected item: {error}"))?;
        if !metadata.is_file() && !metadata.is_dir() {
            return Err("Only files and folders can be selected.".to_string());
        }
        let normalized_text = path_string(&normalized);
        if seen_paths.insert(normalized_text.to_ascii_lowercase()) {
            log::debug!("Item path accepted during normalization: {normalized_text}");
            normalized_paths.push(normalized);
        } else {
            log::debug!("Duplicate item path removed during normalization: {normalized_text}");
        }
    }

    if normalized_paths.is_empty() {
        log::warn!("Item path normalization produced no usable items: requested={requested}");
        return Err("Select at least one file or folder.".to_string());
    }
    let candidates = normalized_paths.clone();
    let before_descendant_filter = normalized_paths.len();
    normalized_paths.retain(|path| {
        !candidates
            .iter()
            .any(|other| other != path && other.is_dir() && is_same_or_descendant_path(path, other))
    });
    log::debug!(
        "Item paths normalized: requested={requested}, accepted={}, descendants_removed={}",
        normalized_paths.len(),
        before_descendant_filter.saturating_sub(normalized_paths.len())
    );
    Ok(normalized_paths)
}

fn validate_file_stem(new_stem: &str) -> Result<String, String> {
    domain::validate_windows_file_stem(new_stem)
}

#[cfg(target_os = "windows")]
fn shell_item(path: &Path) -> Result<IShellItem, String> {
    unsafe {
        SHCreateItemFromParsingName(&HSTRING::from(path_string(path)), None)
            .map_err(|error| format!("Unable to prepare the selected file: {error}"))
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
        log::debug!(
            "Starting Shell rename: source={}, destination_name={new_name}",
            path_string(path)
        );
        let operation = shell_file_operation()?;
        let item = shell_item(path)?;
        let name = HSTRING::from(new_name);
        operation
            .RenameItem(&item, PCWSTR(name.as_ptr()), None)
            .map_err(|error| format!("Unable to queue the file rename: {error}"))?;
        operation
            .PerformOperations()
            .map_err(|error| format!("Unable to rename the selected file: {error}"))?;
        ensure_shell_operation_completed(&operation)?;
        log::debug!("Shell rename completed: source={}", path_string(path));
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
fn rename_path_with_shell(path: &Path, new_name: &str) -> Result<(), String> {
    fs::rename(path, path.with_file_name(new_name))
        .map_err(|error| format!("Unable to rename the selected file: {error}"))
}

#[cfg(target_os = "windows")]
fn copy_path_with_shell(
    source: &Path,
    destination_directory: &Path,
    destination_name: &str,
) -> Result<(), String> {
    unsafe {
        log::debug!(
            "Starting Shell copy: source={}, destination_directory={}, destination_name={destination_name}",
            path_string(source),
            path_string(destination_directory)
        );
        let operation = shell_file_operation()?;
        let source_item = shell_item(source)?;
        let destination_item = shell_item(destination_directory)?;
        let name = HSTRING::from(destination_name);
        operation
            .CopyItem(&source_item, &destination_item, PCWSTR(name.as_ptr()), None)
            .map_err(|error| format!("Unable to queue the file copy: {error}"))?;
        operation
            .PerformOperations()
            .map_err(|error| format!("Unable to copy the selected file: {error}"))?;
        ensure_shell_operation_completed(&operation)?;
        log::debug!(
            "Shell copy completed: source={}, destination_directory={}, destination_name={destination_name}",
            path_string(source),
            path_string(destination_directory)
        );
        Ok(())
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
        .map_err(|error| format!("Unable to copy the selected file: {error}"))
}

fn rename_item_path(path: PathBuf, new_stem: String) -> Result<RenameResult, String> {
    let stem = validate_file_stem(&new_stem)?;
    let extension = if path.is_file() {
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| format!(".{extension}"))
            .unwrap_or_default()
    } else {
        String::new()
    };
    let new_name = format!("{stem}{extension}");
    let destination = path.with_file_name(&new_name);
    if destination != path && destination.exists() {
        return Err("An item with the new name already exists in this folder.".to_string());
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
        log::debug!(
            "File task destination is available without renaming: {}",
            path_string(&first)
        );
        return Ok(first);
    }
    log::debug!(
        "File task destination conflicts with an existing path; selecting an incremented name: {}",
        path_string(&first)
    );
    for index in 1..10_000 {
        let candidate = destination_directory.join(format!("{stem} ({index}){extension}"));
        if !candidate.exists() {
            log::debug!(
                "File task selected conflict-free destination name at index {index}: {}",
                path_string(&candidate)
            );
            return Ok(candidate);
        }
    }
    Err("Unable to find an available destination file name.".to_string())
}

#[cfg(target_os = "windows")]
fn delete_path_with_shell(path: &Path) -> Result<(), String> {
    unsafe {
        log::debug!("Starting permanent Shell delete: {}", path_string(path));
        let operation = shell_file_operation()?;
        let item = shell_item(path)?;
        operation
            .DeleteItem(&item, None)
            .map_err(|error| format!("Unable to queue the source file removal: {error}"))?;
        operation.PerformOperations().map_err(|error| {
            format!("Unable to remove the source file after moving it: {error}")
        })?;
        ensure_shell_operation_completed(&operation)?;
        log::debug!("Permanent Shell delete completed: {}", path_string(path));
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn commit_temporary_copy(temporary: &Path, target: &Path) -> Result<(), String> {
    let source = temporary
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(destination.as_ptr()),
            MOVEFILE_WRITE_THROUGH,
        )
        .map_err(|error| format!("Unable to commit the copied file without overwriting: {error}"))
    }
}

#[cfg(not(target_os = "windows"))]
fn commit_temporary_copy(temporary: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        return Err("The destination name became occupied during the copy.".to_string());
    }
    fs::rename(temporary, target)
        .map_err(|error| format!("Unable to commit the copied file: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn delete_path_with_shell(path: &Path) -> Result<(), String> {
    fs::remove_file(path).map_err(|error| format!("Unable to remove the source file: {error}"))
}

fn copy_one_to_directory(
    source_path: &Path,
    destination: &Path,
    source_size: u64,
) -> Result<PathBuf, String> {
    let target = unique_copy_destination(source_path, destination)?;
    if source_path.is_dir() {
        let target_name = target
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "Unable to determine the destination folder name.".to_string())?;
        copy_path_with_shell(source_path, destination, target_name)?;
        return target
            .exists()
            .then_some(target)
            .ok_or_else(|| "The copied folder was not created.".to_string());
    }
    let temporary = target.with_file_name(format!(
        ".{}.filesweeper-copy-{}.tmp",
        target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("file"),
        current_unix_millis(),
    ));
    let temporary_name = temporary
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Unable to create a temporary destination name.".to_string())?;
    log::debug!(
        "File task copy stage prepared: source={}, temporary={}, target={}, expected_bytes={source_size}",
        path_string(source_path),
        path_string(&temporary),
        path_string(&target)
    );
    let result = copy_path_with_shell(source_path, destination, temporary_name)
        .and_then(|_| {
            log::debug!(
                "Shell copy returned successfully; verifying temporary file: {}",
                path_string(&temporary)
            );
            fs::metadata(&temporary).map_err(|error| error.to_string())
        })
        .and_then(|temporary_metadata| {
            log::debug!(
                "Temporary copy size verification: path={}, actual_bytes={}, expected_bytes={source_size}",
                path_string(&temporary),
                temporary_metadata.len()
            );
            (temporary_metadata.len() == source_size)
                .then_some(())
                .ok_or_else(|| "The copied byte count does not match the source.".to_string())
        })
        .and_then(|_| {
            log::debug!(
                "Committing verified temporary copy without replacement: {} -> {}",
                path_string(&temporary),
                path_string(&target)
            );
            commit_temporary_copy(&temporary, &target)
        });
    if let Err(error) = result {
        log::warn!(
            "File task copy stage failed; cleaning temporary file: source={}, temporary={}, target={}, error={error}",
            path_string(source_path),
            path_string(&temporary),
            path_string(&target)
        );
        if let Err(cleanup_error) = fs::remove_file(&temporary) {
            if temporary.exists() {
                log::error!(
                    "File task copy failed and temporary cleanup also failed: temporary={}, error={cleanup_error}",
                    path_string(&temporary)
                );
            }
        }
        return Err(error);
    }
    log::debug!(
        "File task copy stage committed successfully: {}",
        path_string(&target)
    );
    Ok(target)
}

fn should_skip_same_directory_transfer(
    source: &Path,
    destination: &Path,
    operation: FileTaskOperation,
) -> bool {
    operation == FileTaskOperation::Move && source.parent() == Some(destination)
}

fn transfer_one(
    source: String,
    destination: &Path,
    operation: FileTaskOperation,
) -> FileTaskItemResult {
    log::debug!(
        "File task item validation started: operation={operation:?}, source={source}, destination={}",
        path_string(destination)
    );
    let source_path = match fs::canonicalize(&source) {
        Ok(path) => path,
        Err(error) => {
            log::warn!("File task item source resolution failed: source={source}, error={error}");
            return FileTaskItemResult {
                source_path: source,
                destination_path: None,
                status: FileTaskItemStatus::Failed,
                error: Some(format!("Unable to access the source file: {error}")),
            };
        }
    };
    let normalized_source = path_string(&source_path);
    let metadata = match fs::metadata(&source_path) {
        Ok(metadata) if metadata.is_file() || metadata.is_dir() => metadata,
        Ok(_) => {
            log::warn!("File task item skipped because it is not a regular file or folder: {normalized_source}");
            return FileTaskItemResult {
                source_path: normalized_source,
                destination_path: None,
                status: FileTaskItemStatus::Skipped,
                error: Some("The source is not a regular file or folder.".to_string()),
            };
        }
        Err(error) => {
            log::warn!(
                "File task item metadata read failed: source={normalized_source}, error={error}"
            );
            return FileTaskItemResult {
                source_path: normalized_source,
                destination_path: None,
                status: FileTaskItemStatus::Failed,
                error: Some(format!("Unable to inspect the source file: {error}")),
            };
        }
    };
    if should_skip_same_directory_transfer(&source_path, destination, operation) {
        log::debug!(
            "Move task item skipped because source already belongs to destination: {}",
            normalized_source
        );
        return FileTaskItemResult {
            source_path: normalized_source,
            destination_path: Some(path_string(&source_path)),
            status: FileTaskItemStatus::Skipped,
            error: Some("The source is already in the destination folder.".to_string()),
        };
    }
    if source_path.is_dir() && is_same_or_descendant_path(destination, &source_path) {
        log::warn!(
            "File task item rejected because destination is inside source directory: source={}, destination={}",
            normalized_source,
            path_string(destination)
        );
        return FileTaskItemResult {
            source_path: normalized_source,
            destination_path: None,
            status: FileTaskItemStatus::Failed,
            error: Some(
                "A folder cannot be copied or moved into itself or one of its subfolders."
                    .to_string(),
            ),
        };
    }

    match copy_one_to_directory(&source_path, destination, metadata.len()) {
        Ok(target) if operation == FileTaskOperation::Copy => FileTaskItemResult {
            source_path: normalized_source,
            destination_path: Some(path_string(&target)),
            status: FileTaskItemStatus::Completed,
            error: None,
        },
        Ok(target) => match delete_path_with_shell(&source_path) {
            Ok(()) => FileTaskItemResult {
                source_path: normalized_source,
                destination_path: Some(path_string(&target)),
                status: FileTaskItemStatus::Completed,
                error: None,
            },
            Err(error) => {
                log::warn!(
                    "Move source deletion failed; rolling back committed target: source={}, target={}, error={error}",
                    path_string(&source_path),
                    path_string(&target)
                );
                let rollback_error = delete_path_with_shell(&target).err();
                FileTaskItemResult {
                    source_path: normalized_source,
                    destination_path: rollback_error.as_ref().map(|_| path_string(&target)),
                    status: FileTaskItemStatus::Failed,
                    error: Some(match rollback_error {
                        Some(rollback) => {
                            format!("{error}; the destination rollback also failed: {rollback}")
                        }
                        None => error,
                    }),
                }
            }
        },
        Err(error) => FileTaskItemResult {
            source_path: normalized_source,
            destination_path: None,
            status: FileTaskItemStatus::Failed,
            error: Some(error),
        },
    }
}

fn emit_task_snapshot(control: &FileTaskControl, app_handle: &tauri::AppHandle) {
    match control.snapshot.lock().map(|snapshot| snapshot.clone()) {
        Ok(snapshot) => {
            log::debug!(
                "Emitting file task progress: task_id={}, state={:?}, completed={}/{}, results={}",
                snapshot.id,
                snapshot.state,
                snapshot.completed_items,
                snapshot.total_items,
                snapshot.results.len()
            );
            if let Err(error) = app_handle.emit("file-task-progress", &snapshot) {
                log::warn!(
                    "File task state changed but UI event delivery failed: task_id={}, state={:?}, error={error}",
                    snapshot.id,
                    snapshot.state
                );
            }
        }
        Err(_) => log::error!("Unable to read file task state for UI event delivery"),
    }
}

fn run_transfer_task(
    control: FileTaskControl,
    paths: Vec<String>,
    destination: PathBuf,
    operation: FileTaskOperation,
    app_handle: tauri::AppHandle,
) {
    let task_id = match control.snapshot.lock() {
        Ok(snapshot) => snapshot.id,
        Err(_) => {
            log::error!("Unable to read file task id before execution; using diagnostic id zero");
            0
        }
    };
    log::info!(
        "File task #{task_id} started on STA queue: operation={operation:?}, items={}, destination={}",
        paths.len(),
        path_string(&destination)
    );
    if let Ok(mut snapshot) = control.snapshot.lock() {
        snapshot.state = FileTaskState::Running;
    } else {
        log::error!("Unable to mark file task #{task_id} as running");
    }
    emit_task_snapshot(&control, &app_handle);

    for (index, source) in paths.iter().cloned().enumerate() {
        if control.cancel.load(Ordering::Acquire) {
            log::info!(
                "File task #{task_id} cancellation observed before item {}/{}; marking {} unstarted item(s) cancelled",
                index + 1,
                paths.len(),
                paths.len() - index
            );
            if let Ok(mut snapshot) = control.snapshot.lock() {
                for cancelled_source in paths[index..].iter().cloned() {
                    snapshot.results.push(FileTaskItemResult {
                        source_path: cancelled_source,
                        destination_path: None,
                        status: FileTaskItemStatus::Cancelled,
                        error: None,
                    });
                    snapshot.completed_items += 1;
                }
                snapshot.state = FileTaskState::Cancelled;
            } else {
                log::error!("Unable to mark remaining items cancelled for file task #{task_id}");
            }
            emit_task_snapshot(&control, &app_handle);
            return;
        }

        let result = transfer_one(source, &destination, operation);
        log::log!(
            if result.status == FileTaskItemStatus::Failed {
                log::Level::Warn
            } else {
                log::Level::Debug
            },
            "File task #{task_id} item {}/{} finished: status={:?}, source={}, destination={}, error={}",
            index + 1,
            paths.len(),
            result.status,
            result.source_path,
            result.destination_path.as_deref().unwrap_or("-"),
            result.error.as_deref().unwrap_or("-")
        );
        if let Ok(mut snapshot) = control.snapshot.lock() {
            snapshot.results.push(result);
            snapshot.completed_items += 1;
        } else {
            log::error!(
                "File task item completed but its result could not be recorded: task_id={task_id}, item={}/{}",
                index + 1,
                paths.len()
            );
        }
        emit_task_snapshot(&control, &app_handle);
    }

    if let Ok(mut snapshot) = control.snapshot.lock() {
        snapshot.state = if control.cancel.load(Ordering::Acquire) {
            FileTaskState::Cancelled
        } else {
            FileTaskState::Completed
        };
    } else {
        log::error!("Unable to set terminal state for file task #{task_id}");
    }
    if let Ok(snapshot) = control.snapshot.lock() {
        let succeeded = snapshot
            .results
            .iter()
            .filter(|result| result.status == FileTaskItemStatus::Completed)
            .count();
        let skipped = snapshot
            .results
            .iter()
            .filter(|result| result.status == FileTaskItemStatus::Skipped)
            .count();
        let failed = snapshot
            .results
            .iter()
            .filter(|result| result.status == FileTaskItemStatus::Failed)
            .count();
        log::info!(
            "File task #{task_id} reached terminal state {:?}: succeeded={succeeded}, skipped={skipped}, failed={failed}, total={}",
            snapshot.state,
            snapshot.total_items
        );
    } else {
        log::error!("Unable to summarize terminal results for file task #{task_id}");
    }
    emit_task_snapshot(&control, &app_handle);
}

#[cfg(target_os = "windows")]
fn open_clipboard_with_retry(owner: Option<isize>) -> Result<(), String> {
    let mut last_error = None;
    for attempt in 1..=8 {
        let owner_window = owner.map(|handle| HWND(handle as *mut std::ffi::c_void));
        match unsafe { OpenClipboard(owner_window) } {
            Ok(()) => {
                log::debug!(
                    "Windows clipboard opened on attempt {attempt}: requested_owner=0x{:X}, sequence={}",
                    owner.unwrap_or_default(),
                    unsafe { GetClipboardSequenceNumber() }
                );
                return Ok(());
            }
            Err(error) => {
                log::debug!(
                    "Windows clipboard open attempt {attempt}/8 failed: requested_owner=0x{:X}, error={error}",
                    owner.unwrap_or_default()
                );
                last_error = Some(error);
                thread::sleep(Duration::from_millis(15));
            }
        }
    }
    Err(format!(
        "Unable to open the Windows clipboard: {}",
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "unknown error".to_string())
    ))
}

#[cfg(target_os = "windows")]
fn write_file_clipboard(
    paths: &[PathBuf],
    operation: FileTaskOperation,
    owner: Option<isize>,
) -> Result<(), String> {
    if paths.is_empty() {
        return Err("Select at least one file to copy or cut.".to_string());
    }
    let drop_effect = match operation {
        FileTaskOperation::Copy => DROPEFFECT_COPY.0,
        FileTaskOperation::Move => DROPEFFECT_MOVE.0,
    };
    log::info!(
        "Writing Explorer-compatible file clipboard: operation={operation:?}, files={}, requested_owner=0x{:X}, preferred_effect=0x{drop_effect:X}",
        paths.len(),
        owner.unwrap_or_default()
    );
    for (index, path) in paths.iter().enumerate() {
        log::debug!(
            "Windows file clipboard source {}/{}: {}",
            index + 1,
            paths.len(),
            path_string(path)
        );
    }
    let result = windows_shell::write_windows_file_clipboard(paths, drop_effect, owner);
    match &result {
        Ok(()) => log::info!(
            "Explorer-compatible live file clipboard published: operation={operation:?}, files={}, sequence={}",
            paths.len(),
            unsafe { GetClipboardSequenceNumber() }
        ),
        Err(error) => log::error!(
            "Explorer-compatible file clipboard write failed: operation={operation:?}, files={}, requested_owner=0x{:X}, error={error}",
            paths.len(),
            owner.unwrap_or_default()
        ),
    }
    result
}

#[cfg(not(target_os = "windows"))]
fn write_file_clipboard(
    _paths: &[PathBuf],
    _operation: FileTaskOperation,
    _owner: Option<isize>,
) -> Result<(), String> {
    Err("The system file clipboard is currently available only on Windows.".to_string())
}

#[cfg(target_os = "windows")]
fn read_file_clipboard() -> Result<ClipboardFiles, String> {
    log::info!(
        "Reading Windows file clipboard: sequence={}, CF_HDROP_format={}",
        unsafe { GetClipboardSequenceNumber() },
        CF_HDROP.0
    );
    unsafe {
        IsClipboardFormatAvailable(CF_HDROP.0 as u32)
            .map_err(|_| "The clipboard does not contain files.".to_string())?;
    }
    open_clipboard_with_retry(None)?;
    let result = (|| unsafe {
        let clipboard_handle = GetClipboardData(CF_HDROP.0 as u32)
            .map_err(|error| format!("Unable to read files from the Windows clipboard: {error}"))?;
        let drop_handle = HDROP(clipboard_handle.0);
        let count = DragQueryFileW(drop_handle, u32::MAX, None);
        log::debug!("Windows clipboard CF_HDROP reports {count} path(s)");
        if count == 0 {
            return Err("The clipboard does not contain any file paths.".to_string());
        }
        let mut paths = Vec::with_capacity(count as usize);
        for index in 0..count {
            let length = DragQueryFileW(drop_handle, index, None);
            let mut buffer = vec![0_u16; length as usize + 1];
            let copied = DragQueryFileW(drop_handle, index, Some(&mut buffer));
            if copied == 0 {
                log::warn!(
                    "Windows clipboard path could not be decoded; skipping item: index={index}"
                );
                continue;
            }
            paths.push(String::from_utf16_lossy(&buffer[..copied as usize]));
        }
        if paths.is_empty() {
            return Err("The clipboard file paths could not be read.".to_string());
        }

        let format_name = HSTRING::from("Preferred DropEffect");
        let preferred_effect_format = RegisterClipboardFormatW(PCWSTR(format_name.as_ptr()));
        let operation = if preferred_effect_format == 0 {
            log::warn!(
                "Unable to register the Preferred DropEffect clipboard format; falling back to copy"
            );
            FileTaskOperation::Copy
        } else if IsClipboardFormatAvailable(preferred_effect_format).is_ok() {
            let preferred_effect = GetClipboardData(preferred_effect_format)
                .inspect_err(|error| {
                    log::warn!(
                        "Unable to read Preferred DropEffect from the clipboard; falling back to copy: {error}"
                    );
                })
                .ok()
                .and_then(|handle| {
                    let memory = HGLOBAL(handle.0);
                    (GlobalSize(memory) >= std::mem::size_of::<u32>()).then(|| {
                        let pointer = GlobalLock(memory);
                        if pointer.is_null() {
                            return None;
                        }
                        let effect = std::ptr::read_unaligned(pointer.cast::<u32>());
                        let _ = GlobalUnlock(memory);
                        Some(effect)
                    })
                })
                .flatten();
            match preferred_effect {
                Some(effect) if effect & DROPEFFECT_MOVE.0 != 0 => FileTaskOperation::Move,
                Some(_) => FileTaskOperation::Copy,
                None => {
                    log::warn!(
                        "Preferred DropEffect was advertised but could not be read; falling back to copy"
                    );
                    FileTaskOperation::Copy
                }
            }
        } else {
            log::info!("File clipboard has no Preferred DropEffect; falling back to copy");
            FileTaskOperation::Copy
        };
        log::info!(
            "Windows file clipboard read completed: operation={operation:?}, files={}, preferred_effect_format={preferred_effect_format}",
            paths.len()
        );
        for (index, path) in paths.iter().enumerate() {
            log::debug!(
                "Windows file clipboard path {}/{}: {path}",
                index + 1,
                paths.len()
            );
        }
        Ok(ClipboardFiles { paths, operation })
    })();
    if let Err(error) = unsafe { CloseClipboard() } {
        log::warn!("Unable to close the Windows clipboard after reading: {error}");
    }
    if let Err(error) = &result {
        log::error!("Windows file clipboard read failed: error={error}");
    }
    result
}

#[cfg(not(target_os = "windows"))]
fn read_file_clipboard() -> Result<ClipboardFiles, String> {
    Err("The system file clipboard is currently available only on Windows.".to_string())
}

#[cfg(target_os = "windows")]
pub(super) fn recycle_path(path: &Path) -> Result<(), String> {
    unsafe {
        let operation: IFileOperation =
            CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER)
                .map_err(|error| format!("Unable to start the Recycle Bin operation: {error}"))?;
        operation
            .SetOperationFlags(FOFX_RECYCLEONDELETE | FOF_NOCONFIRMATION)
            .map_err(|error| format!("Unable to configure the Recycle Bin operation: {error}"))?;
        let item: IShellItem = SHCreateItemFromParsingName(&HSTRING::from(path_string(path)), None)
            .map_err(|error| format!("Unable to prepare the selected file: {error}"))?;
        operation
            .DeleteItem(&item, None)
            .map_err(|error| format!("Unable to queue the selected file for deletion: {error}"))?;
        operation.PerformOperations().map_err(|error| {
            format!("Unable to move the selected file to the Recycle Bin: {error}")
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
pub(super) fn recycle_path(_path: &Path) -> Result<(), String> {
    Err("Moving files to the Recycle Bin is only supported on Windows.".to_string())
}

fn recycle_paths(paths: Vec<PathBuf>) -> RecycleResult {
    let mut recycled_paths = Vec::new();
    let mut failed_paths = Vec::new();
    for path in paths {
        match recycle_path(&path) {
            Ok(()) => {
                log::info!("File moved to Recycle Bin: path={}", path_string(&path));
                recycled_paths.push(path_string(&path));
            }
            Err(error) => {
                log::error!(
                    "Unable to move file to Recycle Bin: path={}, error={error}",
                    path_string(&path)
                );
                failed_paths.push(path_string(&path));
            }
        }
    }
    RecycleResult {
        recycled_paths,
        failed_paths,
    }
}

fn process_clipboard_operation(task: ClipboardOperationTask) {
    match task {
        ClipboardOperationTask::WriteClipboard {
            paths,
            operation,
            owner,
            response,
        } => {
            if response
                .send(write_file_clipboard(&paths, operation, owner))
                .is_err()
            {
                log::warn!(
                    "Clipboard write completed but its requester no longer accepts a response"
                );
            }
        }
        ClipboardOperationTask::ReadClipboard { response } => {
            if response.send(read_file_clipboard()).is_err() {
                log::warn!(
                    "Clipboard read completed but its requester no longer accepts a response"
                );
            }
        }
        ClipboardOperationTask::Flush { response } => {
            if response
                .send(windows_shell::flush_windows_file_clipboard())
                .is_err()
            {
                log::warn!(
                    "Clipboard flush completed but its requester no longer accepts a response"
                );
            }
        }
    }
}

#[cfg(target_os = "windows")]
const WM_CLIPBOARD_TASK: u32 = WM_APP + 1;

pub(super) fn start_file_operation_queue() -> FileOperationQueue {
    let (sender, receiver) = mpsc::channel::<FileOperationTask>();
    let (clipboard_sender, clipboard_receiver) = mpsc::channel::<ClipboardOperationTask>();
    let tasks = Arc::new(Mutex::new(HashMap::new()));
    thread::spawn(move || {
        #[cfg(target_os = "windows")]
        let com_initialization = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        #[cfg(target_os = "windows")]
        let com_initialized = com_initialization.is_ok();
        #[cfg(target_os = "windows")]
        if com_initialized {
            log::debug!("File operation queue COM initialization succeeded");
        } else {
            log::error!(
                "File operation queue COM initialization failed; shell operations may fail: {com_initialization:?}"
            );
        }
        log::info!("File operation STA queue started");

        while let Ok(task) = receiver.recv() {
            match task {
                FileOperationTask::Recycle { paths, response } => {
                    if response.send(recycle_paths(paths)).is_err() {
                        log::warn!("Recycle operation completed but its requester no longer accepts a response");
                    }
                }
                FileOperationTask::Rename {
                    path,
                    new_stem,
                    response,
                } => {
                    if response.send(rename_item_path(path, new_stem)).is_err() {
                        log::warn!("Rename operation completed but its requester no longer accepts a response");
                    }
                }
                FileOperationTask::Transfer {
                    control,
                    paths,
                    destination,
                    operation,
                    app_handle,
                } => run_transfer_task(control, paths, destination, operation, app_handle),
            }
        }

        #[cfg(target_os = "windows")]
        if com_initialized {
            unsafe { CoUninitialize() };
        }
        log::info!("File operation STA queue stopped");
    });
    #[cfg(target_os = "windows")]
    let clipboard_thread_id = {
        let (ready_sender, ready_receiver) = mpsc::sync_channel::<u32>(1);
        thread::spawn(move || {
            let ole_initialization = unsafe { OleInitialize(None) };
            if !ole_initialization.is_ok() {
                log::error!(
                    "Clipboard queue OLE initialization failed; file clipboard operations are unavailable: {ole_initialization:?}"
                );
                if ready_sender.send(0).is_err() {
                    log::warn!("Clipboard queue initialization failed after its startup receiver disappeared");
                }
                return;
            }
            log::debug!("Clipboard queue OLE initialization succeeded");

            let mut message = MSG::default();
            unsafe {
                let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
            }
            let thread_id = unsafe { GetCurrentThreadId() };
            if ready_sender.send(thread_id).is_err() {
                log::warn!(
                    "Clipboard queue initialized but its startup receiver disappeared; stopping the queue"
                );
                unsafe { OleUninitialize() };
                return;
            }
            log::debug!(
                "Clipboard STA message loop started: thread_id={thread_id}, wake_message=0x{WM_CLIPBOARD_TASK:X}"
            );

            loop {
                let status = unsafe { GetMessageW(&mut message, None, 0, 0) };
                if status.0 == -1 {
                    log::error!("Clipboard STA GetMessageW failed; stopping the message loop");
                    break;
                }
                if status.0 == 0 {
                    break;
                }
                if message.message == WM_CLIPBOARD_TASK {
                    while let Ok(task) = clipboard_receiver.try_recv() {
                        process_clipboard_operation(task);
                    }
                    continue;
                }
                unsafe {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }

            log::debug!("Clipboard STA message loop stopped: thread_id={thread_id}");
            unsafe { OleUninitialize() };
        });
        match ready_receiver.recv() {
            Ok(thread_id) => thread_id,
            Err(error) => {
                log::error!(
                    "Clipboard queue exited before reporting its thread identifier: {error}"
                );
                0
            }
        }
    };
    #[cfg(not(target_os = "windows"))]
    thread::spawn(move || {
        while let Ok(task) = clipboard_receiver.recv() {
            process_clipboard_operation(task);
        }
    });
    FileOperationQueue {
        sender,
        clipboard_sender,
        #[cfg(target_os = "windows")]
        clipboard_thread_id,
        tasks,
        next_task_id: AtomicU64::new(1),
    }
}

#[cfg(target_os = "windows")]
fn wake_clipboard_queue(queue: &FileOperationQueue) -> Result<(), String> {
    if queue.clipboard_thread_id == 0 {
        return Err("The clipboard STA thread did not initialize.".to_string());
    }
    unsafe {
        PostThreadMessageW(
            queue.clipboard_thread_id,
            WM_CLIPBOARD_TASK,
            WPARAM(0),
            LPARAM(0),
        )
        .map_err(|error| format!("Unable to wake the clipboard STA thread: {error}"))
    }
}

#[cfg(not(target_os = "windows"))]
fn wake_clipboard_queue(_queue: &FileOperationQueue) -> Result<(), String> {
    Ok(())
}

pub(super) fn enqueue_recycle(
    paths: Vec<PathBuf>,
    queue: &FileOperationQueue,
) -> Result<RecycleResult, String> {
    let (response_sender, response_receiver) = mpsc::channel();
    queue
        .sender
        .send(FileOperationTask::Recycle {
            paths,
            response: response_sender,
        })
        .map_err(|_| "The file operation queue is unavailable.".to_string())?;
    response_receiver
        .recv()
        .map_err(|_| "The file operation did not return a result.".to_string())
}

pub(super) fn enqueue_rename(
    path: PathBuf,
    new_stem: String,
    queue: &FileOperationQueue,
) -> Result<RenameResult, String> {
    let (response_sender, response_receiver) = mpsc::channel();
    queue
        .sender
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

pub(super) fn start_transfer_task(
    paths: Vec<String>,
    destination: PathBuf,
    operation: FileTaskOperation,
    app_handle: tauri::AppHandle,
    queue: &FileOperationQueue,
) -> Result<FileTaskSnapshot, String> {
    if paths.is_empty() {
        return Err("Select at least one file for the task.".to_string());
    }
    let id = queue.next_task_id.fetch_add(1, Ordering::Relaxed);
    log::info!(
        "Queueing file task #{id}: operation={operation:?}, items={}, destination={}",
        paths.len(),
        path_string(&destination)
    );
    for (index, path) in paths.iter().enumerate() {
        log::debug!(
            "File task #{id} queued source {}/{}: {path}",
            index + 1,
            paths.len()
        );
    }
    let snapshot = FileTaskSnapshot {
        id,
        operation,
        state: FileTaskState::Queued,
        destination_path: path_string(&destination),
        total_items: paths.len(),
        completed_items: 0,
        results: Vec::with_capacity(paths.len()),
    };
    let control = FileTaskControl {
        snapshot: Arc::new(Mutex::new(snapshot.clone())),
        cancel: Arc::new(AtomicBool::new(false)),
    };
    {
        let mut tasks = queue
            .tasks
            .lock()
            .map_err(|_| "Unable to access the file task registry.".to_string())?;
        if tasks.len() >= 64 {
            let mut completed_ids = tasks
                .iter()
                .filter_map(|(task_id, control)| match control.snapshot.lock() {
                    Ok(snapshot) => matches!(
                        snapshot.state,
                        FileTaskState::Completed | FileTaskState::Cancelled
                    )
                    .then_some(*task_id),
                    Err(_) => {
                        log::error!(
                            "Unable to inspect file task #{task_id} during registry pruning"
                        );
                        None
                    }
                })
                .collect::<Vec<_>>();
            completed_ids.sort_unstable();
            for task_id in completed_ids
                .into_iter()
                .take(tasks.len().saturating_sub(48))
            {
                tasks.remove(&task_id);
            }
        }
        tasks.insert(id, control.clone());
    }
    if queue
        .sender
        .send(FileOperationTask::Transfer {
            control,
            paths,
            destination,
            operation,
            app_handle,
        })
        .is_err()
    {
        if let Ok(mut tasks) = queue.tasks.lock() {
            tasks.remove(&id);
        } else {
            log::error!("Unable to remove rejected file task #{id} from the registry");
        }
        return Err("The file operation queue is unavailable.".to_string());
    }
    Ok(snapshot)
}

pub(super) fn get_file_task(
    task_id: u64,
    queue: &FileOperationQueue,
) -> Result<FileTaskSnapshot, String> {
    let tasks = queue
        .tasks
        .lock()
        .map_err(|_| "Unable to access the file task registry.".to_string())?;
    let control = tasks
        .get(&task_id)
        .ok_or_else(|| "The requested file task no longer exists.".to_string())?;
    control
        .snapshot
        .lock()
        .map(|snapshot| snapshot.clone())
        .map_err(|_| "Unable to read the file task state.".to_string())
}

pub(super) fn cancel_file_task(task_id: u64, queue: &FileOperationQueue) -> Result<bool, String> {
    let tasks = queue
        .tasks
        .lock()
        .map_err(|_| "Unable to access the file task registry.".to_string())?;
    let Some(control) = tasks.get(&task_id) else {
        return Ok(false);
    };
    let cancellable = control
        .snapshot
        .lock()
        .map(|snapshot| {
            matches!(
                snapshot.state,
                FileTaskState::Queued | FileTaskState::Running
            )
        })
        .map_err(|_| "Unable to read the file task state.".to_string())?;
    if cancellable {
        control.cancel.store(true, Ordering::Release);
        log::info!("Cancellation requested for file task #{task_id}");
    } else {
        log::debug!("Cancellation ignored for terminal file task #{task_id}");
    }
    Ok(cancellable)
}

pub(super) fn enqueue_write_clipboard(
    paths: Vec<PathBuf>,
    operation: FileTaskOperation,
    owner: Option<isize>,
    queue: &FileOperationQueue,
) -> Result<(), String> {
    let (response_sender, response_receiver) = mpsc::channel();
    queue
        .clipboard_sender
        .send(ClipboardOperationTask::WriteClipboard {
            paths,
            operation,
            owner,
            response: response_sender,
        })
        .map_err(|_| "The file operation queue is unavailable.".to_string())?;
    wake_clipboard_queue(queue)?;
    response_receiver
        .recv()
        .map_err(|_| "The clipboard operation did not return a result.".to_string())?
}

pub(super) fn enqueue_read_clipboard(queue: &FileOperationQueue) -> Result<ClipboardFiles, String> {
    let (response_sender, response_receiver) = mpsc::channel();
    queue
        .clipboard_sender
        .send(ClipboardOperationTask::ReadClipboard {
            response: response_sender,
        })
        .map_err(|_| "The file operation queue is unavailable.".to_string())?;
    wake_clipboard_queue(queue)?;
    response_receiver
        .recv()
        .map_err(|_| "The clipboard operation did not return a result.".to_string())?
}

pub(super) fn flush_file_clipboard(queue: &FileOperationQueue) -> Result<(), String> {
    let (response_sender, response_receiver) = mpsc::channel();
    queue
        .clipboard_sender
        .send(ClipboardOperationTask::Flush {
            response: response_sender,
        })
        .map_err(|_| "The clipboard operation queue is unavailable.".to_string())?;
    wake_clipboard_queue(queue)?;
    response_receiver
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "The clipboard flush did not return a result.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_test_directory(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "file-sweeper-{label}-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn conflict_names_increment_without_selecting_an_existing_path() {
        let directory = temporary_test_directory("conflict-name");
        let source = directory.join("clip.mp4");
        fs::write(directory.join("clip.mp4"), b"first").unwrap();
        fs::write(directory.join("clip (1).mp4"), b"second").unwrap();

        let destination = unique_copy_destination(&source, &directory).unwrap();

        assert_eq!(destination, directory.join("clip (2).mp4"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn same_directory_copy_is_renamed_but_same_directory_move_is_skipped() {
        let directory = PathBuf::from(r"D:\videos");
        let source = directory.join("clip.mp4");

        assert!(!should_skip_same_directory_transfer(
            &source,
            &directory,
            FileTaskOperation::Copy
        ));
        assert!(should_skip_same_directory_transfer(
            &source,
            &directory,
            FileTaskOperation::Move
        ));
    }

    #[test]
    fn an_unstarted_file_task_accepts_cancellation() {
        let (sender, _receiver) = mpsc::channel();
        let (clipboard_sender, _clipboard_receiver) = mpsc::channel();
        let snapshot = FileTaskSnapshot {
            id: 7,
            operation: FileTaskOperation::Move,
            state: FileTaskState::Queued,
            destination_path: r"D:\destination".to_string(),
            total_items: 2,
            completed_items: 0,
            results: Vec::new(),
        };
        let control = FileTaskControl {
            snapshot: Arc::new(Mutex::new(snapshot)),
            cancel: Arc::new(AtomicBool::new(false)),
        };
        let queue = FileOperationQueue {
            sender,
            clipboard_sender,
            #[cfg(target_os = "windows")]
            clipboard_thread_id: 0,
            tasks: Arc::new(Mutex::new(HashMap::from([(7, control.clone())]))),
            next_task_id: AtomicU64::new(8),
        };

        assert!(cancel_file_task(7, &queue).unwrap());
        assert!(control.cancel.load(Ordering::Acquire));
        assert!(!cancel_file_task(99, &queue).unwrap());
    }
}
