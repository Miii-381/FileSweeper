use super::*;

fn decode_text_preview(bytes: &[u8]) -> Result<(String, &'static str), String> {
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return String::from_utf8(bytes[3..].to_vec())
            .map(|text| (text, "UTF-8 BOM"))
            .map_err(|_| "UTF-8 内容无效".to_string());
    }
    if bytes.starts_with(&[0xff, 0xfe]) {
        let units = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16(&units)
            .map(|text| (text, "UTF-16 LE"))
            .map_err(|_| "UTF-16 LE 内容无效".to_string());
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        let units = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16(&units)
            .map(|text| (text, "UTF-16 BE"))
            .map_err(|_| "UTF-16 BE 内容无效".to_string());
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Ok((text.to_string(), "UTF-8"));
    }
    if bytes.contains(&0) {
        return Err("文件包含二进制数据".to_string());
    }
    #[cfg(target_os = "windows")]
    let encoding = match unsafe { windows::Win32::Globalization::GetACP() } {
        936 => encoding_rs::GBK,
        932 => encoding_rs::SHIFT_JIS,
        949 => encoding_rs::EUC_KR,
        _ => encoding_rs::WINDOWS_1252,
    };
    #[cfg(not(target_os = "windows"))]
    let encoding = encoding_rs::WINDOWS_1252;
    let (text, _, had_errors) = encoding.decode(bytes);
    if had_errors {
        return Err("系统 ANSI 代码页无法解码此文件".to_string());
    }
    Ok((text.into_owned(), "系统 ANSI"))
}

#[tauri::command]
pub(super) async fn read_text_preview(path: String) -> Result<TextPreviewData, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = media_stream::resolve_stream_file_path(&path)?;
        read_text_preview_file(&file)
    })
    .await
    .map_err(|error| format!("The text preview worker failed: {error}"))?
}

fn read_text_preview_file(file: &Path) -> Result<TextPreviewData, String> {
    let metadata =
        fs::metadata(file).map_err(|error| format!("Unable to inspect the text file: {error}"))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(file)
        .and_then(|mut handle| handle.read_to_end(&mut bytes))
        .map_err(|error| format!("Unable to read the text file: {error}"))?;
    match decode_text_preview(&bytes) {
        Ok((content, encoding)) => Ok(TextPreviewData {
            content,
            encoding: encoding.to_string(),
            total_bytes: metadata.len(),
            readable: true,
            reason: None,
        }),
        Err(reason) => Ok(TextPreviewData {
            content: String::new(),
            encoding: "unknown".to_string(),
            total_bytes: metadata.len(),
            readable: false,
            reason: Some(reason),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_preview_reads_the_complete_file() {
        let path = std::env::temp_dir().join(format!(
            "file-sweeper-text-preview-{}-{}.html",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let source_len = 6 * 1024 * 1024;
        fs::write(&path, vec![b'x'; source_len]).unwrap();

        let preview = read_text_preview_file(&path).unwrap();
        fs::remove_file(path).unwrap();

        assert!(preview.readable);
        assert_eq!(preview.total_bytes, source_len as u64);
        assert_eq!(preview.content.len(), source_len);
    }
}

#[tauri::command]
pub(super) async fn inspect_image_preview(path: String) -> Result<ImagePreviewInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = media_stream::resolve_stream_file_path(&path)?;
        let settings = load_config()?.settings;
        let metadata =
            fs::metadata(&file).map_err(|error| format!("Unable to inspect the image: {error}"))?;
        if metadata.len() > u64::from(settings.image_max_megabytes) * 1024 * 1024 {
            return Ok(ImagePreviewInfo {
                width: 0,
                height: 0,
                allowed: false,
                reason: Some(format!(
                    "图片超过 {} MiB 保护上限",
                    settings.image_max_megabytes
                )),
            });
        }
        let dimensions = media_processing::open_image_reader_by_content(&file)?
            .into_dimensions()
            .map_err(|error| format!("Unable to read image dimensions: {error}"))?;
        let pixels = u64::from(dimensions.0) * u64::from(dimensions.1);
        let maximum = u64::from(settings.image_max_megapixels) * 1_000_000;
        Ok(ImagePreviewInfo {
            width: dimensions.0,
            height: dimensions.1,
            allowed: pixels <= maximum,
            reason: (pixels > maximum)
                .then(|| format!("图片超过 {} MP 像素保护上限", settings.image_max_megapixels)),
        })
    })
    .await
    .map_err(|error| format!("The image inspector worker failed: {error}"))?
}

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
pub(super) async fn generate_image_thumbnails(
    paths: Vec<String>,
    app_handle: tauri::AppHandle,
    thumbnail_cache: tauri::State<'_, ThumbnailCacheMaintenanceState>,
) -> Result<ThumbnailBatchResult, String> {
    let cache = thumbnail_cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let settings = load_config()?.settings;
        media_processing::generate_image_thumbnail_batch_impl(
            paths,
            cache,
            thumbnail_cache_limit_bytes(settings.thumbnail_cache_gb),
            app_handle,
        )
    })
    .await
    .map_err(|error| format!("The image thumbnail worker failed: {error}"))?
}

#[tauri::command]
pub(super) async fn generate_audio_thumbnails(
    paths: Vec<String>,
    app_handle: tauri::AppHandle,
    thumbnail_cache: tauri::State<'_, ThumbnailCacheMaintenanceState>,
) -> Result<ThumbnailBatchResult, String> {
    let cache = thumbnail_cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let settings = load_config()?.settings;
        media_processing::generate_audio_thumbnail_batch_impl(
            paths,
            cache,
            thumbnail_cache_limit_bytes(settings.thumbnail_cache_gb),
            app_handle,
        )
    })
    .await
    .map_err(|error| format!("The audio thumbnail worker failed: {error}"))?
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
        let settings = load_config()?.settings;
        let extension = domain::normalized_file_extension(Path::new(&path));
        let capture_position = if settings
            .audio_extensions
            .iter()
            .any(|item| item == &extension)
        {
            "audio-cover-v1".to_string()
        } else if settings
            .image_extensions
            .iter()
            .any(|item| item == &extension)
        {
            "image-v1".to_string()
        } else {
            settings.thumbnail_capture_position
        };
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
pub(super) async fn read_audio_embedded_cover(path: String) -> Result<String, String> {
    let log_path = path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let audio_path = media_stream::resolve_stream_audio_path(&path)?;
        media_processing::embedded_audio_cover_data_url(&audio_path)
    })
    .await
    .map_err(|error| {
        log::error!("Embedded audio cover reader worker failed: path={log_path}, error={error}");
        format!("The embedded audio cover reader failed: {error}")
    })?;
    match &result {
        Ok(data_url) => log::debug!(
            "Original embedded audio cover read completed: path={log_path}, data_url_bytes={}",
            data_url.len()
        ),
        Err(error) => {
            log::warn!("Original embedded audio cover read failed: path={log_path}, error={error}")
        }
    }
    result
}

#[tauri::command]
pub(super) fn get_preview_file_url(
    path: String,
    video_stream_server: tauri::State<VideoStreamServer>,
) -> Result<String, String> {
    let file = media_stream::resolve_stream_file_path(&path)?;
    let base_url = video_stream_server
        .base_url
        .as_ref()
        .ok_or_else(|| "The local preview service is unavailable.".to_string())?;
    Ok(format!(
        "{base_url}?path={}",
        domain::encode_url_component(&path_string(&file))
    ))
}

#[tauri::command]
pub(super) fn get_audio_stream_url(
    path: String,
    force_transcode: Option<bool>,
    video_stream_server: tauri::State<VideoStreamServer>,
) -> Result<String, String> {
    log::debug!(
        "Audio stream URL requested: path={path}, force_transcode={}",
        force_transcode.unwrap_or(false)
    );
    let audio = media_stream::resolve_stream_audio_path(&path)?;
    let base_url = video_stream_server
        .base_url
        .as_ref()
        .ok_or_else(|| "The local audio preview service is unavailable.".to_string())?;
    let mode = if force_transcode.unwrap_or(false) {
        "&mode=audio"
    } else {
        ""
    };
    let url = format!(
        "{base_url}?path={}{}",
        domain::encode_url_component(&path_string(&audio)),
        mode
    );
    log::debug!(
        "Audio stream URL created: path={}, transcode={}",
        path_string(&audio),
        force_transcode.unwrap_or(false)
    );
    Ok(url)
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
                domain::encode_url_component(&path_string(&video_path)),
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
