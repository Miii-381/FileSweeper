use super::*;
pub(super) struct MediaSidecarPool(pub(super) Arc<MediaSidecarPermits>);

pub(super) struct MediaSidecarPermits {
    state: Mutex<MediaSidecarPoolState>,
    available_changed: Condvar,
}

struct MediaSidecarPoolState {
    in_flight: usize,
    limit: usize,
}

pub(super) struct MediaSidecarPermit {
    pool: Arc<MediaSidecarPermits>,
}

pub(super) fn open_image_reader_by_content(
    path: &Path,
) -> Result<image::ImageReader<std::io::BufReader<fs::File>>, String> {
    image::ImageReader::open(path)
        .map_err(|error| format!("Unable to open image: {error}"))?
        .with_guessed_format()
        .map_err(|error| format!("Unable to identify image format: {error}"))
}

impl MediaSidecarPermits {
    pub(super) fn new(maximum: usize) -> Self {
        let maximum = maximum.max(1);
        Self {
            state: Mutex::new(MediaSidecarPoolState {
                in_flight: 0,
                limit: maximum,
            }),
            available_changed: Condvar::new(),
        }
    }

    pub(super) fn acquire(self: &Arc<Self>) -> Result<MediaSidecarPermit, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Unable to access the media sidecar queue.".to_string())?;
        while state.in_flight >= state.limit {
            state = self
                .available_changed
                .wait(state)
                .map_err(|_| "Unable to access the media sidecar queue.".to_string())?;
        }
        state.in_flight += 1;
        Ok(MediaSidecarPermit {
            pool: Arc::clone(self),
        })
    }

    pub(super) fn set_limit(&self, limit: usize) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Unable to update the media sidecar limit.".to_string())?;
        let previous = state.limit;
        state.limit = limit.max(1);
        log::info!(
            "Background sidecar concurrency updated: previous={previous}, current={}, in_flight={}",
            state.limit,
            state.in_flight
        );
        self.available_changed.notify_all();
        Ok(())
    }

    pub(super) fn limit(&self) -> Result<usize, String> {
        self.state
            .lock()
            .map(|state| state.limit)
            .map_err(|_| "Unable to read the media sidecar limit.".to_string())
    }

    fn release(&self) {
        let Ok(mut state) = self.state.lock() else {
            log::error!(
                "Unable to release a background sidecar permit because the pool lock is poisoned"
            );
            return;
        };
        state.in_flight = state.in_flight.saturating_sub(1);
        self.available_changed.notify_all();
    }
}

impl Drop for MediaSidecarPermit {
    fn drop(&mut self) {
        self.pool.release();
    }
}

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

fn queued_media_path(queue: &Mutex<VecDeque<String>>, label: &str) -> Option<String> {
    match queue.lock() {
        Ok(mut queue) => queue.pop_front(),
        Err(_) => {
            log::error!("{label} queue lock was poisoned; the worker cannot continue");
            None
        }
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
    log::debug!(
        "Starting ffmpegthumbnailer: video={}, output={}, capture_time={capture_time}",
        path_string(video_path),
        path_string(output_path)
    );
    if output_path.exists() {
        fs::remove_file(output_path).map_err(|error| {
            format!(
                "Unable to remove the previous thumbnail output {}: {error}",
                path_string(output_path)
            )
        })?;
    }
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
    let generated = output_path.is_file();
    log::debug!(
        "ffmpegthumbnailer finished: video={}, generated={generated}",
        path_string(video_path)
    );
    Ok(generated)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VideoMetadata {
    pub(super) path: String,
    pub(super) duration: Option<f64>,
    pub(super) width: Option<u32>,
    pub(super) height: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MetadataBatchResult {
    pub(super) metadata: Vec<VideoMetadata>,
    pub(super) failed_paths: Vec<String>,
}

pub(super) fn probe_media_info(video_path: &Path) -> Result<VideoMetadata, String> {
    log::debug!(
        "Starting ffprobe metadata read: path={}",
        path_string(video_path)
    );
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
        let error = format!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
        log::warn!(
            "ffprobe metadata read failed: path={}, error={error}",
            path_string(video_path)
        );
        return Err(error);
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
    if duration.is_none() || width.is_none() || height.is_none() {
        log::warn!(
            "ffprobe completed with incomplete metadata: path={}, duration_present={}, width_present={}, height_present={}",
            path_string(video_path),
            duration.is_some(),
            width.is_some(),
            height.is_some()
        );
    }
    let metadata = VideoMetadata {
        path: path_string(video_path),
        duration,
        width,
        height,
    };
    log::debug!(
        "ffprobe metadata read completed: path={}, duration={:?}, width={:?}, height={:?}",
        metadata.path,
        metadata.duration,
        metadata.width,
        metadata.height
    );
    Ok(metadata)
}

pub(super) fn run_background_sidecar_with_retries<T>(
    media_sidecar_pool: &Arc<MediaSidecarPermits>,
    label: &str,
    mut operation: impl FnMut() -> Result<T, String>,
) -> Result<T, String> {
    const MAX_ATTEMPTS: usize = 3;
    let mut last_error = String::new();
    for attempt in 1..=MAX_ATTEMPTS {
        log::debug!("Waiting for background sidecar permit: label={label}, attempt={attempt}/{MAX_ATTEMPTS}");
        let permit = media_sidecar_pool.acquire()?;
        log::debug!(
            "Background sidecar attempt started: label={label}, attempt={attempt}/{MAX_ATTEMPTS}"
        );
        let result = operation();
        drop(permit);
        match result {
            Ok(value) => {
                log::debug!("Background sidecar attempt succeeded: label={label}, attempt={attempt}/{MAX_ATTEMPTS}");
                return Ok(value);
            }
            Err(error) => {
                last_error = error;
                log::warn!("{label} attempt {attempt}/{MAX_ATTEMPTS} failed: {last_error}");
                if attempt < MAX_ATTEMPTS {
                    log::debug!("Background sidecar permit released before retry delay: label={label}, next_attempt={}", attempt + 1);
                    thread::sleep(Duration::from_millis(100));
                }
            }
        }
    }
    Err(last_error)
}

pub(super) fn run_background_sidecar_once<T>(
    media_sidecar_pool: &Arc<MediaSidecarPermits>,
    label: &str,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    log::debug!("Waiting for background sidecar permit: label={label}, attempt=1/1");
    let permit = media_sidecar_pool.acquire()?;
    log::debug!("Background sidecar attempt started: label={label}, attempt=1/1");
    let result = operation();
    drop(permit);
    match result {
        Ok(value) => {
            log::debug!("Background sidecar attempt succeeded: label={label}, attempt=1/1");
            Ok(value)
        }
        Err(error) => {
            log::warn!("{label} attempt 1/1 failed: {error}");
            Err(error)
        }
    }
}

fn probe_and_cache_media_info(
    video_path: &Path,
    media_sidecar_pool: &Arc<MediaSidecarPermits>,
    media_cache: &ThumbnailCacheMaintenanceState,
) -> Result<VideoMetadata, String> {
    let source_metadata = fs::metadata(video_path)
        .map_err(|error| format!("Unable to inspect this video: {error}"))?;
    if let Some(cached) = cached_media_metadata(video_path, &source_metadata, &media_cache.index) {
        log::debug!("Media metadata cache hit: path={}", path_string(video_path));
        return Ok(VideoMetadata {
            path: path_string(video_path),
            duration: cached.duration,
            width: cached.width,
            height: cached.height,
        });
    }
    log::debug!(
        "Media metadata cache miss: path={}",
        path_string(video_path)
    );
    let label = format!("ffprobe {}", path_string(video_path));
    let metadata = run_background_sidecar_with_retries(media_sidecar_pool, &label, || {
        probe_media_info(video_path)
    })?;
    record_media_metadata(
        video_path,
        &source_metadata,
        &CachedMediaMetadata {
            duration: metadata.duration,
            width: metadata.width,
            height: metadata.height,
        },
        media_cache,
    )?;
    Ok(metadata)
}

pub(super) fn probe_video_metadata_batch(
    paths: Vec<String>,
    media_sidecar_pool: Arc<MediaSidecarPermits>,
    media_cache: ThumbnailCacheMaintenanceState,
) -> MetadataBatchResult {
    let requested = paths.len();
    let queue = Arc::new(Mutex::new(VecDeque::from(paths)));
    let limit = media_sidecar_pool.limit().unwrap_or_else(|error| {
        log::error!(
            "Unable to read sidecar limit for metadata batch; falling back to one worker: {error}"
        );
        1
    });
    let queued = queue.lock().map(|queue| queue.len()).unwrap_or_else(|_| {
        log::error!("Unable to read metadata batch queue length; starting no workers");
        0
    });
    let worker_count = limit.min(queued);
    log::info!("Metadata batch worker pool started: requested={requested}, workers={worker_count}");
    let workers = (0..worker_count)
        .map(|_| {
            let queue = Arc::clone(&queue);
            let media_sidecar_pool = Arc::clone(&media_sidecar_pool);
            let media_cache = media_cache.clone();
            thread::spawn(move || {
                let mut results = Vec::new();
                while let Some(path) = queued_media_path(&queue, "Metadata batch") {
                    let source_path = path.clone();
                    let result = (|| {
                        let video_path = fs::canonicalize(&path)
                            .map_err(|error| format!("Unable to access this video: {error}"))?;
                        probe_and_cache_media_info(&video_path, &media_sidecar_pool, &media_cache)
                    })();
                    results.push((source_path, result));
                }
                results
            })
        })
        .collect::<Vec<_>>();
    let mut metadata = Vec::new();
    let mut failed_paths = Vec::new();
    for worker in workers {
        match worker.join() {
            Ok(results) => {
                for (path, result) in results {
                    match result {
                        Ok(result) => metadata.push(result),
                        Err(error) => {
                            log::warn!("Unable to probe video metadata for {path}: {error}");
                            failed_paths.push(path);
                        }
                    }
                }
            }
            Err(_) => {
                log::error!("Metadata batch worker panicked");
                failed_paths.push("<unknown>".to_string());
            }
        }
    }
    log::info!(
        "Metadata batch worker pool completed: requested={requested}, succeeded={}, failed={}",
        metadata.len(),
        failed_paths.len()
    );
    MetadataBatchResult {
        metadata,
        failed_paths,
    }
}

fn render_thumbnail_with_ffmpeg(
    video_path: &Path,
    output_path: &Path,
    capture_position: &str,
    duration: Option<f64>,
) -> Result<bool, String> {
    let ffmpeg = resolve_sidecar("ffmpeg")?;
    let timestamp = if capture_position == "opening" {
        1.0
    } else {
        duration
            .map(|duration| {
                (duration * thumbnail_capture_fraction(capture_position))
                    .min((duration - 0.05).max(0.0))
            })
            .unwrap_or(2.0)
    };
    let timestamp = format!("{timestamp:.3}");
    log::info!(
        "Starting FFmpeg thumbnail fallback: video={}, timestamp={timestamp}, output={}",
        path_string(video_path),
        path_string(output_path)
    );
    if output_path.exists() {
        fs::remove_file(output_path).map_err(|error| {
            format!(
                "Unable to remove the previous FFmpeg fallback output {}: {error}",
                path_string(output_path)
            )
        })?;
    }
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
    let generated = output_path.is_file();
    log::info!(
        "FFmpeg thumbnail fallback completed: video={}, generated={generated}",
        path_string(video_path)
    );
    Ok(generated)
}

pub(super) fn remove_failed_thumbnail_output(path: &Path, stage: &str) {
    if !path.exists() {
        return;
    }
    match fs::remove_file(path) {
        Ok(()) => log::debug!(
            "Removed failed thumbnail temporary output: stage={stage}, path={}",
            path_string(path)
        ),
        Err(error) => log::warn!(
            "Unable to remove failed thumbnail temporary output: stage={stage}, path={}, error={error}",
            path_string(path)
        ),
    }
}

fn generate_thumbnail_impl(
    path: &Path,
    capture_position: &str,
    persist_immediately: bool,
    media_sidecar_pool: &Arc<MediaSidecarPermits>,
    thumbnail_cache: &ThumbnailCacheMaintenanceState,
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
        &thumbnail_cache.index,
        &thumbnail_cache.directory,
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
    let capture_time = thumbnail_capture_time(capture_position);
    let temporary_path = thumbnail_path.with_extension("tmp.jpg");
    let thumbnailer_result = match resolve_sidecar("ffmpegthumbnailer") {
        Ok(thumbnailer) => {
            run_background_sidecar_once(media_sidecar_pool, "ffmpegthumbnailer", || {
                match render_thumbnail(&thumbnailer, &video_path, &temporary_path, capture_time)? {
                    true => Ok(true),
                    false => Err("ffmpegthumbnailer produced no image.".to_string()),
                }
            })
        }
        Err(error) => Err(format!("Unable to resolve ffmpegthumbnailer: {error}")),
    };
    let generated = match thumbnailer_result {
        Ok(true) => true,
        Ok(false) => false,
        Err(error) => {
            log::warn!(
                "ffmpegthumbnailer was unavailable or failed after at most one attempt for {}; using FFmpeg fallback immediately: {}",
                path_string(&video_path),
                error
            );
            let duration = match probe_and_cache_media_info(
                &video_path,
                media_sidecar_pool,
                thumbnail_cache,
            ) {
                Ok(metadata) => {
                    if metadata.duration.is_none() {
                        log::warn!(
                                "Thumbnail fallback metadata has no duration; using the default fallback timestamp: video={}",
                                path_string(&video_path)
                            );
                    }
                    metadata.duration
                }
                Err(probe_error) => {
                    log::warn!(
                            "Thumbnail fallback could not determine duration; using the default fallback timestamp: video={}, error={probe_error}",
                            path_string(&video_path)
                        );
                    None
                }
            };
            let permit = media_sidecar_pool.acquire()?;
            let result = render_thumbnail_with_ffmpeg(
                &video_path,
                &temporary_path,
                capture_position,
                duration,
            );
            drop(permit);
            match result {
                Ok(generated) => generated,
                Err(fallback_error) => {
                    remove_failed_thumbnail_output(&temporary_path, "ffmpeg-fallback");
                    log::error!(
                        "FFmpeg thumbnail fallback failed: video={}, error={fallback_error}",
                        path_string(&video_path)
                    );
                    return Err(format!(
                        "FFmpeg thumbnail fallback failed for {}: {fallback_error}",
                        path_string(&video_path)
                    ));
                }
            }
        }
    };
    if !generated {
        remove_failed_thumbnail_output(&temporary_path, "no-image-generated");
        let error =
            "Neither ffmpegthumbnailer nor the FFmpeg fallback created a thumbnail.".to_string();
        log::error!(
            "Thumbnail generation failed for {}: {}",
            path_string(&video_path),
            error
        );
        return Err(error);
    }
    {
        let _cache_maintenance = thumbnail_cache
            .lock
            .lock()
            .map_err(|_| "Unable to access the thumbnail cache maintenance lock.".to_string())?;
        if thumbnail_path.exists() {
            fs::remove_file(&thumbnail_path)
                .map_err(|error| format!("Unable to replace the cached thumbnail: {error}"))?;
        }
        if let Err(error) = fs::rename(&temporary_path, &thumbnail_path) {
            remove_failed_thumbnail_output(&temporary_path, "cache-commit");
            log::error!(
                "Unable to commit generated thumbnail to cache: video={}, output={}, error={error}",
                path_string(&video_path),
                path_string(&thumbnail_path)
            );
            return Err(format!("Unable to store the cached thumbnail: {error}"));
        }
        record_thumbnail_cache(
            &video_path,
            &metadata,
            &thumbnail_path,
            &thumbnail_cache.index,
            capture_position,
            persist_immediately,
        )?;
    }
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
    thumbnail_cache: ThumbnailCacheMaintenanceState,
    capture_position: String,
    cache_limit_bytes: u64,
    app_handle: tauri::AppHandle,
) -> Result<ThumbnailBatchResult, String> {
    let requested = paths.len();
    let queue = Arc::new(Mutex::new(VecDeque::from(paths)));
    let worker_limit = media_sidecar_pool.limit()?;
    let queued = queue.lock().map(|queue| queue.len()).map_err(|_| {
        log::error!("Unable to read thumbnail batch queue length");
        "Unable to access the thumbnail task queue.".to_string()
    })?;
    let worker_count = worker_limit.min(queued);
    log::info!(
        "Thumbnail batch worker pool started: requested={requested}, workers={worker_count}, capture_position={capture_position}, cache_limit_bytes={cache_limit_bytes}"
    );
    let workers = (0..worker_count)
        .map(|_| {
            let queue = Arc::clone(&queue);
            let media_sidecar_pool = Arc::clone(&media_sidecar_pool);
            let thumbnail_cache = thumbnail_cache.clone();
            let capture_position = capture_position.clone();
            let app_handle = app_handle.clone();
            thread::spawn(move || {
                let mut results = Vec::new();
                while let Some(path) = queued_media_path(&queue, "Thumbnail batch") {
                    let source_path = path.clone();
                    let result = (|| {
                        let video_path = fs::canonicalize(&path)
                            .map_err(|error| format!("Unable to access this video: {error}"))?;
                        let thumbnail_path = generate_thumbnail_impl(
                            &video_path,
                            &capture_position,
                            false,
                            &media_sidecar_pool,
                            &thumbnail_cache,
                        );
                        let thumbnail_path = thumbnail_path?;
                        Ok(ThumbnailResult {
                            path: path_string(&video_path),
                            thumbnail_path: path_string(&thumbnail_path),
                        })
                    })();
                    if let Ok(thumbnail) = &result {
                        if let Err(error) = app_handle.emit("thumbnail-generated", thumbnail.clone()) {
                            log::warn!(
                                "Thumbnail generated but UI event delivery failed: path={}, error={error}",
                                thumbnail.path
                            );
                        }
                    }
                    results.push((source_path, result));
                }
                results
            })
        })
        .collect::<Vec<_>>();

    let mut thumbnails = Vec::new();
    let mut failures = Vec::new();
    for worker in workers {
        match worker.join() {
            Ok(results) => {
                for (path, result) in results {
                    match result {
                        Ok(result) => thumbnails.push(result),
                        Err(error) => failures.push(ThumbnailFailure { path, error }),
                    }
                }
            }
            Err(_) => {
                log::error!("Thumbnail batch worker panicked");
                failures.push(ThumbnailFailure {
                    path: "<unknown>".to_string(),
                    error: "The thumbnail worker panicked.".to_string(),
                });
            }
        }
    }

    if !thumbnails.is_empty() {
        let index = thumbnail_cache
            .index
            .lock()
            .map_err(|_| "Unable to access the thumbnail index.".to_string())?;
        persist_thumbnail_index_at(&thumbnail_cache.directory, &index)?;
    }

    maintain_thumbnail_cache(
        &thumbnail_cache.directory,
        &thumbnail_cache.index,
        &thumbnail_cache.lock,
        cache_limit_bytes,
    )?;

    log::info!(
        "Thumbnail batch worker pool completed: requested={requested}, generated={}, failed={}",
        thumbnails.len(),
        failures.len()
    );
    Ok(ThumbnailBatchResult {
        thumbnails,
        failures,
    })
}

pub(super) fn generate_image_thumbnail_batch_impl(
    paths: Vec<String>,
    thumbnail_cache: ThumbnailCacheMaintenanceState,
    cache_limit_bytes: u64,
    app_handle: tauri::AppHandle,
) -> Result<ThumbnailBatchResult, String> {
    let settings = load_config()?.settings;
    let mut thumbnails = Vec::new();
    let mut failures = Vec::new();
    for path in paths {
        let result = (|| {
            let image_path = fs::canonicalize(&path)
                .map_err(|error| format!("Unable to access this image: {error}"))?;
            let metadata = fs::metadata(&image_path)
                .map_err(|error| format!("Unable to inspect this image: {error}"))?;
            if metadata.len() > u64::from(settings.image_max_megabytes) * 1024 * 1024 {
                return Err("Image exceeds the configured size protection limit.".to_string());
            }
            if let Some(cached) = cached_thumbnail_path(
                &image_path,
                &metadata,
                &thumbnail_cache.index,
                &thumbnail_cache.directory,
                "image-v1",
            ) {
                return Ok(cached);
            }
            let (width, height) = open_image_reader_by_content(&image_path)?
                .into_dimensions()
                .map_err(|error| format!("Unable to read image dimensions: {error}"))?;
            if u64::from(width) * u64::from(height)
                > u64::from(settings.image_max_megapixels) * 1_000_000
            {
                return Err("Image exceeds the configured pixel protection limit.".to_string());
            }
            let decoded = open_image_reader_by_content(&image_path)?
                .decode()
                .map_err(|error| format!("Unable to decode image: {error}"))?;
            let output = thumbnail_path_for(&image_path)?;
            let temporary = output.with_extension("tmp.jpg");
            decoded
                .thumbnail(320, 320)
                .to_rgb8()
                .save_with_format(&temporary, image::ImageFormat::Jpeg)
                .map_err(|error| format!("Unable to write image thumbnail: {error}"))?;
            let _maintenance = thumbnail_cache.lock.lock().map_err(|_| {
                "Unable to access the thumbnail cache maintenance lock.".to_string()
            })?;
            if output.exists() {
                fs::remove_file(&output)
                    .map_err(|error| format!("Unable to replace the cached thumbnail: {error}"))?;
            }
            fs::rename(&temporary, &output)
                .map_err(|error| format!("Unable to commit image thumbnail: {error}"))?;
            record_thumbnail_cache(
                &image_path,
                &metadata,
                &output,
                &thumbnail_cache.index,
                "image-v1",
                true,
            )?;
            Ok(path_string(&output))
        })();
        match result {
            Ok(thumbnail_path) => {
                let normalized = fs::canonicalize(&path)
                    .map(|item| path_string(&item))
                    .unwrap_or(path);
                let result = ThumbnailResult {
                    path: normalized,
                    thumbnail_path,
                };
                let _ = app_handle.emit("thumbnail-generated", &result);
                thumbnails.push(result);
            }
            Err(error) => failures.push(ThumbnailFailure { path, error }),
        }
    }
    maintain_thumbnail_cache(
        &thumbnail_cache.directory,
        &thumbnail_cache.index,
        &thumbnail_cache.lock,
        cache_limit_bytes,
    )?;
    Ok(ThumbnailBatchResult {
        thumbnails,
        failures,
    })
}

pub(super) fn thumbnail_data_impl(
    path: &Path,
    thumbnail_index: &Arc<Mutex<MediaCacheIndex>>,
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
            if let Err(index_error) = remove_thumbnail_cache_entry(&video_path, thumbnail_index) {
                log::error!(
                    "Cached thumbnail read failed and the stale index entry could not be removed: video={}, error={index_error}",
                    path_string(&video_path)
                );
            }
            return Err(format!(
                "Unable to read the cached thumbnail {}: {error}",
                path_string(&thumbnail_path)
            ));
        }
    };

    log::debug!(
        "Cached thumbnail bytes read: video={}, thumbnail={}, bytes={}",
        path_string(&video_path),
        path_string(&thumbnail_path),
        bytes.len()
    );

    Ok(ThumbnailData {
        path: path_string(&video_path),
        thumbnail_path: path_string(&thumbnail_path),
        data_url: format!("data:image/jpeg;base64,{}", BASE64_STANDARD.encode(bytes)),
    })
}
