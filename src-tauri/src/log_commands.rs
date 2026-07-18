use super::*;

#[tauri::command]
pub(super) fn poll_log_file(
    previous_hash: Option<String>,
    max_bytes: Option<u64>,
) -> Result<LogSnapshot, String> {
    // Do not log successful polls: writing that message would change the file hash on every poll.
    let path = log_path()?;
    let limit = max_bytes
        .unwrap_or(256 * 1024)
        .clamp(16 * 1024, 1024 * 1024);
    if !path.exists() {
        return Ok(log_snapshot_from_bytes(
            &path,
            &[],
            previous_hash.as_deref(),
            limit as usize,
        ));
    }

    let bytes = fs::read(&path).map_err(|error| {
        log::error!(
            "Unable to read log file snapshot: path={}, error={error}",
            path_string(&path)
        );
        format!("Unable to read the log file: {error}")
    })?;
    Ok(log_snapshot_from_bytes(
        &path,
        &bytes,
        previous_hash.as_deref(),
        limit as usize,
    ))
}
