use super::*;

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
            return Ok(path.clone());
        }
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
        .map(|candidate| fs::canonicalize(&candidate).unwrap_or(candidate));
    match resolved {
        Some(path) => {
            if let Ok(mut entries) = cache.lock() {
                entries.insert(name.to_string(), path.clone());
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
        // Keep background media helpers behind the interactive GUI in the Windows scheduler.
        command.creation_flags(0x0000_4000); // BELOW_NORMAL_PRIORITY_CLASS
    }
    #[cfg(not(target_os = "windows"))]
    let _ = command;
}

pub(super) fn read_child_stderr(child: &mut Child) -> String {
    let Some(mut stderr) = child.stderr.take() else {
        return String::new();
    };
    let mut output = String::new();
    let _ = stderr.read_to_string(&mut output);
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
                #[cfg(target_os = "windows")]
                {
                    let _ = Command::new("taskkill")
                        .args(["/PID", &child.id().to_string(), "/T", "/F"])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status();
                }
                let _ = child.kill();
                let _ = child.wait();
                return Err("The media sidecar timed out.".to_string());
            }
            None => thread::sleep(Duration::from_millis(100)),
        }
    }
}
