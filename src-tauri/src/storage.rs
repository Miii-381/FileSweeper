use super::*;
pub(super) const MEBIBYTE: u64 = 1024 * 1024;
pub(super) const GIBIBYTE: u64 = 1024 * MEBIBYTE;

pub(super) fn app_data_dir() -> Result<PathBuf, String> {
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

pub(super) fn config_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("config.json"))
}

pub(super) fn log_dir() -> Result<PathBuf, String> {
    let directory = app_data_dir()?.join("logs");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Unable to create the log directory: {error}"))?;
    Ok(directory)
}

pub(super) fn log_path() -> Result<PathBuf, String> {
    Ok(log_dir()?.join("video-sweeper.log"))
}

pub(super) fn backgrounds_dir() -> Result<PathBuf, String> {
    let directory = app_data_dir()?.join("backgrounds");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Unable to create the backgrounds directory: {error}"))?;
    Ok(directory)
}

pub(super) fn diagnostics_dir() -> Result<PathBuf, String> {
    let directory = app_data_dir()?.join("diagnostics");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Unable to create the diagnostics directory: {error}"))?;
    Ok(directory)
}

pub(super) fn unix_millis(time: Result<SystemTime, std::io::Error>) -> Option<u128> {
    let time = match time {
        Ok(time) => time,
        Err(error) => {
            log::warn!(
                "Unable to read a file timestamp; the cache fingerprint will use zero: {error}"
            );
            return None;
        }
    };
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => Some(duration.as_millis()),
        Err(error) => {
            log::warn!("A file timestamp predates the Unix epoch; the cache fingerprint will use zero: {error}");
            None
        }
    }
}

pub(super) fn current_unix_millis() -> u128 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_millis(),
        Err(error) => {
            log::warn!(
                "System clock is before the Unix epoch; falling back to timestamp zero: {error}"
            );
            0
        }
    }
}

pub(super) fn path_string(path: &Path) -> String {
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

pub(super) fn thumbnail_cache_dir() -> Result<PathBuf, String> {
    let directory = app_data_dir()?.join("thumbnails");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Unable to create the thumbnail cache: {error}"))?;
    Ok(directory)
}

pub(super) fn fnv1a_hash(bytes: &[u8]) -> u64 {
    domain::fnv1a_64(bytes)
}

pub(super) fn thumbnail_source_key(path: &Path) -> String {
    let mut source = path_string(path);
    if cfg!(target_os = "windows") {
        source = source.to_ascii_lowercase();
    }
    source
}

pub(super) fn thumbnail_path_for(path: &Path) -> Result<PathBuf, String> {
    Ok(thumbnail_cache_dir()?.join(format!(
        "{:016x}.jpg",
        fnv1a_hash(thumbnail_source_key(path).as_bytes())
    )))
}

pub(super) fn thumbnail_index_path_for(thumbnail_cache_dir: &Path) -> PathBuf {
    thumbnail_cache_dir.join("index.json")
}

pub(super) fn backup_corrupt_thumbnail_index(path: &Path) -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let backup_path = path.with_file_name(format!("index-corrupt-{timestamp}.json"));
    fs::copy(path, &backup_path)
        .map_err(|error| format!("Unable to back up the corrupt thumbnail index: {error}"))?;
    Ok(backup_path)
}

#[cfg(test)]
pub(super) fn load_thumbnail_index_from(thumbnail_cache_dir: &Path) -> MediaCacheIndex {
    load_thumbnail_index_with_diagnostic(thumbnail_cache_dir).0
}

pub(super) fn load_thumbnail_index_with_diagnostic(
    thumbnail_cache_dir: &Path,
) -> (MediaCacheIndex, Option<(log::Level, String)>) {
    let path = thumbnail_index_path_for(thumbnail_cache_dir);
    if !path.is_file() {
        log::info!(
            "Media cache index does not exist; starting empty: {}",
            path_string(&path)
        );
        return (MediaCacheIndex::default(), None);
    }

    let loaded = (|| -> Result<(MediaCacheIndex, bool), String> {
        let bytes = fs::read(&path).map_err(|error| {
            format!(
                "Unable to read media cache index {}: {error}",
                path_string(&path)
            )
        })?;
        let value = serde_json::from_slice::<serde_json::Value>(&bytes).map_err(|error| {
            format!(
                "Unable to parse media cache index JSON {}: {error}",
                path_string(&path)
            )
        })?;
        if value.get("version").and_then(serde_json::Value::as_u64)
            == Some(u64::from(MEDIA_CACHE_VERSION))
        {
            serde_json::from_value::<MediaCacheIndex>(value)
                .map(|index| (index, false))
                .map_err(|error| {
                    format!(
                        "Unable to decode media cache index {}: {error}",
                        path_string(&path)
                    )
                })
        } else {
            let legacy =
                serde_json::from_value::<LegacyThumbnailIndex>(value).map_err(|error| {
                    format!(
                        "Unable to decode legacy thumbnail index {}: {error}",
                        path_string(&path)
                    )
                })?;
            Ok((
                MediaCacheIndex {
                    version: MEDIA_CACHE_VERSION,
                    entries: legacy
                        .entries
                        .into_iter()
                        .map(|(path, entry)| {
                            (
                                path,
                                MediaCacheEntry {
                                    size: entry.size,
                                    modified_at: entry.modified_at,
                                    thumbnail: Some(CachedThumbnail {
                                        capture_position: entry.capture_position,
                                        thumbnail_file: entry.thumbnail_file,
                                        last_accessed_at: entry.last_accessed_at,
                                    }),
                                    metadata: None,
                                },
                            )
                        })
                        .collect(),
                },
                true,
            ))
        }
    })();
    match loaded {
        Ok((index, migrated)) => {
            log::info!(
                "Media cache index loaded: path={}, version={}, entries={}, migrated={migrated}",
                path_string(&path),
                index.version,
                index.entries.len()
            );
            let diagnostic = if migrated {
                log::info!(
                    "Migrating legacy thumbnail index to media cache index: {}",
                    path_string(&path)
                );
                if let Err(error) = persist_thumbnail_index_at(thumbnail_cache_dir, &index) {
                    log::warn!("Unable to persist the migrated media cache index: {error}");
                    Some((
                        log::Level::Warn,
                        format!(
                            "Legacy thumbnail index was loaded, but persisting the migrated media cache index failed; migration will be retried next launch: {error}"
                        ),
                    ))
                } else {
                    None
                }
            } else {
                None
            };
            (index, diagnostic)
        }
        Err(load_error) => {
            log::error!("Media cache index load failed: {load_error}");
            let backup_diagnostic = match backup_corrupt_thumbnail_index(&path) {
                Ok(backup_path) => {
                    log::warn!(
                        "Thumbnail index {} is corrupt; backed it up to {} and will rebuild the cache index.",
                        path_string(&path),
                        path_string(&backup_path)
                    );
                    format!("backup={}", path_string(&backup_path))
                }
                Err(error) => {
                    log::warn!(
                        "Thumbnail index {} is corrupt and could not be backed up: {error}",
                        path_string(&path)
                    );
                    format!("backup_failed={error}")
                }
            };
            log::warn!(
                "Unable to read thumbnail index {}; starting with an empty index.",
                path_string(&path)
            );
            let index = MediaCacheIndex::default();
            let rebuild_diagnostic = match persist_thumbnail_index_at(thumbnail_cache_dir, &index) {
                Ok(()) => "rebuild=completed".to_string(),
                Err(error) => {
                    log::warn!("Unable to rebuild the thumbnail index: {error}");
                    format!("rebuild_failed={error}")
                }
            };
            let diagnostic = format!(
                "Media cache index load failed and the application fell back to an empty index: {load_error}; {backup_diagnostic}; {rebuild_diagnostic}"
            );
            (index, Some((log::Level::Error, diagnostic)))
        }
    }
}

#[cfg(target_os = "windows")]
pub(super) fn atomic_replace_file(
    temporary_path: &Path,
    path: &Path,
    label: &str,
) -> Result<(), String> {
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
pub(super) fn atomic_replace_file(
    temporary_path: &Path,
    path: &Path,
    label: &str,
) -> Result<(), String> {
    fs::rename(temporary_path, path)
        .map_err(|error| format!("Unable to atomically replace the {label}: {error}"))
}

pub(super) fn persist_thumbnail_index_at(
    thumbnail_cache_dir: &Path,
    index: &MediaCacheIndex,
) -> Result<(), String> {
    let path = thumbnail_index_path_for(thumbnail_cache_dir);
    let temporary_path = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(index)
        .map_err(|error| format!("Unable to serialize the thumbnail index: {error}"))?;
    fs::write(&temporary_path, bytes)
        .map_err(|error| format!("Unable to write the thumbnail index: {error}"))?;
    atomic_replace_file(&temporary_path, &path, "thumbnail index")
}

pub(super) fn persist_thumbnail_index(index: &MediaCacheIndex) -> Result<(), String> {
    persist_thumbnail_index_at(&thumbnail_cache_dir()?, index)
}

pub(super) fn thumbnail_cache_limit_bytes(cache_gb: f64) -> u64 {
    (cache_gb * GIBIBYTE as f64)
        .round()
        .clamp(0.0, u64::MAX as f64) as u64
}

pub(super) fn thumbnail_entry_path(
    thumbnail_cache_dir: &Path,
    thumbnail: &CachedThumbnail,
) -> Option<PathBuf> {
    let file_name = Path::new(&thumbnail.thumbnail_file).file_name()?.to_str()?;
    if file_name != thumbnail.thumbnail_file || !file_name.ends_with(".jpg") {
        return None;
    }
    Some(thumbnail_cache_dir.join(file_name))
}

pub(super) fn media_entry_is_current(source_key: &str, entry: &MediaCacheEntry) -> bool {
    let Ok(metadata) = fs::metadata(source_key) else {
        return false;
    };
    metadata.is_file()
        && metadata.len() == entry.size
        && unix_millis(metadata.modified()).unwrap_or(0) == entry.modified_at
}

pub(super) fn is_thumbnail_cache_file(path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let Some(stem) = file_name.strip_suffix(".jpg") else {
        return false;
    };
    stem.len() == 16 && stem.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn maintain_thumbnail_cache(
    thumbnail_cache_dir: &Path,
    thumbnail_index: &Arc<Mutex<MediaCacheIndex>>,
    cache_maintenance_lock: &Arc<Mutex<()>>,
    cache_limit_bytes: u64,
) -> Result<(), String> {
    let _cache_maintenance = cache_maintenance_lock
        .lock()
        .map_err(|_| "Unable to access the thumbnail cache maintenance lock.".to_string())?;
    let mut index = thumbnail_index
        .lock()
        .map_err(|_| "Unable to access the thumbnail index.".to_string())?;
    maintain_thumbnail_cache_locked(thumbnail_cache_dir, &mut index, cache_limit_bytes)
}

pub(super) fn maintain_thumbnail_cache_locked(
    thumbnail_cache_dir: &Path,
    index: &mut MediaCacheIndex,
    cache_limit_bytes: u64,
) -> Result<(), String> {
    let mut changed = false;
    let entries_before = index.entries.len();
    let mut invalid_entries = 0_usize;
    let mut missing_thumbnails = 0_usize;
    let mut orphan_files = 0_usize;
    let mut evicted_files = 0_usize;
    let mut referenced_files = HashSet::new();
    index.entries.retain(|source_key, entry| {
        if !media_entry_is_current(source_key, entry) {
            changed = true;
            invalid_entries += 1;
            return false;
        }
        if let Some(thumbnail) = &entry.thumbnail {
            let valid = thumbnail_entry_path(thumbnail_cache_dir, thumbnail)
                .is_some_and(|thumbnail_path| thumbnail_path.is_file());
            if valid {
                referenced_files.insert(thumbnail.thumbnail_file.clone());
            } else {
                entry.thumbnail = None;
                changed = true;
                missing_thumbnails += 1;
            }
        }
        true
    });

    for directory_entry in fs::read_dir(thumbnail_cache_dir)
        .map_err(|error| format!("Unable to inspect the thumbnail cache: {error}"))?
    {
        let directory_entry = directory_entry
            .map_err(|error| format!("Unable to inspect a thumbnail cache entry: {error}"))?;
        let path = directory_entry.path();
        if is_thumbnail_cache_file(&path) {
            let file_name = directory_entry.file_name().to_string_lossy().to_string();
            if !referenced_files.contains(&file_name) {
                fs::remove_file(&path).map_err(|error| {
                    format!(
                        "Unable to remove orphan thumbnail {}: {error}",
                        path_string(&path)
                    )
                })?;
                changed = true;
                orphan_files += 1;
            }
        }
    }

    let mut cached_entries = index
        .entries
        .iter()
        .filter_map(|(source_key, entry)| {
            let thumbnail = entry.thumbnail.as_ref()?;
            thumbnail_entry_path(thumbnail_cache_dir, thumbnail).and_then(|thumbnail_path| {
                match fs::metadata(&thumbnail_path) {
                    Ok(metadata) => Some((
                        source_key.clone(),
                        thumbnail.last_accessed_at.max(entry.modified_at),
                        metadata.len(),
                        thumbnail_path,
                    )),
                    Err(error) => {
                        log::warn!(
                            "Unable to inspect cached thumbnail size; excluding it from LRU accounting: path={}, error={error}",
                            path_string(&thumbnail_path)
                        );
                        None
                    }
                }
            })
        })
        .collect::<Vec<_>>();
    let mut total_size = cached_entries
        .iter()
        .map(|(_, _, size, _)| *size)
        .sum::<u64>();
    cached_entries.sort_by_key(|(_, last_accessed_at, _, _)| *last_accessed_at);
    for (source_key, _, size, thumbnail_path) in cached_entries {
        if total_size <= cache_limit_bytes {
            break;
        }
        fs::remove_file(&thumbnail_path).map_err(|error| {
            format!(
                "Unable to evict cached thumbnail {}: {error}",
                path_string(&thumbnail_path)
            )
        })?;
        let retain_metadata = index
            .entries
            .get(&source_key)
            .is_some_and(|entry| entry.metadata.is_some());
        if retain_metadata {
            if let Some(entry) = index.entries.get_mut(&source_key) {
                entry.thumbnail = None;
            }
        } else {
            index.entries.remove(&source_key);
        }
        total_size = total_size.saturating_sub(size);
        changed = true;
        evicted_files += 1;
    }

    if changed {
        persist_thumbnail_index_at(thumbnail_cache_dir, index)?;
        log::info!(
            "Media cache maintenance completed: entries_before={entries_before}, entries_after={}, invalid_entries={invalid_entries}, missing_thumbnails={missing_thumbnails}, orphan_files={orphan_files}, evicted_files={evicted_files}, thumbnail_bytes={total_size}, limit_bytes={cache_limit_bytes}",
            index.entries.len()
        );
    } else {
        log::debug!(
            "Media cache maintenance found no changes: entries={}, thumbnail_bytes={total_size}, limit_bytes={cache_limit_bytes}",
            index.entries.len()
        );
    }
    Ok(())
}

pub(super) fn cached_thumbnail_path(
    path: &Path,
    metadata: &fs::Metadata,
    thumbnail_index: &Arc<Mutex<MediaCacheIndex>>,
    thumbnail_cache_dir: &Path,
    capture_position: &str,
) -> Option<String> {
    let source_key = thumbnail_source_key(path);
    let modified_at = unix_millis(metadata.modified()).unwrap_or(0);
    let entry = match thumbnail_index.lock() {
        Ok(mut index) => {
            let entry = index.entries.get_mut(&source_key)?;
            let thumbnail = entry.thumbnail.as_mut()?;
            thumbnail.last_accessed_at = current_unix_millis();
            Some((entry.size, entry.modified_at, thumbnail.clone()))
        }
        Err(_) => {
            log::error!(
                "Unable to read thumbnail cache index; falling back to cache miss: path={}",
                path_string(path)
            );
            None
        }
    };
    if let Some((size, cached_modified_at, thumbnail)) = entry {
        if size != metadata.len()
            || cached_modified_at != modified_at
            || thumbnail.capture_position != thumbnail_capture_cache_key(capture_position)
        {
            log::debug!("Thumbnail index stale for {}.", path_string(path));
            return None;
        }

        let thumbnail_path = thumbnail_cache_dir.join(thumbnail.thumbnail_file);
        if thumbnail_path.is_file() {
            return Some(path_string(&thumbnail_path));
        }
        log::warn!(
            "Thumbnail index referenced a missing file; falling back to regeneration: video={}, thumbnail={}",
            path_string(path),
            path_string(&thumbnail_path)
        );
    }
    None
}

pub(super) fn cached_media_metadata(
    path: &Path,
    metadata: &fs::Metadata,
    media_cache: &Arc<Mutex<MediaCacheIndex>>,
) -> Option<CachedMediaMetadata> {
    let source_key = thumbnail_source_key(path);
    let modified_at = unix_millis(metadata.modified()).unwrap_or(0);
    let index = match media_cache.lock() {
        Ok(index) => index,
        Err(_) => {
            log::error!(
                "Unable to read media cache index; falling back to metadata probe: path={}",
                path_string(path)
            );
            return None;
        }
    };
    let entry = index.entries.get(&source_key)?;
    if entry.size != metadata.len() || entry.modified_at != modified_at {
        log::debug!("Media metadata cache stale: path={}", path_string(path));
        return None;
    }
    entry.metadata.clone()
}

pub(super) fn record_media_metadata(
    path: &Path,
    source_metadata: &fs::Metadata,
    metadata: &CachedMediaMetadata,
    media_cache: &ThumbnailCacheMaintenanceState,
) -> Result<(), String> {
    let _maintenance = media_cache
        .lock
        .lock()
        .map_err(|_| "Unable to access the media cache maintenance lock.".to_string())?;
    let source_key = thumbnail_source_key(path);
    let modified_at = unix_millis(source_metadata.modified()).unwrap_or(0);
    let mut index = media_cache
        .index
        .lock()
        .map_err(|_| "Unable to access the media cache index.".to_string())?;
    let entry = index.entries.entry(source_key).or_insert(MediaCacheEntry {
        size: source_metadata.len(),
        modified_at,
        thumbnail: None,
        metadata: None,
    });
    if entry.size != source_metadata.len() || entry.modified_at != modified_at {
        *entry = MediaCacheEntry {
            size: source_metadata.len(),
            modified_at,
            thumbnail: None,
            metadata: None,
        };
    }
    entry.metadata = Some(metadata.clone());
    persist_thumbnail_index_at(&media_cache.directory, &index)?;
    log::debug!(
        "Media metadata persisted: path={}, duration={:?}, width={:?}, height={:?}",
        path_string(path),
        metadata.duration,
        metadata.width,
        metadata.height
    );
    Ok(())
}

pub(super) fn record_thumbnail_cache(
    path: &Path,
    metadata: &fs::Metadata,
    thumbnail_path: &Path,
    thumbnail_index: &Arc<Mutex<MediaCacheIndex>>,
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
    let entry = index.entries.entry(source_key).or_insert(MediaCacheEntry {
        size: metadata.len(),
        modified_at,
        thumbnail: None,
        metadata: None,
    });
    if entry.size != metadata.len() || entry.modified_at != modified_at {
        *entry = MediaCacheEntry {
            size: metadata.len(),
            modified_at,
            thumbnail: None,
            metadata: None,
        };
    }
    entry.thumbnail = Some(CachedThumbnail {
        capture_position: thumbnail_capture_cache_key(capture_position).to_string(),
        thumbnail_file,
        last_accessed_at: current_unix_millis(),
    });
    if persist_immediately {
        persist_thumbnail_index(&index)?;
    }
    log::debug!(
        "Thumbnail cache entry recorded: path={}, thumbnail={}, capture_position={}, persisted={persist_immediately}",
        path_string(path),
        path_string(thumbnail_path),
        capture_position
    );
    Ok(())
}

pub(super) fn remove_thumbnail_cache_entry(
    path: &Path,
    thumbnail_index: &Arc<Mutex<MediaCacheIndex>>,
) -> Result<(), String> {
    let source_key = thumbnail_source_key(path);
    let mut index = thumbnail_index
        .lock()
        .map_err(|_| "Unable to access the thumbnail index.".to_string())?;
    let changed = if let Some(entry) = index.entries.get_mut(&source_key) {
        let changed = entry.thumbnail.take().is_some();
        if entry.metadata.is_none() {
            index.entries.remove(&source_key);
        }
        changed
    } else {
        false
    };
    if changed {
        persist_thumbnail_index(&index)?;
        log::debug!("Thumbnail cache entry removed: path={}", path_string(path));
    }
    Ok(())
}
