use super::*;

fn thumbnail_capture_time(position: &str) -> &str {
    match position {
        "opening" => "00:00:01",
        "early" => "25%",
        "late" => "75%",
        "ending" => "90%",
        _ => "50%",
    }
}

fn thumbnail_capture_fraction(position: &str) -> f64 {
    match position {
        "early" => 0.25,
        "late" => 0.75,
        "ending" => 0.90,
        _ => 0.50,
    }
}

pub(super) fn thumbnail_capture_cache_key(position: &str) -> &str {
    // The generator is part of the cache identity so old ffmpeg frames are regenerated.
    domain::thumbnail_capture_cache_key(position)
}

fn render_thumbnail(
    thumbnailer: &Path,
    video_path: &Path,
    output_path: &Path,
    capture_time: &str,
) -> Result<bool, String> {
    let _ = fs::remove_file(output_path);
    let mut command = Command::new(thumbnailer);
    configure_sidecar_command(&mut command);
    let mut child = command
        .args(["-i"])
        .arg(video_path)
        .args(["-o"])
        .arg(output_path)
        .args(["-s", "480", "-t", capture_time, "-q", "7", "-c", "jpeg"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Unable to start ffmpegthumbnailer: {error}"))?;

    wait_for_child(&mut child, Duration::from_secs(30))?;
    Ok(output_path.is_file())
}

fn probe_duration(video_path: &Path) -> Option<f64> {
    let ffprobe = resolve_sidecar("ffprobe").ok()?;
    let mut command = Command::new(ffprobe);
    configure_sidecar_command(&mut command);
    let output = command
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(video_path)
        .output()
        .ok()?;
    if !output.status.success() {
        log::warn!(
            "ffprobe failed for {}: {}",
            path_string(video_path),
            String::from_utf8_lossy(&output.stderr).trim()
        );
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|duration| duration.is_finite() && *duration > 0.0)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoMetadata {
    path: String,
    duration: Option<f64>,
    width: Option<u32>,
    height: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MetadataBatchResult {
    metadata: Vec<VideoMetadata>,
    failed_paths: Vec<String>,
}

fn probe_video_metadata(video_path: &Path) -> Result<VideoMetadata, String> {
    let ffprobe = resolve_sidecar("ffprobe")?;
    let mut command = Command::new(ffprobe);
    configure_sidecar_command(&mut command);
    let output = command
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "format=duration:stream=width,height",
            "-of",
            "json",
        ])
        .arg(video_path)
        .output()
        .map_err(|error| format!("Unable to start ffprobe: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let document: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Unable to read ffprobe metadata: {error}"))?;
    let duration = document
        .get("format")
        .and_then(|format| format.get("duration"))
        .and_then(|duration| duration.as_str())
        .and_then(|duration| duration.parse::<f64>().ok())
        .filter(|duration| duration.is_finite() && *duration > 0.0);
    let stream = document
        .get("streams")
        .and_then(|streams| streams.as_array())
        .and_then(|streams| streams.first());
    let width = stream
        .and_then(|stream| stream.get("width"))
        .and_then(|width| width.as_u64())
        .and_then(|width| u32::try_from(width).ok())
        .filter(|width| *width > 0);
    let height = stream
        .and_then(|stream| stream.get("height"))
        .and_then(|height| height.as_u64())
        .and_then(|height| u32::try_from(height).ok())
        .filter(|height| *height > 0);
    Ok(VideoMetadata {
        path: path_string(video_path),
        duration,
        width,
        height,
    })
}

pub(super) fn probe_video_metadata_batch(
    paths: Vec<String>,
    media_sidecar_pool: Arc<MediaSidecarPermits>,
) -> MetadataBatchResult {
    let workers = paths
        .into_iter()
        .map(|path| {
            let media_sidecar_pool = Arc::clone(&media_sidecar_pool);
            thread::spawn(move || {
                let source_path = path.clone();
                let result = (|| {
                    let _permit = media_sidecar_pool.acquire()?;
                    let video_path = fs::canonicalize(&path)
                        .map_err(|error| format!("Unable to access this video: {error}"))?;
                    probe_video_metadata(&video_path)
                })();
                (source_path, result)
            })
        })
        .collect::<Vec<_>>();
    let mut metadata = Vec::new();
    let mut failed_paths = Vec::new();
    for worker in workers {
        match worker.join() {
            Ok((_, Ok(result))) => metadata.push(result),
            Ok((path, Err(error))) => {
                log::warn!("Unable to probe video metadata for {path}: {error}");
                failed_paths.push(path);
            }
            Err(_) => failed_paths.push("<unknown>".to_string()),
        }
    }
    MetadataBatchResult {
        metadata,
        failed_paths,
    }
}

fn render_thumbnail_with_ffmpeg(
    video_path: &Path,
    output_path: &Path,
    capture_position: &str,
) -> Result<bool, String> {
    let ffmpeg = resolve_sidecar("ffmpeg")?;
    let timestamp = if capture_position == "opening" {
        1.0
    } else {
        probe_duration(video_path)
            .map(|duration| {
                (duration * thumbnail_capture_fraction(capture_position))
                    .min((duration - 0.05).max(0.0))
            })
            .unwrap_or(2.0)
    };
    let timestamp = format!("{timestamp:.3}");
    let _ = fs::remove_file(output_path);
    let mut command = Command::new(ffmpeg);
    configure_sidecar_command(&mut command);
    let mut child = command
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            &timestamp,
            "-i",
        ])
        .arg(video_path)
        .args([
            "-frames:v",
            "1",
            "-vf",
            "scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2",
            "-q:v",
            "7",
        ])
        .arg(output_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Unable to start FFmpeg fallback: {error}"))?;

    wait_for_child(&mut child, Duration::from_secs(30))?;
    Ok(output_path.is_file())
}

fn generate_thumbnail_impl(
    path: &Path,
    thumbnail_index: &Arc<Mutex<ThumbnailIndex>>,
    thumbnail_cache_dir: &Path,
    capture_position: &str,
    persist_immediately: bool,
) -> Result<PathBuf, String> {
    let video_path =
        fs::canonicalize(path).map_err(|error| format!("Unable to access this video: {error}"))?;
    let metadata = fs::metadata(&video_path)
        .map_err(|error| format!("Unable to inspect this video: {error}"))?;
    if !metadata.is_file() {
        return Err("The selected path is not a video file.".to_string());
    }

    if let Some(thumbnail_path) = cached_thumbnail_path(
        &video_path,
        &metadata,
        thumbnail_index,
        thumbnail_cache_dir,
        capture_position,
    ) {
        log::debug!(
            "Thumbnail cache hit for {} -> {}",
            path_string(&video_path),
            thumbnail_path
        );
        return Ok(PathBuf::from(thumbnail_path));
    }
    let thumbnail_path = thumbnail_path_for(&video_path)?;

    log::info!(
        "Generating thumbnail for {} -> {}",
        path_string(&video_path),
        path_string(&thumbnail_path)
    );
    let thumbnailer = resolve_sidecar("ffmpegthumbnailer")?;
    let capture_time = thumbnail_capture_time(capture_position);
    let temporary_path = thumbnail_path.with_extension("tmp.jpg");
    let generated = match render_thumbnail(&thumbnailer, &video_path, &temporary_path, capture_time)
    {
        Ok(true) => true,
        Ok(false) => {
            log::warn!(
                "ffmpegthumbnailer produced no image for {}; using FFmpeg fallback.",
                path_string(&video_path)
            );
            render_thumbnail_with_ffmpeg(&video_path, &temporary_path, capture_position)?
        }
        Err(error) => {
            log::warn!(
                "ffmpegthumbnailer failed for {}; using FFmpeg fallback: {}",
                path_string(&video_path),
                error
            );
            render_thumbnail_with_ffmpeg(&video_path, &temporary_path, capture_position)?
        }
    };
    if !generated {
        let error =
            "Neither ffmpegthumbnailer nor the FFmpeg fallback created a thumbnail.".to_string();
        log::error!(
            "Thumbnail generation failed for {}: {}",
            path_string(&video_path),
            error
        );
        return Err(error);
    }
    if thumbnail_path.exists() {
        fs::remove_file(&thumbnail_path)
            .map_err(|error| format!("Unable to replace the cached thumbnail: {error}"))?;
    }
    fs::rename(&temporary_path, &thumbnail_path)
        .map_err(|error| format!("Unable to store the cached thumbnail: {error}"))?;
    record_thumbnail_cache(
        &video_path,
        &metadata,
        &thumbnail_path,
        thumbnail_index,
        capture_position,
        persist_immediately,
    )?;
    log::info!(
        "Thumbnail generated for {} -> {}",
        path_string(&video_path),
        path_string(&thumbnail_path)
    );
    Ok(thumbnail_path)
}

pub(super) fn generate_thumbnail_batch_impl(
    paths: Vec<String>,
    media_sidecar_pool: Arc<MediaSidecarPermits>,
    thumbnail_index: Arc<Mutex<ThumbnailIndex>>,
    thumbnail_cache_dir: PathBuf,
    capture_position: String,
    app_handle: tauri::AppHandle,
) -> Result<ThumbnailBatchResult, String> {
    if paths.len() > MAX_PARALLEL_THUMBNAIL_TASKS {
        return Err(format!(
            "A thumbnail batch may contain at most {MAX_PARALLEL_THUMBNAIL_TASKS} videos."
        ));
    }

    let workers = paths
        .into_iter()
        .map(|path| {
            let media_sidecar_pool = Arc::clone(&media_sidecar_pool);
            let thumbnail_index = Arc::clone(&thumbnail_index);
            let thumbnail_cache_dir = thumbnail_cache_dir.clone();
            let capture_position = capture_position.clone();
            let app_handle = app_handle.clone();
            thread::spawn(move || {
                let source_path = path.clone();
                let result = (|| {
                    let _permit = media_sidecar_pool.acquire()?;
                    let video_path = fs::canonicalize(&path)
                        .map_err(|error| format!("Unable to access this video: {error}"))?;
                    let thumbnail_path = generate_thumbnail_impl(
                        &video_path,
                        &thumbnail_index,
                        &thumbnail_cache_dir,
                        &capture_position,
                        false,
                    )?;
                    Ok(ThumbnailResult {
                        path: path_string(&video_path),
                        thumbnail_path: path_string(&thumbnail_path),
                    })
                })();
                if let Ok(thumbnail) = &result {
                    // The JPEG and in-memory index are ready now; persist the index once after the batch.
                    let _ = app_handle.emit("thumbnail-generated", thumbnail.clone());
                }
                (source_path, result)
            })
        })
        .collect::<Vec<_>>();

    let mut thumbnails = Vec::new();
    let mut failures = Vec::new();
    for worker in workers {
        match worker.join() {
            Ok((_, Ok(result))) => thumbnails.push(result),
            Ok((path, Err(error))) => failures.push(ThumbnailFailure { path, error }),
            Err(_) => failures.push(ThumbnailFailure {
                path: "<unknown>".to_string(),
                error: "The thumbnail worker panicked.".to_string(),
            }),
        }
    }

    if !thumbnails.is_empty() {
        let index = thumbnail_index
            .lock()
            .map_err(|_| "Unable to access the thumbnail index.".to_string())?;
        persist_thumbnail_index(&index)?;
    }

    Ok(ThumbnailBatchResult {
        thumbnails,
        failures,
    })
}

pub(super) fn thumbnail_data_impl(
    path: &Path,
    thumbnail_index: &Arc<Mutex<ThumbnailIndex>>,
    thumbnail_cache_dir: &Path,
    capture_position: &str,
) -> Result<ThumbnailData, String> {
    let video_path =
        fs::canonicalize(path).map_err(|error| format!("Unable to access this video: {error}"))?;
    let metadata = fs::metadata(&video_path)
        .map_err(|error| format!("Unable to inspect this video: {error}"))?;
    let thumbnail_path = cached_thumbnail_path(
        &video_path,
        &metadata,
        thumbnail_index,
        thumbnail_cache_dir,
        capture_position,
    )
    .map(PathBuf::from)
    .ok_or_else(|| "No valid cached thumbnail is available for this video.".to_string())?;
    let bytes = match fs::read(&thumbnail_path) {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = remove_thumbnail_cache_entry(&video_path, thumbnail_index);
            return Err(format!(
                "Unable to read the cached thumbnail {}: {error}",
                path_string(&thumbnail_path)
            ));
        }
    };

    Ok(ThumbnailData {
        path: path_string(&video_path),
        thumbnail_path: path_string(&thumbnail_path),
        data_url: format!("data:image/jpeg;base64,{}", BASE64_STANDARD.encode(bytes)),
    })
}
