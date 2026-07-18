use super::*;

#[tauri::command]
pub(super) async fn generate_thumbnails(
    paths: Vec<String>,
    app_handle: tauri::AppHandle,
    media_sidecar_pool: tauri::State<'_, MediaSidecarPool>,
    thumbnail_cache: tauri::State<'_, ThumbnailCacheMaintenanceState>,
) -> Result<ThumbnailBatchResult, String> {
    let requested = paths.len();
    if paths.is_empty() {
        log::debug!("Thumbnail batch skipped because no paths were requested");
        return Ok(ThumbnailBatchResult {
            thumbnails: Vec::new(),
            failures: Vec::new(),
        });
    }
    let media_sidecar_pool = Arc::clone(&media_sidecar_pool.0);
    let thumbnail_cache = thumbnail_cache.inner().clone();
    log::info!("Thumbnail batch requested: items={requested}");
    let result = tauri::async_runtime::spawn_blocking(move || {
        let settings = load_config()?.settings;
        generate_thumbnail_batch_impl(
            paths,
            media_sidecar_pool,
            thumbnail_cache,
            settings.thumbnail_capture_position,
            thumbnail_cache_limit_bytes(settings.thumbnail_cache_gb),
            app_handle,
        )
    })
    .await
    .map_err(|error| {
        log::error!("Thumbnail batch worker failed: items={requested}, error={error}");
        format!("The thumbnail worker failed: {error}")
    })?;
    match &result {
        Ok(batch) => log::info!(
            "Thumbnail batch completed: requested={requested}, generated={}, failed={}",
            batch.thumbnails.len(),
            batch.failures.len()
        ),
        Err(error) => log::error!("Thumbnail batch failed: requested={requested}, error={error}"),
    }
    result
}

#[tauri::command]
pub(super) async fn probe_video_metadata_batch_command(
    paths: Vec<String>,
    media_sidecar_pool: tauri::State<'_, MediaSidecarPool>,
    media_cache: tauri::State<'_, ThumbnailCacheMaintenanceState>,
) -> Result<MetadataBatchResult, String> {
    let requested = paths.len();
    if requested == 0 {
        log::debug!("Metadata batch requested with no paths");
    } else {
        log::info!("Metadata batch requested: items={requested}");
    }
    let media_sidecar_pool = Arc::clone(&media_sidecar_pool.0);
    let media_cache = media_cache.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        probe_video_metadata_batch(paths, media_sidecar_pool, media_cache)
    })
    .await
    .map_err(|error| {
        log::error!("Metadata batch worker failed: items={requested}, error={error}");
        format!("The metadata worker failed: {error}")
    })?;
    log::info!(
        "Metadata batch completed: requested={requested}, succeeded={}, failed={}",
        result.metadata.len(),
        result.failed_paths.len()
    );
    Ok(result)
}

#[tauri::command]
pub(super) async fn read_thumbnail(
    path: String,
    thumbnail_index: tauri::State<'_, MediaCacheIndexState>,
    thumbnail_cache_directory: tauri::State<'_, ThumbnailCacheDirectory>,
) -> Result<ThumbnailData, String> {
    let log_path = path.clone();
    let thumbnail_index = Arc::clone(&thumbnail_index.0);
    let thumbnail_cache_dir = thumbnail_cache_directory.0.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let capture_position = load_config()?.settings.thumbnail_capture_position;
        thumbnail_data_impl(
            Path::new(&path),
            &thumbnail_index,
            &thumbnail_cache_dir,
            &capture_position,
        )
    })
    .await
    .map_err(|error| {
        log::error!("Thumbnail reader worker failed: path={log_path}, error={error}");
        format!("The thumbnail reader failed: {error}")
    })?;
    match &result {
        Ok(data) => log::debug!(
            "Thumbnail cache read completed: video={}, thumbnail={}",
            data.path,
            data.thumbnail_path
        ),
        Err(error) => log::warn!("Thumbnail cache read failed: path={log_path}, error={error}"),
    }
    result
}

#[tauri::command]
pub(super) fn get_video_stream_url(
    path: String,
    start_seconds: Option<f64>,
    force_transcode: Option<bool>,
    known_duration: Option<f64>,
    video_stream_server: tauri::State<VideoStreamServer>,
    media_cache: tauri::State<'_, ThumbnailCacheMaintenanceState>,
) -> Result<VideoStreamUrl, String> {
    let is_transcoded = force_transcode.unwrap_or(false);
    let log_path = path.clone();
    log::debug!(
        "Video stream URL requested: path={log_path}, transcode={is_transcoded}, start={:?}, known_duration={:?}",
        start_seconds,
        known_duration
    );
    let result = (|| {
        let video_path = media_stream::resolve_stream_video_path(&path)?;
        let duration = if is_transcoded {
            if let Some(duration) =
                known_duration.filter(|duration| duration.is_finite() && *duration > 0.0)
            {
                log::debug!(
                    "Using caller-provided preview duration: path={}, duration={duration}",
                    path_string(&video_path)
                );
                Some(duration)
            } else if let Some(duration) = match fs::metadata(&video_path) {
                Ok(source_metadata) => {
                    cached_media_metadata(&video_path, &source_metadata, &media_cache.index)
                        .and_then(|metadata| metadata.duration)
                }
                Err(error) => {
                    log::warn!(
                        "Unable to inspect preview source for cached duration; falling back to direct ffprobe: path={}, error={error}",
                        path_string(&video_path)
                    );
                    None
                }
            } {
                log::debug!(
                    "Using cached preview duration: path={}, duration={duration}",
                    path_string(&video_path)
                );
                Some(duration)
            } else {
                log::warn!(
                "Preview duration cache miss; falling back to direct ffprobe outside the background pool: {}",
                path_string(&video_path)
            );
                match media_processing::probe_media_info(&video_path) {
                    Ok(metadata) => {
                        if let Ok(source_metadata) = fs::metadata(&video_path) {
                            let cached = CachedMediaMetadata {
                                duration: metadata.duration,
                                width: metadata.width,
                                height: metadata.height,
                            };
                            if let Err(error) = record_media_metadata(
                                &video_path,
                                &source_metadata,
                                &cached,
                                &media_cache,
                            ) {
                                log::warn!("Unable to cache FFmpeg preview metadata: {error}");
                            }
                        } else {
                            log::warn!(
                            "FFprobe preview metadata succeeded but source metadata could not be read for caching: {}",
                            path_string(&video_path)
                        );
                        }
                        metadata.duration
                    }
                    Err(error) => {
                        log::warn!(
                            "Unable to read the duration for FFmpeg preview {}: {error}",
                            path_string(&video_path)
                        );
                        None
                    }
                }
            }
        } else {
            None
        };
        let base_url = video_stream_server
            .base_url
            .as_ref()
            .ok_or_else(|| "The local video stream service is unavailable.".to_string())?;
        let start_seconds = start_seconds
            .filter(|start| start.is_finite() && *start > 0.0)
            .unwrap_or(0.0);
        let mode = if is_transcoded { "&mode=transcode" } else { "" };
        let start = if is_transcoded && start_seconds > 0.0 {
            format!("&start={start_seconds:.3}")
        } else {
            String::new()
        };
        Ok(VideoStreamUrl {
            url: format!(
                "{base_url}?path={}{}{}",
                media_stream::encode_query_component(&path_string(&video_path)),
                mode,
                start,
            ),
            is_transcoded,
            duration,
        })
    })();
    match &result {
        Ok(stream) => log::debug!(
            "Video stream URL created: path={log_path}, transcode={}, duration={:?}",
            stream.is_transcoded,
            stream.duration
        ),
        Err(error) => log::error!(
            "Video stream URL request failed: path={log_path}, transcode={is_transcoded}, error={error}"
        ),
    }
    result
}

#[tauri::command]
pub(super) async fn stop_transcoded_preview(
    path: String,
    video_stream_server: tauri::State<'_, VideoStreamServer>,
) -> Result<bool, String> {
    let log_path = path.clone();
    log::debug!("Stop transcoded preview requested: path={log_path}");
    let controller = Arc::clone(&video_stream_server.transcode_controller);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let video_path = match fs::canonicalize(&path) {
            Ok(path) => path,
            Err(error) => {
                log::warn!(
                    "Unable to canonicalize preview path during shutdown; falling back to the requested path: path={path}, error={error}"
                );
                PathBuf::from(path)
            }
        };
        controller.stop_video(&video_path)
    })
    .await
    .map_err(|error| {
        log::error!("FFmpeg shutdown worker failed: path={log_path}, error={error}");
        format!("The FFmpeg shutdown worker failed: {error}")
    })?;
    match &result {
        Ok(stopped) => {
            log::debug!("Stop transcoded preview completed: path={log_path}, stopped={stopped}")
        }
        Err(error) => log::error!("Stop transcoded preview failed: path={log_path}, error={error}"),
    }
    result
}
