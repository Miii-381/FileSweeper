use super::*;
struct ActiveWorkspaceWatcher {
    path: PathBuf,
    _watcher: notify::RecommendedWatcher,
}

pub(super) struct WorkspaceWatchState {
    latest_request: Arc<AtomicU64>,
    active: Mutex<Option<ActiveWorkspaceWatcher>>,
}

struct DirectoryTreeWatcher {
    _watcher: notify::RecommendedWatcher,
}

pub(super) struct DirectoryTreeWatchState {
    active: Mutex<HashMap<String, DirectoryTreeWatcher>>,
}

impl DirectoryTreeWatchState {
    pub(super) fn new() -> Self {
        Self {
            active: Mutex::new(HashMap::new()),
        }
    }

    pub(super) fn set_paths(
        &self,
        paths: Vec<String>,
        app_handle: &tauri::AppHandle,
    ) -> Result<(), String> {
        let mut desired = HashMap::new();
        for path in paths {
            let directory = fs::canonicalize(&path)
                .map_err(|error| format!("Unable to watch this folder: {error}"))?;
            if !directory.is_dir() {
                return Err("Only folders can be watched in the directory tree.".to_string());
            }
            let normalized = path_string(&directory);
            desired.insert(normalized.to_ascii_lowercase(), directory);
        }

        let mut active = self
            .active
            .lock()
            .map_err(|_| "Unable to access directory tree watchers.".to_string())?;
        active.retain(|key, _| desired.contains_key(key));

        for (key, directory) in desired {
            if active.contains_key(&key) {
                continue;
            }
            let event_app = app_handle.clone();
            let watched_path = path_string(&directory);
            let event_path = watched_path.clone();
            let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                match result {
                    Ok(event) => {
                        log::debug!(
                            "Directory tree filesystem event: parent={event_path}, kind={:?}, paths={}",
                            event.kind,
                            event.paths.len()
                        );
                        if let Err(error) = event_app.emit("directory-tree-event", &event_path) {
                            log::warn!(
                                "Directory tree change detected but UI event delivery failed: parent={event_path}, error={error}"
                            );
                        }
                    }
                    Err(error) => log::warn!("Directory tree watcher error: parent={event_path}, error={error}"),
                }
            })
            .map_err(|error| format!("Unable to create the directory tree watcher: {error}"))?;
            watcher
                .watch(&directory, RecursiveMode::NonRecursive)
                .map_err(|error| format!("Unable to watch the directory tree folder: {error}"))?;
            active.insert(key, DirectoryTreeWatcher { _watcher: watcher });
            log::debug!("Directory tree watcher started: path={watched_path}");
        }
        Ok(())
    }
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
        if name.starts_with('.') && name.contains(".filesweeper-copy-") && name.ends_with(".tmp") {
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
                    can_recycle: false,
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
            can_recycle: false,
        }]
    }
}

pub(super) fn is_recyclable_directory(directory: &Path) -> bool {
    directory.parent().is_some()
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
            can_recycle: is_recyclable_directory(&entry_path),
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

pub(super) fn list_directory_impl(
    path: &str,
    settings: &Preferences,
    thumbnail_index: &Arc<Mutex<MediaCacheIndex>>,
    thumbnail_cache_dir: &Path,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<DirectoryListing, String> {
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
    let video_extensions: HashSet<&str> = settings
        .video_extensions
        .iter()
        .map(String::as_str)
        .collect();
    let audio_extensions: HashSet<&str> = settings
        .audio_extensions
        .iter()
        .map(String::as_str)
        .collect();
    let image_extensions: HashSet<&str> = settings
        .image_extensions
        .iter()
        .map(String::as_str)
        .collect();
    let text_extensions: HashSet<&str> = settings
        .text_extensions
        .iter()
        .map(String::as_str)
        .collect();
    let mut items = Vec::new();

    for entry in fs::read_dir(&directory)
        .map_err(|error| format!("Unable to enumerate this folder: {error}"))?
    {
        if is_cancelled() {
            log::debug!(
                "Directory listing cancelled during enumeration: path={}, items_collected={}",
                path_string(&directory),
                items.len()
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
        if !settings.show_hidden_items && is_hidden_or_system(&metadata) {
            continue;
        }

        let entry_path = entry.path();
        if metadata.is_dir() {
            items.push(DirectoryItem::Folder(FolderEntry {
                entry_type: "folder",
                path: path_string(&entry_path),
                name: folder_name(&entry_path),
                created_at: unix_millis(metadata.created()),
                modified_at: unix_millis(metadata.modified()),
                can_recycle: is_recyclable_directory(&entry_path),
            }));
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        let extension = domain::normalized_file_extension(&entry_path);
        let kind = if extension == ".pdf" {
            FileKind::Pdf
        } else if video_extensions.contains(extension.as_str()) {
            FileKind::Video
        } else if audio_extensions.contains(extension.as_str()) {
            FileKind::Audio
        } else if image_extensions.contains(extension.as_str()) {
            FileKind::Image
        } else if text_extensions.contains(extension.as_str()) {
            FileKind::Text
        } else {
            FileKind::Other
        };
        if media_suppressed && matches!(kind, FileKind::Video | FileKind::Audio | FileKind::Image) {
            continue;
        }
        let cached_metadata = matches!(kind, FileKind::Video)
            .then(|| cached_media_metadata(&entry_path, &metadata, thumbnail_index))
            .flatten();
        items.push(DirectoryItem::File(FileEntry {
            entry_type: "file",
            path: path_string(&entry_path),
            name: folder_name(&entry_path),
            extension,
            size: metadata.len(),
            created_at: unix_millis(metadata.created()),
            modified_at: unix_millis(metadata.modified()),
            duration: cached_metadata.as_ref().and_then(|value| value.duration),
            width: cached_metadata.as_ref().and_then(|value| value.width),
            height: cached_metadata.as_ref().and_then(|value| value.height),
            thumbnail_path: match kind {
                FileKind::Video => cached_thumbnail_path(
                    &entry_path,
                    &metadata,
                    thumbnail_index,
                    thumbnail_cache_dir,
                    &settings.thumbnail_capture_position,
                ),
                FileKind::Image => cached_thumbnail_path(
                    &entry_path,
                    &metadata,
                    thumbnail_index,
                    thumbnail_cache_dir,
                    "image-v1",
                ),
                FileKind::Audio => cached_thumbnail_path(
                    &entry_path,
                    &metadata,
                    thumbnail_index,
                    thumbnail_cache_dir,
                    "audio-cover-v1",
                ),
                FileKind::Text | FileKind::Pdf | FileKind::Other => None,
            },
            kind,
            preview_capability: match kind {
                FileKind::Video
                | FileKind::Audio
                | FileKind::Image
                | FileKind::Text
                | FileKind::Pdf => PreviewCapability::Inline,
                FileKind::Other => PreviewCapability::MetadataOnly,
            },
        }));
    }

    items.sort_by_key(|item| match item {
        DirectoryItem::Folder(folder) => folder.name.to_lowercase(),
        DirectoryItem::File(file) => file.name.to_lowercase(),
    });
    Ok(DirectoryListing {
        path: path_string(&directory),
        items,
        media_suppressed,
        is_available: true,
    })
}

pub(super) fn list_folder_thumbnail_sources_impl(
    paths: Vec<String>,
    settings: &Preferences,
    thumbnail_index: &Arc<Mutex<MediaCacheIndex>>,
    thumbnail_cache_dir: &Path,
) -> Vec<FolderThumbnailSources> {
    paths
        .into_iter()
        .filter_map(|path| {
            let listing = list_directory_impl(
                &path,
                settings,
                thumbnail_index,
                thumbnail_cache_dir,
                &|| false,
            )
            .ok()?;
            let files = listing
                .items
                .into_iter()
                .filter_map(|item| match item {
                    DirectoryItem::File(file)
                        if matches!(
                            file.kind,
                            FileKind::Image | FileKind::Video | FileKind::Audio
                        ) =>
                    {
                        Some(file)
                    }
                    DirectoryItem::Folder(_) | DirectoryItem::File(_) => None,
                })
                .take(4)
                .collect();
            Some(FolderThumbnailSources {
                folder_path: listing.path,
                files,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "file-sweeper-workspace-{name}-{}-{}",
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

        let listing = list_directory_impl(
            child.to_str().unwrap(),
            &Preferences::default(),
            &index,
            &root,
            &|| false,
        )
        .unwrap();
        assert!(listing.media_suppressed);
        assert!(listing.items.is_empty());
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
            list_directory_impl(child.to_str().unwrap(), &settings, &index, &root, &|| false)
                .unwrap();
        assert!(!listing.media_suppressed);
        assert_eq!(listing.items.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pdf_files_remain_visible_in_nomedia_directories_and_are_inline_previewable() {
        let root = test_directory("nomedia-pdf");
        fs::write(root.join(".nomedia"), b"").unwrap();
        fs::write(root.join("guide.PDF"), b"%PDF-1.7").unwrap();
        let index = Arc::new(Mutex::new(MediaCacheIndex::default()));

        let listing = list_directory_impl(
            root.to_str().unwrap(),
            &Preferences::default(),
            &index,
            &root,
            &|| false,
        )
        .unwrap();
        assert!(listing.media_suppressed);
        let pdf = listing
            .items
            .iter()
            .find_map(|item| match item {
                DirectoryItem::File(file) if file.name == "guide.PDF" => Some(file),
                DirectoryItem::Folder(_) | DirectoryItem::File(_) => None,
            })
            .expect("PDF file should remain listed");
        assert_eq!(pdf.kind, FileKind::Pdf);
        assert_eq!(pdf.preview_capability, PreviewCapability::Inline);
        assert!(pdf.thumbnail_path.is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pdf_classification_overrides_user_configured_text_extensions() {
        let root = test_directory("pdf-kind");
        fs::write(root.join("manual.pdf"), b"%PDF-1.7").unwrap();
        let index = Arc::new(Mutex::new(MediaCacheIndex::default()));
        let mut settings = Preferences::default();
        settings.text_extensions.push(".pdf".to_string());

        let listing =
            list_directory_impl(root.to_str().unwrap(), &settings, &index, &root, &|| false)
                .unwrap();
        assert!(listing.items.iter().any(|item| matches!(
            item,
            DirectoryItem::File(file) if file.name == "manual.pdf" && file.kind == FileKind::Pdf
        )));
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
    fn only_non_root_directories_are_recyclable() {
        assert!(!is_recyclable_directory(Path::new(r"C:\\")));
        let root = test_directory("recyclable");
        let child = root.join("child");
        fs::create_dir(&child).unwrap();
        assert!(is_recyclable_directory(&child));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn directory_listing_includes_direct_folders_and_files() {
        let root = test_directory("mixed-items");
        fs::create_dir(root.join("album")).unwrap();
        fs::write(root.join("note.txt"), b"notes").unwrap();
        let index = Arc::new(Mutex::new(MediaCacheIndex::default()));

        let listing = list_directory_impl(
            root.to_str().unwrap(),
            &Preferences::default(),
            &index,
            &root,
            &|| false,
        )
        .unwrap();
        assert!(listing
            .items
            .iter()
            .any(|item| matches!(item, DirectoryItem::Folder(folder) if folder.name == "album")));
        assert!(listing
            .items
            .iter()
            .any(|item| matches!(item, DirectoryItem::File(file) if file.name == "note.txt")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn folder_thumbnail_sources_are_limited_to_direct_visual_files() {
        let root = test_directory("folder-thumbnail-sources");
        let album = root.join("album");
        fs::create_dir_all(album.join("nested")).unwrap();
        for index in 0..5 {
            fs::write(album.join(format!("image-{index}.png")), b"png").unwrap();
        }
        fs::write(album.join("nested").join("ignored.jpg"), b"jpg").unwrap();
        fs::write(album.join("notes.txt"), b"notes").unwrap();
        let index = Arc::new(Mutex::new(MediaCacheIndex::default()));

        let sources = list_folder_thumbnail_sources_impl(
            vec![path_string(&album)],
            &Preferences::default(),
            &index,
            &root,
        );
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].files.len(), 4);
        assert!(sources[0].files.iter().all(|file| matches!(
            file.kind,
            FileKind::Image | FileKind::Video | FileKind::Audio
        )));
        assert!(sources[0]
            .files
            .iter()
            .all(|file| !file.path.contains("nested")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn workspace_scan_observes_cancellation_before_enumeration() {
        let root = test_directory("cancelled");
        fs::write(root.join("sample.mp4"), b"video").unwrap();
        let index = Arc::new(Mutex::new(MediaCacheIndex::default()));

        let result = list_directory_impl(
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
