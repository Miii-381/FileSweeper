//! Android uses native lifecycle/file tasks, with Rust serving bounded WebView previews.
use axum::{
    extract::{Path as RoutePath, State},
    http::{Request, StatusCode},
    response::Response,
    routing::get,
    Router,
};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    fs,
    net::TcpListener,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{plugin::PluginHandle, Manager};
use tower::ServiceExt;
use tower_http::{cors::CorsLayer, services::ServeFile};

struct Native(PluginHandle<tauri::Wry>);

/// Android's Java move implementation may check existence before rename. Use the
/// kernel's atomic no-replace operation so concurrent creators cannot be overwritten.
#[no_mangle]
pub extern "system" fn Java_com_ayanami_filesweeper_mobile_NativeMoves_moveNoReplace(
    mut env: jni::JNIEnv,
    _class: jni::objects::JClass,
    source: jni::objects::JString,
    destination: jni::objects::JString,
) -> jni::sys::jstring {
    let result = (|| -> Result<(), String> {
        let source: String = env
            .get_string(&source)
            .map_err(|error| error.to_string())?
            .into();
        let destination: String = env
            .get_string(&destination)
            .map_err(|error| error.to_string())?
            .into();
        let source = std::ffi::CString::new(source).map_err(|error| error.to_string())?;
        let destination = std::ffi::CString::new(destination).map_err(|error| error.to_string())?;
        // Both C strings remain alive for this syscall; no descriptor or borrowed data escapes.
        let status = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                libc::AT_FDCWD,
                source.as_ptr(),
                libc::AT_FDCWD,
                destination.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if status == 0 {
            Ok(())
        } else {
            Err(format!(
                "安全移动失败，未覆盖目标：{}",
                std::io::Error::last_os_error()
            ))
        }
    })();
    match result {
        Ok(()) => std::ptr::null_mut(),
        Err(error) => env
            .new_string(error)
            .map(|message| message.into_raw())
            .unwrap_or(std::ptr::null_mut()),
    }
}
#[derive(Clone)]
struct PreviewServer {
    base: String,
    files: Arc<Mutex<VecDeque<(String, PathBuf)>>>,
}

#[tauri::command]
async fn mobile_call(
    command: String,
    payload: Option<Value>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    // Android commands doing IO dispatch to their own executor; the bridge never waits on the UI thread.
    app.state::<Native>()
        .0
        .run_mobile_plugin(&command, payload.unwrap_or_else(|| json!({})))
        .map_err(|error| {
            log::warn!("Android command failed: command={command}, error={error}");
            error.to_string()
        })
}

fn resolve_file(app: &tauri::AppHandle, path: &str) -> Result<PathBuf, String> {
    let result: Value = app
        .state::<Native>()
        .0
        .run_mobile_plugin("resolveFile", json!({"path":path}))
        .map_err(|error| error.to_string())?;
    result["path"]
        .as_str()
        .map(PathBuf::from)
        .ok_or_else(|| "无法解析文件位置".to_string())
}

#[tauri::command]
async fn get_preview_file_url(path: String, app: tauri::AppHandle) -> Result<String, String> {
    let resolved = resolve_file(&app, &path)?;
    let server = app.state::<PreviewServer>();
    let mut files = server.files.lock().map_err(|error| error.to_string())?;
    if let Some((token, _)) = files.iter().find(|(_, file)| file == &resolved) {
        return Ok(format!("{}/preview/{token}", server.base));
    }
    let token = uuid::Uuid::new_v4().simple().to_string();
    files.push_back((token.clone(), resolved));
    if files.len() > 4096 {
        files.pop_front();
    }
    log::debug!(
        "Android preview resource registered: active_resources={}",
        files.len()
    );
    Ok(format!("{}/preview/{token}", server.base))
}

#[tauri::command]
async fn inspect_image_preview(path: String, app: tauri::AppHandle) -> Result<Value, String> {
    mobile_call("imageInfo".into(), Some(json!({"path":path})), app).await
}

#[tauri::command]
async fn open_file_externally(path: String, app: tauri::AppHandle) -> Result<Value, String> {
    mobile_call("openExternally".into(), Some(json!({"path":path})), app).await
}

#[tauri::command]
async fn read_text_preview(path: String, app: tauri::AppHandle) -> Result<Value, String> {
    let file = resolve_file(&app, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        const LIMIT: u64 = 4 * 1024 * 1024;
        let size = fs::metadata(&file).map_err(|error| error.to_string())?.len();
        if size > LIMIT {
            log::info!("Android text preview rejected by memory budget: bytes={size}");
            return Ok(json!({"content":"", "encoding":"", "totalBytes":size, "readable":false, "reason":"文件超过 4 MB 的手机预览限制，请使用其他应用打开"}));
        }
        // Bound the actual read too: the source can grow between metadata and reading.
        use std::io::Read;
        let mut bytes = Vec::new();
        fs::File::open(file).map_err(|error| error.to_string())?.take(LIMIT + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
        if bytes.len() as u64 > LIMIT { return Err("文件在读取期间增长，已停止预览".into()); }
        let (content, encoding) = if bytes.starts_with(&[0xff,0xfe]) {
            (encoding_rs::UTF_16LE.decode(&bytes[2..]).0.into_owned(), "UTF-16 LE")
        } else if bytes.starts_with(&[0xfe,0xff]) {
            (encoding_rs::UTF_16BE.decode(&bytes[2..]).0.into_owned(), "UTF-16 BE")
        } else if let Ok(text) = std::str::from_utf8(&bytes) {
            (text.trim_start_matches('\u{feff}').to_string(), "UTF-8")
        } else {
            (encoding_rs::GBK.decode(&bytes).0.into_owned(), "GBK")
        };
        let readable = !content.contains('\0');
        Ok(json!({"content":if readable {content} else {String::new()}, "encoding":encoding, "totalBytes":size, "readable":readable, "reason":if readable {None} else {Some("文件包含二进制内容")}}))
    }).await.map_err(|error| error.to_string())?
}

async fn serve_preview(
    State(server): State<PreviewServer>,
    RoutePath(token): RoutePath<String>,
    request: Request<axum::body::Body>,
) -> Result<Response, StatusCode> {
    let path = server
        .files
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .iter()
        .find(|(key, _)| key == &token)
        .map(|(_, file)| file.clone())
        .ok_or(StatusCode::NOT_FOUND)?;
    // ServeFile handles byte ranges for PDF.js, and streams instead of loading whole files.
    ServeFile::new(path)
        .oneshot(request)
        .await
        .map(|response| response.map(axum::body::Body::new))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[tauri::mobile_entry_point]
pub fn run() {
    let plugin = tauri::plugin::Builder::<tauri::Wry, ()>::new("mobile")
        .setup(|app, api| {
            let handle =
                api.register_android_plugin("com.ayanami.filesweeper.mobile", "MobilePlugin")?;
            app.manage(Native(handle));
            Ok(())
        })
        .build();
    tauri::Builder::default()
        .plugin(plugin)
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Debug)
                .max_file_size(2 * 1024 * 1024)
                .build(),
        )
        .setup(|app| {
            let listener = TcpListener::bind("127.0.0.1:0")?;
            listener.set_nonblocking(true)?;
            let server = PreviewServer {
                base: format!("http://{}", listener.local_addr()?),
                files: Arc::new(Mutex::new(VecDeque::new())),
            };
            app.manage(server.clone());
            tauri::async_runtime::spawn(async move {
                let router = Router::new()
                    .route("/preview/{token}", get(serve_preview))
                    .layer(CorsLayer::permissive())
                    .with_state(server);
                match tokio::net::TcpListener::from_std(listener) {
                    Ok(listener) => {
                        if let Err(error) = axum::serve(listener, router).await {
                            log::error!("Android preview server stopped: {error}");
                        }
                    }
                    Err(error) => log::error!("Android preview listener failed: {error}"),
                }
            });
            log::info!(
                "FileSweeper Android MVP initialized: version={}",
                env!("CARGO_PKG_VERSION")
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mobile_call,
            get_preview_file_url,
            inspect_image_preview,
            read_text_preview,
            open_file_externally
        ])
        .run(tauri::generate_context!())
        .expect("Android application failed");
}
