use super::*;

#[cfg(target_os = "windows")]
fn terminate_process_tree(process_id: u32) -> Result<(), String> {
    let mut command = Command::new("taskkill");
    configure_sidecar_command(&mut command);
    let status = command
        .args(["/PID", &process_id.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| format!("Unable to stop the FFmpeg preview process: {error}"))?;
    if !status.success() {
        return Err(format!(
            "Unable to stop the FFmpeg preview process tree {process_id}: taskkill exited with {status}."
        ));
    }
    log::debug!("FFmpeg preview process tree terminated: process_id={process_id}");
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn terminate_process_tree(process_id: u32) -> Result<(), String> {
    let status = Command::new("kill")
        .args(["-TERM", &process_id.to_string()])
        .status()
        .map_err(|error| format!("Unable to stop the FFmpeg preview process: {error}"))?;
    if !status.success() {
        return Err(format!(
            "Unable to stop the FFmpeg preview process {process_id}: kill exited with {status}."
        ));
    }
    log::debug!("FFmpeg preview process terminated: process_id={process_id}");
    Ok(())
}

/// The player only receives a loopback URL; the request handler validates the file again.
pub(super) struct VideoStreamServer {
    pub(super) base_url: Option<String>,
    pub(super) transcode_controller: Arc<TranscodeController>,
}

pub(super) struct TranscodeController {
    active_processes: Mutex<HashMap<u32, String>>,
    processes_changed: Condvar,
}

pub(super) struct TranscodeRegistration {
    controller: Arc<TranscodeController>,
    process_id: u32,
}

impl TranscodeController {
    pub(super) fn new() -> Self {
        Self {
            active_processes: Mutex::new(HashMap::new()),
            processes_changed: Condvar::new(),
        }
    }

    #[cfg(test)]
    pub(super) fn active_process_path(&self, process_id: u32) -> Option<String> {
        self.active_processes
            .lock()
            .ok()
            .and_then(|active| active.get(&process_id).cloned())
    }

    pub(super) fn replace_with(
        self: &Arc<Self>,
        process_id: u32,
        video_path: &Path,
    ) -> TranscodeRegistration {
        let previous_processes = if let Ok(mut active) = self.active_processes.lock() {
            let previous = active.keys().copied().collect::<Vec<_>>();
            active.insert(process_id, path_string(video_path));
            previous
        } else {
            log::error!(
                "Unable to register FFmpeg preview process; process replacement tracking is unavailable: process_id={process_id}, video={}",
                path_string(video_path)
            );
            Vec::new()
        };
        for previous_process_id in previous_processes {
            if let Err(error) = terminate_process_tree(previous_process_id) {
                log::warn!("Unable to replace an earlier FFmpeg preview: {error}");
            }
        }
        log::info!(
            "FFmpeg preview registered: process_id={process_id}, video={}",
            path_string(video_path)
        );
        TranscodeRegistration {
            controller: Arc::clone(self),
            process_id,
        }
    }

    pub(super) fn stop_video(&self, video_path: &Path) -> Result<bool, String> {
        let normalized_path = path_string(video_path);
        log::debug!("Stopping FFmpeg preview for video: {normalized_path}");
        self.stop_matching(|process_path| process_path.eq_ignore_ascii_case(&normalized_path))
    }

    pub(super) fn stop_all(&self) -> Result<bool, String> {
        log::info!("Stopping all active FFmpeg previews");
        self.stop_matching(|_| true)
    }

    pub(super) fn stop_matching(
        &self,
        predicate: impl Fn(&String) -> bool,
    ) -> Result<bool, String> {
        let process_ids = self
            .active_processes
            .lock()
            .map_err(|_| "Unable to access the FFmpeg preview process list.".to_string())?
            .iter()
            .filter_map(|(process_id, process)| predicate(process).then_some(*process_id))
            .collect::<Vec<_>>();
        if process_ids.is_empty() {
            log::debug!("No matching FFmpeg preview process was active");
            return Ok(false);
        }

        for process_id in &process_ids {
            terminate_process_tree(*process_id)?;
        }

        let deadline = Instant::now() + Duration::from_secs(3);
        let mut active = self
            .active_processes
            .lock()
            .map_err(|_| "Unable to access the FFmpeg preview process list.".to_string())?;
        while process_ids
            .iter()
            .any(|process_id| active.contains_key(process_id))
        {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(
                    "FFmpeg did not exit before the delete operation timed out.".to_string()
                );
            }
            let (next, wait_result) = self
                .processes_changed
                .wait_timeout(active, remaining)
                .map_err(|_| "Unable to wait for the FFmpeg preview process.".to_string())?;
            active = next;
            if wait_result.timed_out()
                && process_ids
                    .iter()
                    .any(|process_id| active.contains_key(process_id))
            {
                return Err(
                    "FFmpeg did not exit before the delete operation timed out.".to_string()
                );
            }
        }
        log::info!("Stopped {} FFmpeg preview process(es)", process_ids.len());
        Ok(true)
    }
}

impl Drop for TranscodeRegistration {
    fn drop(&mut self) {
        if let Ok(mut active) = self.controller.active_processes.lock() {
            if let Some(path) = active.remove(&self.process_id) {
                log::info!(
                    "FFmpeg preview released: process_id={}, video={path}",
                    self.process_id
                );
            }
            self.controller.processes_changed.notify_all();
        }
    }
}

pub(super) fn resolve_stream_video_path(path: &str) -> Result<PathBuf, String> {
    resolve_stream_video_path_with_settings(path, &load_config()?.settings)
}

pub(super) fn resolve_stream_audio_path(path: &str) -> Result<PathBuf, String> {
    let audio_path = resolve_stream_file_path(path)?;
    if !config_store::is_supported_audio_path(&audio_path, &load_config()?.settings) {
        return Err("The requested file type is not enabled for audio preview.".to_string());
    }
    Ok(audio_path)
}

pub(super) fn resolve_stream_file_path(path: &str) -> Result<PathBuf, String> {
    if !Path::new(path).is_absolute() {
        return Err("The requested video path must be absolute.".to_string());
    }
    let video_path = fs::canonicalize(path)
        .map_err(|error| format!("Unable to access the requested video: {error}"))?;
    let metadata = fs::metadata(&video_path)
        .map_err(|error| format!("Unable to inspect the requested video: {error}"))?;
    if !metadata.is_file() {
        return Err("The requested path is not a regular file.".to_string());
    }
    Ok(video_path)
}

fn resolve_stream_video_path_with_settings(
    path: &str,
    settings: &Preferences,
) -> Result<PathBuf, String> {
    let video_path = resolve_stream_file_path(path)?;
    if !config_store::is_supported_video_path(&video_path, settings) {
        return Err("The requested file type is not enabled for video preview.".to_string());
    }
    Ok(video_path)
}

pub(super) fn encode_query_component(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push(HEX[(byte >> 4) as usize] as char);
            encoded.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    encoded
}

async fn serve_video_stream(
    State(transcode_controller): State<Arc<TranscodeController>>,
    Query(query): Query<VideoStreamQuery>,
    request: Request,
) -> Response {
    log::debug!(
        "Local video stream request received: method={}, mode={:?}, start={:?}, path={}",
        request.method(),
        query.mode,
        query.start,
        query.path
    );
    // The loopback HTTP boundary validates the path independently of the IPC command.
    let resolved_path = match query.mode {
        VideoStreamMode::Transcode => resolve_stream_video_path(&query.path),
        VideoStreamMode::Audio => resolve_stream_audio_path(&query.path),
        VideoStreamMode::Direct => resolve_stream_file_path(&query.path),
    };
    let video_path = match resolved_path {
        Ok(path) => path,
        Err(error) => {
            log::warn!("Rejected local video stream request: {error}");
            return (StatusCode::BAD_REQUEST, "A valid file is required.").into_response();
        }
    };

    serve_resolved_video_stream(
        transcode_controller,
        video_path,
        query.mode,
        query.start,
        request,
    )
    .await
}

async fn serve_resolved_video_stream(
    transcode_controller: Arc<TranscodeController>,
    video_path: PathBuf,
    mode: VideoStreamMode,
    start: Option<f64>,
    request: Request,
) -> Response {
    if mode == VideoStreamMode::Transcode {
        log::debug!(
            "Routing local stream request to FFmpeg transcode: path={}, start={:?}",
            path_string(&video_path),
            start
        );
        return serve_transcoded_video_stream(
            video_path,
            start,
            request,
            State(transcode_controller),
        )
        .await;
    }
    if mode == VideoStreamMode::Audio {
        log::debug!(
            "Routing local stream request to FFmpeg audio transcode: path={}",
            path_string(&video_path)
        );
        return serve_transcoded_audio_stream(video_path, request, State(transcode_controller))
            .await;
    }

    let log_path = path_string(&video_path);
    match ServeFile::new(video_path).oneshot(request).await {
        Ok(response) => {
            log::debug!(
                "Direct local video stream response ready: path={log_path}, status={}",
                response.status()
            );
            response.into_response()
        }
        Err(error) => {
            log::error!("Unable to serve local video stream: {error}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Unable to read the requested video.",
            )
                .into_response()
        }
    }
}

async fn serve_transcoded_audio_stream(
    audio_path: PathBuf,
    request: Request,
    State(transcode_controller): State<Arc<TranscodeController>>,
) -> Response {
    if request.method() == Method::HEAD {
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "audio/mp4")
            .header("accept-ranges", "none")
            .header("cache-control", "no-store")
            .body(Body::empty())
            .unwrap_or_else(|error| {
                log::error!("Unable to build transcoded audio HEAD response: {error}");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            });
    }
    let ffmpeg = match resolve_sidecar("ffmpeg") {
        Ok(path) => path,
        Err(error) => {
            log::error!("Unable to start audio transcode preview: {error}");
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                "FFmpeg is unavailable for this preview.",
            )
                .into_response();
        }
    };
    let mut command = tokio::process::Command::new(ffmpeg);
    command.kill_on_drop(true);
    #[cfg(target_os = "windows")]
    command
        .as_std_mut()
        .creation_flags(sidecar::sidecar_creation_flags());
    let mut child = match command
        .args(["-hide_banner", "-loglevel", "error", "-i"])
        .arg(&audio_path)
        .args([
            "-map",
            "0:a:0",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "frag_keyframe+empty_moov+default_base_moof",
            "-frag_duration",
            "250000",
            "-flush_packets",
            "1",
            "-f",
            "mp4",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            log::error!("Unable to spawn FFmpeg audio transcode preview: {error}");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Unable to start the FFmpeg audio preview.",
            )
                .into_response();
        }
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.start_kill();
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "FFmpeg audio preview output is unavailable.",
        )
            .into_response();
    };
    let Some(process_id) = child.id() else {
        let _ = child.start_kill();
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "FFmpeg audio preview process identity is unavailable.",
        )
            .into_response();
    };
    let stream_path = path_string(&audio_path);
    let registration = transcode_controller.replace_with(process_id, &audio_path);
    let stream = async_stream::stream! {
        use tokio::io::AsyncReadExt;
        let _registration = registration;
        let mut stdout = tokio::io::BufReader::new(stdout);
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            match stdout.read(&mut buffer).await {
                Ok(0) => break,
                Ok(read) => yield Ok::<Bytes, std::io::Error>(Bytes::copy_from_slice(&buffer[..read])),
                Err(error) => {
                    log::warn!("FFmpeg audio preview stream read failed: {error}");
                    yield Err::<Bytes, std::io::Error>(error);
                    break;
                }
            }
        }
        let _ = child.start_kill();
        if let Err(error) = child.wait().await {
            log::warn!("Unable to reap FFmpeg audio preview process: process_id={process_id}, error={error}");
        }
        log::info!("FFmpeg audio preview stream closed: process_id={process_id}, path={stream_path}");
    };
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "audio/mp4")
        .header("accept-ranges", "none")
        .header("cache-control", "no-store")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|error| {
            log::error!("Unable to build FFmpeg audio preview stream response: {error}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        })
}

async fn serve_transcoded_video_stream(
    video_path: PathBuf,
    start: Option<f64>,
    request: Request,
    State(transcode_controller): State<Arc<TranscodeController>>,
) -> Response {
    if request.method() == Method::HEAD {
        log::debug!(
            "Transcoded preview HEAD request completed without starting FFmpeg: path={}",
            path_string(&video_path)
        );
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "video/mp4")
            .header("accept-ranges", "none")
            .header("cache-control", "no-store")
            .body(Body::empty())
            .unwrap_or_else(|error| {
                log::error!("Unable to build transcoded preview HEAD response: {error}");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            });
    }

    let ffmpeg = match resolve_sidecar("ffmpeg") {
        Ok(path) => path,
        Err(error) => {
            log::error!("Unable to start transcode preview: {error}");
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                "FFmpeg is unavailable for this preview.",
            )
                .into_response();
        }
    };
    let mut command = tokio::process::Command::new(ffmpeg);
    command.kill_on_drop(true);
    #[cfg(target_os = "windows")]
    command
        .as_std_mut()
        .creation_flags(sidecar::sidecar_creation_flags());
    let mut child = match {
        let start = start.filter(|start| start.is_finite() && *start > 0.0);
        command.args(["-hide_banner", "-loglevel", "error"]);
        if let Some(start) = start {
            // Input seeking keeps startup responsive; while transcoding, FFmpeg's default
            // accurate seek decodes and discards frames up to the requested timestamp.
            command.arg("-ss").arg(format!("{start:.3}"));
        }
        command.arg("-i").arg(&video_path);
        command
    }
    .args([
        "-map",
        "0:v:0?",
        "-map",
        "0:a:0?",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-tune",
        "zerolatency",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "15",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
        "-frag_duration",
        "250000",
        "-flush_packets",
        "1",
        "-f",
        "mp4",
        "pipe:1",
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            log::error!("Unable to spawn FFmpeg transcode preview: {error}");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Unable to start the FFmpeg preview.",
            )
                .into_response();
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            log::error!(
                "FFmpeg preview started without a stdout pipe: path={}",
                path_string(&video_path)
            );
            if let Err(error) = child.start_kill() {
                log::warn!("Unable to stop FFmpeg after missing stdout pipe: {error}");
            }
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "FFmpeg preview output is unavailable.",
            )
                .into_response();
        }
    };
    let process_id = match child.id() {
        Some(process_id) => process_id,
        None => {
            log::error!(
                "FFmpeg preview started without a process id: path={}",
                path_string(&video_path)
            );
            if let Err(error) = child.start_kill() {
                log::warn!("Unable to stop FFmpeg after missing process id: {error}");
            }
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "FFmpeg preview process identity is unavailable.",
            )
                .into_response();
        }
    };
    log::info!(
        "FFmpeg preview process started: process_id={process_id}, path={}, start={:?}",
        path_string(&video_path),
        start
    );

    // Each requested position starts immediately and replaces the earlier preview process. The
    // response body still owns the child so disconnecting the player also reaps it.
    let stream_path = path_string(&video_path);
    let registration = transcode_controller.replace_with(process_id, &video_path);
    let stream = async_stream::stream! {
        use tokio::io::AsyncReadExt;

        let _registration = registration;
        let mut stdout = tokio::io::BufReader::new(stdout);
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            match stdout.read(&mut buffer).await {
                Ok(0) => break,
                Ok(read) => yield Ok::<Bytes, std::io::Error>(Bytes::copy_from_slice(&buffer[..read])),
                Err(error) => {
                    log::warn!("FFmpeg preview stream read failed: {error}");
                    yield Err::<Bytes, std::io::Error>(error);
                    break;
                }
            }
        }
        if let Err(error) = child.start_kill() {
            log::debug!("FFmpeg preview was already stopped or could not be killed: process_id={process_id}, error={error}");
        }
        if let Err(error) = child.wait().await {
            log::warn!("Unable to reap FFmpeg preview process: process_id={process_id}, error={error}");
        }
        log::info!("FFmpeg preview stream closed: process_id={process_id}, path={stream_path}");
    };

    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "video/mp4")
        .header("accept-ranges", "none")
        .header("cache-control", "no-store")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|error| {
            log::error!("Unable to build FFmpeg preview stream response: {error}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        })
}

pub(super) fn start_video_stream_server(
    transcode_controller: Arc<TranscodeController>,
) -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("Unable to bind the local video stream server: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Unable to configure the local video stream server: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("Unable to read the local video stream address: {error}"))?;

    thread::Builder::new()
        .name("video-stream-server".to_string())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_io()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    log::error!("Unable to start the local video stream runtime: {error}");
                    return;
                }
            };
            runtime.block_on(async move {
                let listener = match tokio::net::TcpListener::from_std(listener) {
                    Ok(listener) => listener,
                    Err(error) => {
                        log::error!("Unable to adopt the local video stream socket: {error}");
                        return;
                    }
                };
                let app = Router::new()
                    .route("/video", get(serve_video_stream).head(serve_video_stream))
                    // Wavesurfer loads the loopback media URL with fetch(). The WebView origin
                    // differs from this dynamically assigned loopback port, so every response
                    // must explicitly permit that cross-origin read.
                    .layer(CorsLayer::permissive())
                    .with_state(transcode_controller);
                if let Err(error) = axum::serve(listener, app).await {
                    log::error!("The local video stream server stopped unexpectedly: {error}");
                }
            });
        })
        .map_err(|error| format!("Unable to start the local video stream server: {error}"))?;

    let url = format!("http://{address}/video");
    log::info!("Local video stream server started: url={url}");
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{header, HeaderValue};

    fn test_directory(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "file-sweeper-stream-{name}-{}-{}",
            std::process::id(),
            current_unix_millis()
        ));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn stream_path_validation_rejects_relative_directories_and_disabled_extensions() {
        let directory = test_directory("path-validation");
        let unsupported = directory.join("sample.txt");
        fs::write(&unsupported, b"not-video").unwrap();
        let settings = Preferences::default();

        assert!(resolve_stream_video_path_with_settings("relative.mp4", &settings).is_err());
        assert!(
            resolve_stream_video_path_with_settings(directory.to_str().unwrap(), &settings)
                .is_err()
        );
        assert!(
            resolve_stream_video_path_with_settings(unsupported.to_str().unwrap(), &settings)
                .is_err()
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn direct_stream_supports_head_and_byte_ranges() {
        let directory = test_directory("range");
        let video = directory.join("sample.mp4");
        fs::write(&video, b"0123456789abcdef").unwrap();
        let video = fs::canonicalize(video).unwrap();
        let controller = Arc::new(TranscodeController::new());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .build()
            .unwrap();
        runtime.block_on(async {
            let head = serve_resolved_video_stream(
                Arc::clone(&controller),
                video.clone(),
                VideoStreamMode::Direct,
                None,
                Request::builder()
                    .method(Method::HEAD)
                    .uri("/")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
            assert_eq!(head.status(), StatusCode::OK);
            assert_eq!(head.headers().get(header::CONTENT_LENGTH).unwrap(), "16");

            let range = serve_resolved_video_stream(
                Arc::clone(&controller),
                video.clone(),
                VideoStreamMode::Direct,
                None,
                Request::builder()
                    .method(Method::GET)
                    .uri("/")
                    .header(header::RANGE, HeaderValue::from_static("bytes=2-5"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
            assert_eq!(range.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(
                range.headers().get(header::CONTENT_RANGE).unwrap(),
                "bytes 2-5/16"
            );
        });
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn transcoded_head_does_not_start_ffmpeg() {
        let directory = test_directory("head");
        let video = directory.join("sample.mp4");
        fs::write(&video, b"video").unwrap();
        let video = fs::canonicalize(video).unwrap();
        let controller = Arc::new(TranscodeController::new());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .build()
            .unwrap();
        runtime.block_on(async {
            let response = serve_resolved_video_stream(
                controller,
                video.clone(),
                VideoStreamMode::Transcode,
                None,
                Request::builder()
                    .method(Method::HEAD)
                    .uri("/")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers().get(header::CONTENT_TYPE).unwrap(),
                "video/mp4"
            );
        });
        fs::remove_dir_all(directory).unwrap();
    }
}
