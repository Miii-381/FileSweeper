use super::*;
use tauri::{PhysicalPosition, PhysicalSize};

const WINDOW_STATE_VERSION: u32 = 1;

fn window_state_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("window-state.json"))
}

fn write_window_state(state: &WindowState) -> Result<(), String> {
    let path = window_state_path()?;
    let temporary = path.with_extension("json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(state)
            .map_err(|error| format!("Unable to serialize window state: {error}"))?,
    )
    .map_err(|error| format!("Unable to write window state: {error}"))?;
    atomic_replace_file(&temporary, &path, "window state")
}

pub(super) fn load_window_state() -> WindowState {
    let Ok(path) = window_state_path() else {
        return WindowState::default();
    };
    let Ok(bytes) = fs::read(&path) else {
        return WindowState::default();
    };
    match serde_json::from_slice::<WindowState>(&bytes) {
        Ok(mut state) if state.version == WINDOW_STATE_VERSION => {
            state.width = state.width.clamp(1024, 16_384);
            state.height = state.height.clamp(650, 16_384);
            state.left_panel_size = state.left_panel_size.clamp(0, 60);
            state
        }
        Ok(_) | Err(_) => {
            log::warn!("Window state is invalid; using the safe default layout");
            WindowState::default()
        }
    }
}

pub(super) fn restore_main_window(window: &tauri::WebviewWindow) {
    let state = load_window_state();
    let monitor = window.current_monitor().ok().flatten();
    let (width, height, x, y) = if let Some(monitor) = monitor {
        let work_area = monitor.work_area();
        let width = state
            .width
            .min(work_area.size.width)
            .max(1024.min(work_area.size.width));
        let height = state
            .height
            .min(work_area.size.height)
            .max(650.min(work_area.size.height));
        let max_x = work_area
            .position
            .x
            .saturating_add(work_area.size.width.saturating_sub(width) as i32);
        let max_y = work_area
            .position
            .y
            .saturating_add(work_area.size.height.saturating_sub(height) as i32);
        (
            width,
            height,
            state.x.clamp(work_area.position.x, max_x),
            state.y.clamp(work_area.position.y, max_y),
        )
    } else {
        (state.width, state.height, state.x, state.y)
    };
    if let Err(error) = window.set_size(PhysicalSize::new(width, height)) {
        log::warn!("Unable to restore window size: {error}");
    }
    if let Err(error) = window.set_position(PhysicalPosition::new(x, y)) {
        log::warn!("Unable to restore window position: {error}");
    }
    if state.maximized {
        if let Err(error) = window.maximize() {
            log::warn!("Unable to restore maximized window: {error}");
        }
    }
}

#[tauri::command]
pub(super) fn get_window_state() -> WindowState {
    load_window_state()
}

#[tauri::command]
pub(super) fn save_window_layout(
    left_panel_size: u8,
    preview_open: bool,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    let mut state = load_window_state();
    let position = window
        .outer_position()
        .map_err(|error| format!("Unable to read window position: {error}"))?;
    let size = window
        .outer_size()
        .map_err(|error| format!("Unable to read window size: {error}"))?;
    state.version = WINDOW_STATE_VERSION;
    state.x = position.x;
    state.y = position.y;
    state.width = size.width;
    state.height = size.height;
    state.maximized = window.is_maximized().unwrap_or(false);
    state.left_panel_size = left_panel_size.clamp(0, 60);
    state.preview_open = preview_open;
    write_window_state(&state)
}
