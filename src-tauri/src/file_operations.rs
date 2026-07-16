use super::*;

pub(super) fn normalize_video_paths(paths: Vec<String>) -> Result<Vec<PathBuf>, String> {
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
    domain::validate_windows_file_stem(new_stem)
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

pub(super) fn start_file_operation_queue() -> FileOperationQueue {
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

pub(super) fn enqueue_recycle(
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

pub(super) fn enqueue_rename(
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

pub(super) fn enqueue_copy(
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
