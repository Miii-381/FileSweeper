use super::*;

pub(super) fn resolve_stream_video_path(path: &str) -> Result<PathBuf, String> {
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
    if !is_supported_video_path(&video_path, &load_config()?.settings) {
        return Err("The requested file type is not enabled for video preview.".to_string());
    }
    Ok(video_path)
}

pub(super) fn probe_preview_duration(video_path: &Path) -> Result<Option<f64>, String> {
    let ffprobe = resolve_sidecar("ffprobe")?;
    let mut command = Command::new(ffprobe);
    configure_sidecar_command(&mut command);
    let output = command
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
        ])
        .arg(video_path)
        .output()
        .map_err(|error| format!("Unable to inspect the preview codec: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "FFprobe could not inspect the preview codec: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let duration = serde_json::from_slice::<serde_json::Value>(&output.stdout)
        .ok()
        .and_then(|document| {
            document
                .get("format")?
                .get("duration")?
                .as_str()?
                .parse::<f64>()
                .ok()
        })
        .filter(|duration| duration.is_finite() && *duration > 0.0);
    Ok(duration)
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
    let video_path = match resolve_stream_video_path(&query.path) {
        Ok(path) => path,
        Err(error) => {
            log::warn!("Rejected local video stream request: {error}");
            return (
                StatusCode::BAD_REQUEST,
                "A valid enabled video file is required.",
            )
                .into_response();
        }
    };

    if query.mode == VideoStreamMode::Transcode {
        return serve_transcoded_video_stream(
            video_path,
            query.start,
            request,
            State(transcode_controller),
        )
        .await;
    }

    match ServeFile::new(video_path).oneshot(request).await {
        Ok(response) => response.into_response(),
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

async fn serve_transcoded_video_stream(
    video_path: PathBuf,
    start: Option<f64>,
    request: Request,
    State(transcode_controller): State<Arc<TranscodeController>>,
) -> Response {
    if request.method() == Method::HEAD {
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "video/mp4")
            .header("accept-ranges", "none")
            .header("cache-control", "no-store")
            .body(Body::empty())
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
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
        "veryfast",
        "-tune",
        "zerolatency",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "30",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
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
            let _ = child.start_kill();
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
            let _ = child.start_kill();
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "FFmpeg preview process identity is unavailable.",
            )
                .into_response();
        }
    };

    // A new live preview replaces the previous FFmpeg process. Dropping this body also kills the
    // child when the browser changes selection or closes the request.
    let generation = transcode_controller
        .generation
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    let registration = transcode_controller.register(process_id, &video_path);
    let stream = async_stream::stream! {
        use tokio::io::AsyncReadExt;

        let _registration = registration;
        let mut stdout = tokio::io::BufReader::new(stdout);
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            if transcode_controller.generation.load(Ordering::SeqCst) != generation {
                break;
            }
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
        let _ = child.start_kill();
        let _ = child.wait().await;
    };

    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "video/mp4")
        .header("accept-ranges", "none")
        .header("cache-control", "no-store")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
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
                    .with_state(transcode_controller);
                if let Err(error) = axum::serve(listener, app).await {
                    log::error!("The local video stream server stopped unexpectedly: {error}");
                }
            });
        })
        .map_err(|error| format!("Unable to start the local video stream server: {error}"))?;

    Ok(format!("http://{address}/video"))
}
