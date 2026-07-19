use super::*;
use tauri::Manager;

const LOG_RETENTION_DAYS: u64 = 30;
const DIAGNOSTIC_LOG_TAIL_BYTES: usize = 64 * 1024;
static ABOUT_INFO_CACHE: OnceLock<AboutInfo> = OnceLock::new();

fn directory_size(path: &Path) -> Result<u64, String> {
    if !path.exists() {
        return Ok(0);
    }
    let mut total = 0_u64;
    for entry in fs::read_dir(path)
        .map_err(|error| format!("Unable to inspect {}: {error}", path_string(path)))?
    {
        let entry = entry.map_err(|error| format!("Unable to read a data entry: {error}"))?;
        let metadata = entry
            .metadata()
            .map_err(|error| format!("Unable to inspect a data entry: {error}"))?;
        if metadata.is_dir() {
            total = total.saturating_add(directory_size(&entry.path())?);
        } else if metadata.is_file() {
            total = total.saturating_add(metadata.len());
        }
    }
    Ok(total)
}

fn managed_background_path(file_name: &str) -> Result<PathBuf, String> {
    let name = Path::new(file_name)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| *value == file_name)
        .ok_or_else(|| "The background image path is invalid.".to_string())?;
    Ok(backgrounds_dir()?.join(name))
}

pub(super) fn remove_managed_background(file_name: &str) {
    match managed_background_path(file_name) {
        Ok(path) if path.exists() => {
            if let Err(error) = fs::remove_file(&path) {
                log::warn!(
                    "Unable to remove replaced managed background: path={}, error={error}",
                    path_string(&path)
                );
            }
        }
        Ok(_) => {}
        Err(error) => log::warn!("Skipped invalid managed background cleanup: {error}"),
    }
}

#[tauri::command]
pub(super) fn get_data_management_summary() -> Result<DataManagementSummary, String> {
    let data = app_data_dir()?;
    let thumbnail_bytes = directory_size(&thumbnail_cache_dir()?)?;
    let log_bytes = directory_size(&log_dir()?)?;
    let background_bytes = directory_size(&backgrounds_dir()?)?;
    Ok(DataManagementSummary {
        data_path: path_string(&data),
        thumbnail_bytes,
        log_bytes,
        background_bytes,
        total_bytes: directory_size(&data)?,
    })
}

#[tauri::command]
pub(super) fn import_background_image(
    source_path: String,
) -> Result<BackgroundImportResult, String> {
    let source = fs::canonicalize(source_path)
        .map_err(|error| format!("Unable to access the background image: {error}"))?;
    if !fs::metadata(&source)
        .map_err(|error| format!("Unable to inspect the background image: {error}"))?
        .is_file()
    {
        return Err("The selected background must be a file.".to_string());
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|value| matches!(value.as_str(), "png" | "jpg" | "jpeg" | "webp"))
        .ok_or_else(|| "Background images must be PNG, JPEG, or WebP files.".to_string())?;
    let file_name = format!(
        "background-{}-{}.{}",
        std::process::id(),
        current_unix_millis(),
        extension
    );
    let destination = managed_background_path(&file_name)?;
    fs::copy(&source, &destination)
        .map_err(|error| format!("Unable to copy the background image: {error}"))?;
    log::info!(
        "Imported managed background image: {}",
        path_string(&destination)
    );
    Ok(BackgroundImportResult { file_name })
}

#[tauri::command]
pub(super) fn read_background_image(file_name: String) -> Result<String, String> {
    let path = managed_background_path(&file_name)?;
    let bytes =
        fs::read(&path).map_err(|error| format!("Unable to read the background image: {error}"))?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("png");
    let mime = if extension.eq_ignore_ascii_case("webp") {
        "image/webp"
    } else if extension.eq_ignore_ascii_case("png") {
        "image/png"
    } else {
        "image/jpeg"
    };
    Ok(format!(
        "data:{mime};base64,{}",
        BASE64_STANDARD.encode(bytes)
    ))
}

#[tauri::command]
pub(super) fn clear_thumbnail_cache(
    cache: tauri::State<'_, ThumbnailCacheMaintenanceState>,
) -> Result<(), String> {
    let _maintenance = cache
        .lock
        .lock()
        .map_err(|_| "Unable to access the thumbnail cache lock.".to_string())?;
    for entry in fs::read_dir(&cache.directory)
        .map_err(|error| format!("Unable to read the thumbnail cache: {error}"))?
    {
        let path = entry
            .map_err(|error| format!("Unable to read a thumbnail cache entry: {error}"))?
            .path();
        if path.is_file() {
            fs::remove_file(&path)
                .map_err(|error| format!("Unable to remove a thumbnail cache file: {error}"))?;
        }
    }
    let mut index = cache
        .index
        .lock()
        .map_err(|_| "Unable to access the thumbnail cache index.".to_string())?;
    *index = MediaCacheIndex::default();
    persist_thumbnail_index_at(&cache.directory, &index)?;
    log::info!("Thumbnail cache cleared and index rebuilt from an empty state");
    Ok(())
}

#[tauri::command]
pub(super) fn clear_old_logs() -> Result<u64, String> {
    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(LOG_RETENTION_DAYS * 24 * 60 * 60))
        .unwrap_or(UNIX_EPOCH);
    let current = log_path()?;
    let mut removed = 0;
    for entry in fs::read_dir(log_dir()?)
        .map_err(|error| format!("Unable to read the log directory: {error}"))?
    {
        let path = entry
            .map_err(|error| format!("Unable to read a log entry: {error}"))?
            .path();
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("Unable to inspect a log entry: {error}"))?;
        if path != current
            && metadata.is_file()
            && metadata.modified().is_ok_and(|modified| modified < cutoff)
        {
            fs::remove_file(path)
                .map_err(|error| format!("Unable to remove an old log: {error}"))?;
            removed += 1;
        }
    }
    Ok(removed)
}

#[tauri::command]
pub(super) fn get_about_info(app_handle: tauri::AppHandle) -> Result<AboutInfo, String> {
    if let Some(cached) = ABOUT_INFO_CACHE.get() {
        return Ok(cached.clone());
    }
    let mut sidecars = HashMap::new();
    for name in ["ffmpeg", "ffprobe", "ffmpegthumbnailer"] {
        let version = resolve_sidecar(name)
            .ok()
            .and_then(|path| Command::new(path).arg("-version").output().ok())
            .map(|output| {
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .next()
                    .unwrap_or("unknown")
                    .to_string()
            })
            .unwrap_or_else(|| "unavailable".to_string());
        sidecars.insert(name.to_string(), version);
    }
    let licenses = app_handle
        .path()
        .resource_dir()
        .ok()
        .map(|path| path.join("LICENSES"))
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|path| path.parent().map(|parent| parent.join("LICENSES")))
        })
        .filter(|path| path.exists())
        .map(|path| path_string(&path));
    let info = AboutInfo {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        data_path: path_string(&app_data_dir()?),
        licenses_path: licenses,
        sidecars,
    };
    let _ = ABOUT_INFO_CACHE.set(info.clone());
    Ok(info)
}

#[tauri::command]
pub(super) fn export_diagnostics() -> Result<String, String> {
    let config = load_config()?;
    let log_bytes = fs::read(log_path()?).unwrap_or_default();
    let start = log_bytes.len().saturating_sub(DIAGNOSTIC_LOG_TAIL_BYTES);
    let document = serde_json::json!({
        "appVersion": env!("CARGO_PKG_VERSION"),
        "generatedAt": current_unix_millis(),
        "platform": std::env::consts::OS,
        "settings": { "appearance": config.settings.appearance, "autoplay": config.settings.autoplay, "muted": config.settings.muted, "thumbnailCacheGb": config.settings.thumbnail_cache_gb, "backgroundSidecarConcurrency": config.settings.background_sidecar_concurrency },
        "recentLog": String::from_utf8_lossy(&log_bytes[start..]),
    });
    let path = diagnostics_dir()?.join(format!("diagnostic-{}.json", current_unix_millis()));
    fs::write(
        &path,
        serde_json::to_vec_pretty(&document)
            .map_err(|error| format!("Unable to serialize diagnostics: {error}"))?,
    )
    .map_err(|error| format!("Unable to export diagnostics: {error}"))?;
    Ok(path_string(&path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_background_name_rejects_parent_traversal() {
        assert!(managed_background_path("..\\outside.png").is_err());
        assert!(managed_background_path("nested/background.png").is_err());
    }

    #[test]
    fn diagnostic_tail_never_needs_more_than_its_limit() {
        let bytes = vec![b'x'; DIAGNOSTIC_LOG_TAIL_BYTES + 10];
        let start = bytes.len().saturating_sub(DIAGNOSTIC_LOG_TAIL_BYTES);
        assert_eq!(bytes[start..].len(), DIAGNOSTIC_LOG_TAIL_BYTES);
    }
}
