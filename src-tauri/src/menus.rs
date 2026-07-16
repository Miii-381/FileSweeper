use super::*;

pub(super) fn show_file_context_menu(
    window: tauri::WebviewWindow,
    path: String,
    paths: Option<Vec<String>>,
    x: f64,
    y: f64,
    is_directory: bool,
    state: tauri::State<ContextMenuState>,
) -> Result<(), String> {
    let target = fs::canonicalize(path)
        .map_err(|error| format!("Unable to access the selected item: {error}"))?;
    let metadata = fs::metadata(&target)
        .map_err(|error| format!("Unable to inspect the selected item: {error}"))?;
    if metadata.is_dir() != is_directory {
        return Err("The selected item type has changed.".to_string());
    }
    let operation_paths = if is_directory {
        vec![target.clone()]
    } else {
        normalize_video_paths(paths.unwrap_or_else(|| vec![path_string(&target)]))?
    };

    let open = MenuItem::with_id(
        &window,
        "context-menu-open",
        if is_directory {
            "打开文件夹"
        } else {
            "打开"
        },
        true,
        None::<&str>,
    )
    .map_err(|error| format!("Unable to create the context menu: {error}"))?;
    let reveal = MenuItem::with_id(
        &window,
        "context-menu-reveal",
        "在资源管理器中显示",
        true,
        None::<&str>,
    )
    .map_err(|error| format!("Unable to create the context menu: {error}"))?;
    let refresh = MenuItem::with_id(&window, "context-menu-refresh", "刷新", true, None::<&str>)
        .map_err(|error| format!("Unable to create the context menu: {error}"))?;
    let menu = if is_directory {
        Menu::with_items(&window, &[&open, &reveal, &refresh])
    } else {
        let copy_to = MenuItem::with_id(
            &window,
            "context-menu-copy-to",
            "复制到…",
            true,
            None::<&str>,
        )
        .map_err(|error| format!("Unable to create the context menu: {error}"))?;
        let delete = MenuItem::with_id(
            &window,
            "context-menu-delete",
            "移到回收站",
            true,
            None::<&str>,
        )
        .map_err(|error| format!("Unable to create the context menu: {error}"))?;
        Menu::with_items(&window, &[&open, &reveal, &refresh, &copy_to, &delete])
    }
    .map_err(|error| format!("Unable to create the context menu: {error}"))?;

    // The menu event does not carry arbitrary payloads, so retain only the latest checked target.
    *state
        .0
        .lock()
        .map_err(|_| "Unable to access the context menu state.".to_string())? =
        Some(ContextMenuTarget {
            path: target,
            operation_paths,
            is_directory,
        });
    menu.popup_at(window.as_ref().window(), LogicalPosition::new(x, y))
        .map_err(|error| format!("Unable to show the context menu: {error}"))
}

pub(super) fn open_context_target(target: &ContextMenuTarget) -> Result<(), String> {
    Command::new("explorer.exe")
        .arg(&target.path)
        .spawn()
        .map_err(|error| format!("Unable to open the selected item: {error}"))?;
    Ok(())
}

pub(super) fn reveal_context_target(target: &ContextMenuTarget) -> Result<(), String> {
    if target.is_directory {
        return open_context_target(target);
    }

    Command::new("explorer.exe")
        .arg(format!("/select,{}", path_string(&target.path)))
        .spawn()
        .map_err(|error| format!("Unable to show the selected item: {error}"))?;
    Ok(())
}
