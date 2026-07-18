use super::*;
struct ActiveWorkspaceWatcher {
    path: PathBuf,
    _watcher: notify::RecommendedWatcher,
}

pub(super) struct WorkspaceWatchState {
    latest_request: Arc<AtomicU64>,
    active: Mutex<Option<ActiveWorkspaceWatcher>>,
}

impl WorkspaceWatchState {
    pub(super) fn new() -> Self {
        Self {
            latest_request: Arc::new(AtomicU64::new(0)),
            active: Mutex::new(None),
        }
    }

    pub(super) fn begin(&self, request_id: u64) {
        self.latest_request.fetch_max(request_id, Ordering::SeqCst);
        log::debug!("Workspace scan generation started: request_id={request_id}");
    }

    pub(super) fn cancellation_token(&self) -> Arc<AtomicU64> {
        Arc::clone(&self.latest_request)
    }

    pub(super) fn clear_if_latest(&self, request_id: u64) {
        if self.latest_request.load(Ordering::SeqCst) == request_id {
            if let Ok(mut active) = self.active.lock() {
                if active.is_some() {
                    log::debug!(
                        "Clearing workspace watcher for failed scan: request_id={request_id}"
                    );
                }
                *active = None;
            }
        }
    }

    pub(super) fn clear_path(&self, path: &Path) {
        if let Ok(mut active) = self.active.lock() {
            let matches = active.as_ref().is_some_and(|watcher| {
                path_string(&watcher.path).eq_ignore_ascii_case(&path_string(path))
            });
            if matches {
                log::info!(
                    "Stopping workspace watcher for inaccessible path: {}",
                    path_string(path)
                );
                *active = None;
            }
        }
    }

    pub(super) fn watch_if_latest(
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
                Ok(event) => {
                    log::debug!(
                        "Workspace filesystem event: workspace={event_path}, kind={:?}, paths={}",
                        event.kind,
                        event.paths.len()
                    );
                    if let Err(error) = event_app.emit("workspace-file-event", &event_path) {
                        log::warn!(
                            "Workspace change detected but UI event delivery failed: workspace={event_path}, error={error}"
                        );
                    }
                }
                Err(error) => {
                    log::warn!("Workspace watcher error for {event_path}: {error}");
                    if let Err(emit_error) = event_app.emit("workspace-file-event", &event_path) {
                        log::error!(
                            "Workspace watcher failed and fallback UI refresh event delivery also failed: workspace={event_path}, error={emit_error}"
                        );
                    }
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
        log::info!(
            "Workspace watcher started: request_id={request_id}, path={}",
            path_string(path)
        );
        Ok(())
    }
}

pub(super) const WORKSPACE_SCAN_CANCELLED: &str = "The workspace scan was superseded.";

#[cfg(target_os = "windows")]
pub(super) fn is_hidden_or_system(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
    metadata.file_attributes() & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0
}

#[cfg(not(target_os = "windows"))]
pub(super) fn is_hidden_or_system(_metadata: &fs::Metadata) -> bool {
    false
}

pub(super) fn has_visible_child_directories(directory: &Path, settings: &Preferences) -> bool {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) => {
            log::debug!(
                "Unable to inspect root for child directories; treating it as collapsed: path={}, error={error}",
                path_string(directory)
            );
            return false;
        }
    };

    entries.flatten().any(|entry| {
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(error) => {
                log::debug!(
                    "Unable to inspect potential child directory; skipping entry: path={}, error={error}",
                    path_string(&entry.path())
                );
                return false;
            }
        };
        metadata.is_dir() && (settings.show_hidden_items || !is_hidden_or_system(&metadata))
    })
}

pub(super) fn cleanup_interrupted_copy_files(directory: &Path) {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) => {
            log::warn!(
                "Unable to scan workspace for interrupted copy files: path={}, error={error}",
                path_string(directory)
            );
            return;
        }
    };
    let mut removed = 0_usize;
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        if name.starts_with('.') && name.contains(".videosweeper-copy-") && name.ends_with(".tmp") {
            if let Err(error) = fs::remove_file(entry.path()) {
                log::warn!(
                    "Unable to remove interrupted copy file {}: {error}",
                    entry.path().display()
                );
            } else {
                removed += 1;
            }
        }
    }
    if removed > 0 {
        log::info!(
            "Removed interrupted copy files: workspace={}, files={removed}",
            path_string(directory)
        );
    }
}

pub(super) fn available_roots(settings: &Preferences) -> Vec<DirectoryEntry> {
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

fn resolve_directory(path: &str) -> Result<PathBuf, String> {
    let directory =
        fs::canonicalize(path).map_err(|error| format!("Unable to open this folder: {error}"))?;
    if !directory.is_dir() {
        return Err("The selected location is not a folder.".to_string());
    }
    Ok(directory)
}

pub(super) fn list_subdirectories_impl(
    path: &str,
    settings: &Preferences,
) -> Result<DirectoryChildren, String> {
    let directory = resolve_directory(path)?;
    log::debug!(
        "Enumerating child directories: path={}",
        path_string(&directory)
    );
    let mut folders = Vec::new();
    for entry in fs::read_dir(&directory)
        .map_err(|error| format!("Unable to enumerate this folder: {error}"))?
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                log::warn!(
                    "Unable to read directory entry; skipping it: parent={}, error={error}",
                    path_string(&directory)
                );
                continue;
            }
        };
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(error) => {
                log::warn!(
                    "Unable to read child metadata; skipping entry: path={}, error={error}",
                    path_string(&entry.path())
                );
                continue;
            }
        };
        if !metadata.is_dir() || (!settings.show_hidden_items && is_hidden_or_system(&metadata)) {
            continue;
        }
        let entry_path = entry.path();
        folders.push(DirectoryEntry {
            path: path_string(&entry_path),
            name: folder_name(&entry_path),
            // Child discovery is deliberately lazy. Probing every child here turns one tree
            // expansion into N additional read_dir calls on large/network directories.
            has_children: true,
        });
    }
    folders.sort_by_key(|folder| folder.name.to_lowercase());
    log::debug!(
        "Child directory enumeration completed: path={}, folders={}",
        path_string(&directory),
        folders.len()
    );
    Ok(DirectoryChildren {
        path: path_string(&directory),
        folders,
    })
}

pub(super) fn has_nomedia_ancestor(directory: &Path) -> bool {
    directory
        .ancestors()
        .any(|ancestor| ancestor.join(".nomedia").is_file())
}

pub(super) fn scan_workspace_impl(
    path: &str,
    settings: &Preferences,
    thumbnail_index: &Arc<Mutex<MediaCacheIndex>>,
    thumbnail_cache_dir: &Path,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<WorkspaceListing, String> {
    if is_cancelled() {
        log::debug!("Workspace scan cancelled before path resolution: requested_path={path}");
        return Err(WORKSPACE_SCAN_CANCELLED.to_string());
    }
    let directory = resolve_directory(path)?;
    cleanup_interrupted_copy_files(&directory);

    let media_suppressed = !settings.show_nomedia_media && has_nomedia_ancestor(&directory);
    if media_suppressed {
        log::info!(
            "Workspace media enumeration suppressed by .nomedia: path={}",
            path_string(&directory)
        );
    }
    let extensions: HashSet<&str> = settings
        .video_extensions
        .iter()
        .map(String::as_str)
        .collect();
    let mut videos = Vec::new();

    if !media_suppressed {
        for entry in fs::read_dir(&directory)
            .map_err(|error| format!("Unable to enumerate this folder: {error}"))?
        {
            if is_cancelled() {
                log::debug!(
                    "Workspace scan cancelled during enumeration: path={}, videos_collected={}",
                    path_string(&directory),
                    videos.len()
                );
                return Err(WORKSPACE_SCAN_CANCELLED.to_string());
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    log::warn!(
                        "Unable to read workspace entry; skipping it: workspace={}, error={error}",
                        path_string(&directory)
                    );
                    continue;
                }
            };
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(error) => {
                    log::warn!(
                        "Unable to read workspace item metadata; skipping it: path={}, error={error}",
                        path_string(&entry.path())
                    );
                    continue;
                }
            };
            if !metadata.is_file()
                || (!settings.show_hidden_items && is_hidden_or_system(&metadata))
            {
                continue;
            }

            let entry_path = entry.path();
            let extension = entry_path
                .extension()
                .and_then(|extension| extension.to_str())
                .map(|extension| format!(".{}", extension.to_ascii_lowercase()))
                .unwrap_or_default();
            if !extensions.contains(extension.as_str()) {
                continue;
            }

            let cached_metadata = cached_media_metadata(&entry_path, &metadata, thumbnail_index);
            videos.push(VideoEntry {
                path: path_string(&entry_path),
                name: folder_name(&entry_path),
                extension,
                size: metadata.len(),
                created_at: unix_millis(metadata.created()),
                modified_at: unix_millis(metadata.modified()),
                duration: cached_metadata.as_ref().and_then(|value| value.duration),
                width: cached_metadata.as_ref().and_then(|value| value.width),
                height: cached_metadata.as_ref().and_then(|value| value.height),
                thumbnail_path: cached_thumbnail_path(
                    &entry_path,
                    &metadata,
                    thumbnail_index,
                    thumbnail_cache_dir,
                    &settings.thumbnail_capture_position,
                ),
            });
        }
    }

    videos.sort_by_key(|video| video.name.to_lowercase());
    Ok(WorkspaceListing {
        path: path_string(&directory),
        videos,
        media_suppressed,
        is_available: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "video-sweeper-workspace-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock should be after epoch")
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn nomedia_applies_to_all_descendant_workspaces() {
        let root = test_directory("nomedia");
        let child = root.join("one").join("two");
        fs::create_dir_all(&child).unwrap();
        fs::write(root.join(".nomedia"), b"").unwrap();
        fs::write(child.join("sample.mp4"), b"video").unwrap();
        let index = Arc::new(Mutex::new(MediaCacheIndex::default()));

        let listing = scan_workspace_impl(
            child.to_str().unwrap(),
            &Preferences::default(),
            &index,
            &root,
            &|| false,
        )
        .unwrap();
        assert!(listing.media_suppressed);
        assert!(listing.videos.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn nomedia_override_restores_descendant_media() {
        let root = test_directory("nomedia-override");
        let child = root.join("child");
        fs::create_dir_all(&child).unwrap();
        fs::write(root.join(".nomedia"), b"").unwrap();
        fs::write(child.join("sample.mp4"), b"video").unwrap();
        let index = Arc::new(Mutex::new(MediaCacheIndex::default()));
        let settings = Preferences {
            show_nomedia_media: true,
            ..Preferences::default()
        };

        let listing =
            scan_workspace_impl(child.to_str().unwrap(), &settings, &index, &root, &|| false)
                .unwrap();
        assert!(!listing.media_suppressed);
        assert_eq!(listing.videos.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn directory_tree_enumeration_does_not_scan_media() {
        let root = test_directory("tree");
        fs::create_dir(root.join("child")).unwrap();
        fs::write(root.join("sample.mp4"), b"video").unwrap();

        let children =
            list_subdirectories_impl(root.to_str().unwrap(), &Preferences::default()).unwrap();
        assert_eq!(children.folders.len(), 1);
        assert_eq!(children.folders[0].name, "child");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn workspace_scan_observes_cancellation_before_enumeration() {
        let root = test_directory("cancelled");
        fs::write(root.join("sample.mp4"), b"video").unwrap();
        let index = Arc::new(Mutex::new(MediaCacheIndex::default()));

        let result = scan_workspace_impl(
            root.to_str().unwrap(),
            &Preferences::default(),
            &index,
            &root,
            &|| true,
        );
        assert_eq!(result.unwrap_err(), WORKSPACE_SCAN_CANCELLED);
        fs::remove_dir_all(root).unwrap();
    }
}
