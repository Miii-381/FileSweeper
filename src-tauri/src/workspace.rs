use super::*;

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

pub(super) fn cleanup_interrupted_copy_files(directory: &Path) {
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

pub(super) fn list_directory_impl(
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

    folders.sort_by_key(|folder| folder.name.to_lowercase());
    videos.sort_by_key(|video| video.name.to_lowercase());

    Ok(DirectoryListing {
        path: path_string(&directory),
        folders,
        videos,
        media_suppressed,
    })
}
