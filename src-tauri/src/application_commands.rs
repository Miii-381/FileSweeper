use super::*;

#[tauri::command]
pub(super) fn load_application_state() -> Result<ApplicationState, String> {
    log::info!("Loading application state");
    let config = load_config()?;
    let roots = available_roots(&config.settings);
    log::info!(
        "Application state loaded: config_version={}, roots={}, favorites={}, last_workspace={}, sidecar_concurrency={}",
        config.version,
        roots.len(),
        config.favorites.len(),
        config.last_workspace.as_deref().unwrap_or("<none>"),
        config.settings.background_sidecar_concurrency
    );
    Ok(ApplicationState {
        roots,
        config,
        settings_limits: SettingsLimits {
            background_sidecar_concurrency_min: 1,
            background_sidecar_concurrency_max: available_parallelism(),
        },
    })
}

#[tauri::command]
pub(super) fn is_running_as_administrator() -> bool {
    let elevated = {
        #[cfg(target_os = "windows")]
        unsafe {
            IsUserAnAdmin().as_bool()
        }
        #[cfg(not(target_os = "windows"))]
        {
            false
        }
    };
    log::debug!("Administrator status checked: elevated={elevated}");
    elevated
}

#[tauri::command]
pub(super) async fn list_subdirectories(path: String) -> Result<DirectoryChildren, String> {
    tauri::async_runtime::spawn_blocking(move || {
        log::debug!("Listing directory tree children: {path}");
        let config = load_config()?;
        list_subdirectories_impl(&path, &config.settings)
            .inspect(|listing| {
                log::debug!(
                    "Directory tree children listed: path={}, folders={}",
                    listing.path,
                    listing.folders.len()
                );
            })
            .inspect_err(|error| {
                log::warn!("Directory tree listing failed: path={path}, error={error}")
            })
    })
    .await
    .map_err(|error| {
        log::error!("Directory tree worker failed: {error}");
        format!("The directory tree worker failed: {error}")
    })?
}

#[tauri::command]
pub(super) fn set_directory_tree_watch_paths(
    paths: Vec<String>,
    watch_state: tauri::State<'_, DirectoryTreeWatchState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    log::debug!(
        "Updating directory tree watcher paths: count={}",
        paths.len()
    );
    watch_state
        .set_paths(paths, &app_handle)
        .inspect_err(|error| log::warn!("Unable to update directory tree watchers: {error}"))
}

#[tauri::command]
pub(super) async fn workspace_is_accessible(
    path: String,
    watch_state: tauri::State<'_, WorkspaceWatchState>,
) -> Result<bool, String> {
    let checked_path = PathBuf::from(&path);
    let worker_path = checked_path.clone();
    let accessible = tauri::async_runtime::spawn_blocking(move || {
        fs::metadata(&worker_path).is_ok_and(|metadata| metadata.is_dir())
            && fs::read_dir(&worker_path).is_ok()
    })
    .await
    .map_err(|error| {
        log::error!("Workspace availability worker failed: path={path}, error={error}");
        format!("The workspace availability worker failed: {error}")
    })?;
    if !accessible {
        log::warn!("Workspace accessibility check failed: path={path}");
        watch_state.clear_path(&checked_path);
    }
    Ok(accessible)
}

#[tauri::command]
pub(super) async fn list_directory(
    path: String,
    request_id: u64,
    thumbnail_index: tauri::State<'_, MediaCacheIndexState>,
    thumbnail_cache_directory: tauri::State<'_, ThumbnailCacheDirectory>,
    watch_state: tauri::State<'_, WorkspaceWatchState>,
    app_handle: tauri::AppHandle,
) -> Result<DirectoryListing, String> {
    watch_state.begin(request_id);
    let latest_request = watch_state.cancellation_token();
    let thumbnail_index = Arc::clone(&thumbnail_index.0);
    let thumbnail_cache_dir = thumbnail_cache_directory.0.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        log::info!("Listing directory: {path}");
        let config = load_config()?;
        let listing = list_directory_impl(
            &path,
            &config.settings,
            &thumbnail_index,
            &thumbnail_cache_dir,
            &|| latest_request.load(Ordering::Acquire) != request_id,
        )?;
        log::info!(
            "Listed directory: {} items={}, media_suppressed={}",
            listing.path,
            listing.items.len(),
            listing.media_suppressed
        );
        Ok::<DirectoryListing, String>(listing)
    })
    .await
    .map_err(|error| format!("The workspace worker failed: {error}"))?;
    match result {
        Ok(listing) => {
            watch_state.watch_if_latest(request_id, Path::new(&listing.path), &app_handle)?;
            log::debug!(
                "Directory listing command completed: request_id={request_id}, path={}, items={}",
                listing.path,
                listing.items.len()
            );
            Ok(listing)
        }
        Err(error) => {
            watch_state.clear_if_latest(request_id);
            if error == WORKSPACE_SCAN_CANCELLED {
                log::debug!("Workspace scan superseded: request_id={request_id}");
            } else {
                log::warn!("Workspace scan failed: request_id={request_id}, error={error}");
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub(super) async fn list_folder_thumbnail_sources(
    paths: Vec<String>,
    thumbnail_index: tauri::State<'_, MediaCacheIndexState>,
    thumbnail_cache_directory: tauri::State<'_, ThumbnailCacheDirectory>,
) -> Result<Vec<FolderThumbnailSources>, String> {
    let thumbnail_index = Arc::clone(&thumbnail_index.0);
    let thumbnail_cache_dir = thumbnail_cache_directory.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let settings = load_config()?.settings;
        Ok::<_, String>(list_folder_thumbnail_sources_impl(
            paths,
            &settings,
            &thumbnail_index,
            &thumbnail_cache_dir,
        ))
    })
    .await
    .map_err(|error| format!("The folder thumbnail worker failed: {error}"))?
}

#[tauri::command]
pub(super) fn save_configuration(
    settings: Preferences,
    thumbnail_cache_directory: tauri::State<'_, ThumbnailCacheDirectory>,
    thumbnail_cache: tauri::State<'_, ThumbnailCacheMaintenanceState>,
    media_sidecar_pool: tauri::State<'_, MediaSidecarPool>,
) -> Result<AppConfig, String> {
    let previous_background = load_config()?.settings.background_image;
    log::info!(
        "Saving application settings: appearance={}, accent={}, thumbnail_cache_gb={}, capture_position={}, autoplay={}, volume={}, muted={}, hidden={}, nomedia={}, video_extensions={}, audio_extensions={}, image_extensions={}, text_extensions={}, sidecar_concurrency={}, list_columns={}",
        settings.appearance,
        settings.accent_theme,
        settings.thumbnail_cache_gb,
        settings.thumbnail_capture_position,
        settings.autoplay,
        settings.volume,
        settings.muted,
        settings.show_hidden_items,
        settings.show_nomedia_media,
        settings.video_extensions.len(),
        settings.audio_extensions.len(),
        settings.image_extensions.len(),
        settings.text_extensions.len(),
        settings.background_sidecar_concurrency,
        settings.list_columns.len()
    );
    let configuration = update_config(move |config| {
        config.settings = settings;
        Ok(())
    })
    .map_err(|error| {
        log::error!("Unable to persist application settings: {error}");
        error
    })?;
    media_sidecar_pool
        .0
        .set_limit(configuration.settings.background_sidecar_concurrency)
        .map_err(|error| {
            log::error!(
                "Settings were persisted but the sidecar limit could not be applied: {error}"
            );
            error
        })?;
    maintain_thumbnail_cache(
        &thumbnail_cache_directory.0,
        &thumbnail_cache.index,
        &thumbnail_cache.lock,
        thumbnail_cache_limit_bytes(configuration.settings.thumbnail_cache_gb),
    )
    .map_err(|error| {
        log::error!("Settings were persisted but media cache maintenance failed: {error}");
        error
    })?;
    log::info!(
        "Application settings saved: config_version={}, sidecar_concurrency={}",
        configuration.version,
        configuration.settings.background_sidecar_concurrency
    );
    if previous_background != configuration.settings.background_image {
        if let Some(previous_background) = previous_background {
            maintenance_commands::remove_managed_background(&previous_background);
        }
    }
    Ok(configuration)
}

#[tauri::command]
pub(super) fn set_audio_preferences(volume: u8, muted: bool) -> Result<AppConfig, String> {
    log::debug!("Saving audio preferences: volume={volume}, muted={muted}");
    update_config(move |config| {
        config.settings.volume = volume;
        config.settings.muted = muted;
        Ok(())
    })
    .inspect(|config| {
        log::debug!(
            "Audio preferences saved: volume={}, muted={}",
            config.settings.volume,
            config.settings.muted
        );
    })
    .inspect_err(|error| log::warn!("Unable to save audio preferences: {error}"))
}

#[tauri::command]
pub(super) fn set_list_columns(list_columns: Vec<ListColumn>) -> Result<AppConfig, String> {
    log::info!("Saving list column layout: columns={}", list_columns.len());
    update_config(move |config| {
        config.settings.list_columns = list_columns;
        Ok(())
    })
    .inspect(|config| {
        log::info!(
            "List column layout saved: columns={}",
            config.settings.list_columns.len()
        );
    })
    .inspect_err(|error| log::warn!("Unable to save list column layout: {error}"))
}

#[tauri::command]
pub(super) fn set_last_workspace(path: Option<String>) -> Result<AppConfig, String> {
    log::info!(
        "Updating last workspace: requested={}",
        path.as_deref().unwrap_or("<none>")
    );
    let normalized = if let Some(path) = path {
        let directory = fs::canonicalize(path).map_err(|error| {
            log::warn!("Last workspace path could not be resolved: {error}");
            format!("Unable to use this folder as a workspace: {error}")
        })?;
        if !directory.is_dir() {
            return Err("The selected workspace is not a folder.".to_string());
        }
        Some(path_string(&directory))
    } else {
        None
    };
    update_config(move |config| {
        config.last_workspace = normalized;
        Ok(())
    })
    .inspect(|config| {
        log::info!(
            "Last workspace updated: current={}",
            config.last_workspace.as_deref().unwrap_or("<none>")
        );
    })
    .inspect_err(|error| log::warn!("Unable to update last workspace: {error}"))
}

#[tauri::command]
pub(super) fn set_workspace_focus(workspace_path: String, file_path: String) -> Result<(), String> {
    log::debug!(
        "Persisting workspace focus request: workspace={}, file={}",
        workspace_path,
        file_path
    );
    let workspace = fs::canonicalize(workspace_path).map_err(|error| {
        log::warn!("Unable to resolve focus workspace: {error}");
        format!("Unable to access the workspace for focus persistence: {error}")
    })?;
    if !workspace.is_dir() {
        log::warn!(
            "Rejected focus workspace because it is not a directory: {:?}",
            workspace
        );
        return Err("The focus workspace is not a folder.".to_string());
    }
    let file = fs::canonicalize(file_path).map_err(|error| {
        log::warn!("Unable to resolve focused file: {error}");
        format!("Unable to access the focused file: {error}")
    })?;
    if !file.is_file() {
        log::warn!(
            "Rejected focus file because it is not a regular file: {:?}",
            file
        );
        return Err("The focused item is not a regular file.".to_string());
    }
    let parent = file.parent().ok_or_else(|| {
        log::warn!("Focused file has no parent folder: {:?}", file);
        "Unable to resolve the focused file's parent folder.".to_string()
    })?;
    let file_parent = fs::canonicalize(parent).map_err(|error| {
        log::warn!(
            "Unable to resolve parent folder for focused file: file={:?}, error={error}",
            file
        );
        format!("Unable to resolve the focused file's parent folder: {error}")
    })?;
    if file_parent != workspace {
        log::warn!(
            "Rejected focus file outside workspace: workspace={:?}, file_parent={:?}",
            workspace,
            file_parent
        );
        return Err("The focused file is not a direct item of the workspace.".to_string());
    }

    let normalized_workspace = path_string(&workspace);
    let normalized_file = path_string(&file);
    let log_workspace = normalized_workspace.clone();
    let log_file = normalized_file.clone();
    update_workspace_state(move |config| {
        config.workspace_focus.insert(
            normalized_workspace,
            WorkspaceFocus {
                file_path: normalized_file,
            },
        );
        Ok(())
    })?;
    log::debug!(
        "Persisted workspace focus: workspace={}, current={}",
        log_workspace,
        log_file
    );
    Ok(())
}

#[tauri::command]
pub(super) fn set_workspace_sort(
    workspace_path: String,
    sort_key: String,
    sort_ascending: bool,
) -> Result<(), String> {
    log::debug!(
        "Persisting workspace sort request: workspace={workspace_path}, key={sort_key}, ascending={sort_ascending}"
    );
    if !domain::is_supported_sort_key(&sort_key) {
        log::warn!("Rejected unsupported workspace sort key: {sort_key}");
        return Err("The workspace sort key is not supported.".to_string());
    }
    let workspace = fs::canonicalize(workspace_path).map_err(|error| {
        log::warn!("Unable to resolve workspace for sort persistence: {error}");
        format!("Unable to access the workspace for sort persistence: {error}")
    })?;
    if !workspace.is_dir() {
        log::warn!(
            "Rejected sort workspace because it is not a directory: {:?}",
            workspace
        );
        return Err("The sort workspace is not a folder.".to_string());
    }

    let normalized_workspace = path_string(&workspace);
    let log_workspace = normalized_workspace.clone();
    let log_sort_key = sort_key.clone();
    update_workspace_state(move |config| {
        config.workspace_sort.insert(
            normalized_workspace,
            WorkspaceSort {
                key: sort_key,
                ascending: sort_ascending,
            },
        );
        Ok(())
    })?;
    log::debug!(
        "Persisted workspace sort: workspace={}, key={}, ascending={}",
        log_workspace,
        log_sort_key,
        sort_ascending
    );
    Ok(())
}

#[tauri::command]
pub(super) fn toggle_favorite(path: String) -> Result<AppConfig, String> {
    log::info!("Toggling favorite folder: requested_path={path}");
    let directory = fs::canonicalize(path).map_err(|error| {
        log::warn!("Favorite folder path could not be resolved: {error}");
        format!("Unable to update the favorite folder: {error}")
    })?;
    if !directory.is_dir() {
        log::warn!(
            "Favorite request rejected because the path is not a directory: {:?}",
            directory
        );
        return Err("Favorites must be folders.".to_string());
    }
    let normalized_path = path_string(&directory);
    let log_path = normalized_path.clone();
    let name = folder_name(&directory);
    update_config(move |config| {
        if let Some(index) = config
            .favorites
            .iter()
            .position(|favorite| favorite.path.eq_ignore_ascii_case(&normalized_path))
        {
            config.favorites.remove(index);
        } else {
            config.favorites.push(FavoriteFolder {
                name,
                path: normalized_path,
            });
        }
        Ok(())
    })
    .inspect(|config| {
        let is_favorite = config
            .favorites
            .iter()
            .any(|favorite| favorite.path.eq_ignore_ascii_case(&log_path));
        log::info!(
            "Favorite folder toggled: path={log_path}, favorite={is_favorite}, total={}",
            config.favorites.len()
        );
    })
    .inspect_err(|error| log::warn!("Unable to toggle favorite folder {log_path}: {error}"))
}
