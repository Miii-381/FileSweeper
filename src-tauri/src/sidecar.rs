use super::*;

#[cfg(target_os = "windows")]
const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(target_os = "windows")]
pub(super) const fn sidecar_creation_flags() -> u32 {
    BELOW_NORMAL_PRIORITY_CLASS | CREATE_NO_WINDOW
}

pub(super) fn sidecar_filename(name: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{name}-x86_64-pc-windows-msvc.exe")
    } else {
        name.to_string()
    }
}

pub(super) fn add_sidecar_candidates(base: &Path, name: &str, candidates: &mut Vec<PathBuf>) {
    let sidecar = sidecar_filename(name);
    candidates.push(base.join(&sidecar));
    candidates.push(base.join("sidecars").join(&sidecar));
    candidates.push(base.join("..").join("sidecars").join(&sidecar));
    if cfg!(target_os = "windows") {
        candidates.push(base.join(format!("{name}.exe")));
        candidates.push(base.join("bin").join(format!("{name}.exe")));
    }
}

static SIDECAR_PATH_CACHE: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();

pub(super) fn resolve_sidecar(name: &str) -> Result<PathBuf, String> {
    let cache = SIDECAR_PATH_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(entries) = cache.lock() {
        if let Some(path) = entries.get(name) {
            log::debug!("Using cached {name} sidecar path: {}", path_string(path));
            return Ok(path.clone());
        }
    } else {
        log::warn!("Unable to read the {name} sidecar path cache; resolving from disk");
    }

    let mut candidates = Vec::new();
    if let Ok(current_dir) = std::env::current_dir() {
        let mut cursor = Some(current_dir.as_path());
        while let Some(directory) = cursor {
            add_sidecar_candidates(directory, name, &mut candidates);
            cursor = directory.parent();
        }
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(executable_dir) = executable.parent() {
            let mut cursor = Some(executable_dir);
            while let Some(directory) = cursor {
                add_sidecar_candidates(directory, name, &mut candidates);
                cursor = directory.parent();
            }
        }
    }

    let resolved = candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .map(|candidate| match fs::canonicalize(&candidate) {
            Ok(canonical) => canonical,
            Err(error) => {
                log::warn!(
                    "Unable to canonicalize resolved {name} sidecar; using the discovered path: path={}, error={error}",
                    path_string(&candidate)
                );
                candidate
            }
        });
    match resolved {
        Some(path) => {
            if let Ok(mut entries) = cache.lock() {
                entries.insert(name.to_string(), path.clone());
            } else {
                log::warn!("Resolved {name} sidecar but could not update the path cache");
            }
            log::debug!("Resolved {name} sidecar at {}", path_string(&path));
            Ok(path)
        }
        None => {
            log::error!("Unable to locate the {name} sidecar.");
            Err(format!("Unable to locate the {name} sidecar."))
        }
    }
}

pub(super) fn configure_sidecar_command(command: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        // Media helpers are console applications. A release GUI process must explicitly suppress
        // their console window or every thumbnail/probe command briefly flashes a terminal.
        command.creation_flags(sidecar_creation_flags());
    }
    #[cfg(not(target_os = "windows"))]
    let _ = command;
}

pub(super) fn read_child_stderr(child: &mut Child) -> String {
    let Some(mut stderr) = child.stderr.take() else {
        log::debug!(
            "Media sidecar has no captured stderr pipe: process_id={}",
            child.id()
        );
        return String::new();
    };
    let mut output = String::new();
    if let Err(error) = stderr.read_to_string(&mut output) {
        log::warn!(
            "Unable to read media sidecar stderr: process_id={}, error={error}",
            child.id()
        );
    }
    output.trim().to_string()
}

pub(super) fn wait_for_child(child: &mut Child, timeout: Duration) -> Result<(), String> {
    let start = Instant::now();
    loop {
        match child
            .try_wait()
            .map_err(|error| format!("Unable to wait for the media sidecar: {error}"))?
        {
            Some(status) if status.success() => return Ok(()),
            Some(status) => {
                let stderr = read_child_stderr(child);
                if stderr.is_empty() {
                    return Err(format!("The media sidecar exited with status {status}."));
                }
                return Err(format!(
                    "The media sidecar exited with status {status}: {stderr}"
                ));
            }
            None if start.elapsed() >= timeout => {
                log::error!(
                    "Media sidecar timed out; terminating process tree: process_id={}, timeout_ms={}",
                    child.id(),
                    timeout.as_millis()
                );
                #[cfg(target_os = "windows")]
                {
                    let mut taskkill = Command::new("taskkill");
                    configure_sidecar_command(&mut taskkill);
                    if let Err(error) = taskkill
                        .args(["/PID", &child.id().to_string(), "/T", "/F"])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status()
                    {
                        log::warn!("Unable to run taskkill for timed-out sidecar: process_id={}, error={error}", child.id());
                    }
                }
                if let Err(error) = child.kill() {
                    log::warn!(
                        "Unable to kill timed-out sidecar directly: process_id={}, error={error}",
                        child.id()
                    );
                }
                if let Err(error) = child.wait() {
                    log::warn!(
                        "Unable to reap timed-out sidecar: process_id={}, error={error}",
                        child.id()
                    );
                }
                return Err("The media sidecar timed out.".to_string());
            }
            None => thread::sleep(Duration::from_millis(100)),
        }
    }
}
