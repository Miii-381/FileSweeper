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
    let mut folders = Vec::new();
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
        if !metadata.is_dir() || (!settings.show_hidden_items && is_hidden_or_system(&metadata)) {
            continue;
        }
        let entry_path = entry.path();
        folders.push(DirectoryEntry {
            path: path_string(&entry_path),
            name: folder_name(&entry_path),
            has_children: has_visible_child_directories(&entry_path, settings),
        });
    }
    folders.sort_by_key(|folder| folder.name.to_lowercase());
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
    thumbnail_index: &Arc<Mutex<ThumbnailIndex>>,
    thumbnail_cache_dir: &Path,
) -> Result<WorkspaceListing, String> {
    let directory = resolve_directory(path)?;
    cleanup_interrupted_copy_files(&directory);

    let media_suppressed = !settings.show_nomedia_media && has_nomedia_ancestor(&directory);
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
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => continue,
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
        let index = Arc::new(Mutex::new(ThumbnailIndex::default()));

        let listing = scan_workspace_impl(
            child.to_str().unwrap(),
            &Preferences::default(),
            &index,
            &root,
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
        let index = Arc::new(Mutex::new(ThumbnailIndex::default()));
        let settings = Preferences {
            show_nomedia_media: true,
            ..Preferences::default()
        };

        let listing =
            scan_workspace_impl(child.to_str().unwrap(), &settings, &index, &root).unwrap();
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
}
