use super::*;

pub(super) fn folder_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| path_string(path))
}

pub(super) fn backup_corrupt_config(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    let backup_dir = app_data_dir()?.join("backups");
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let backup_path = backup_dir.join(format!("config-corrupt-{timestamp}.json"));
    fs::copy(path, backup_path)
        .map_err(|error| format!("Unable to back up the invalid configuration: {error}"))?;
    Ok(())
}

pub(super) fn validate_config(config: &mut AppConfig) -> Result<(), String> {
    if !matches!(
        config.settings.appearance.as_str(),
        "system" | "dark" | "light"
    ) {
        return Err("Appearance must be system, dark, or light.".to_string());
    }
    if !matches!(
        config.settings.accent_theme.as_str(),
        "teal" | "sky" | "amber" | "coral" | "lime"
    ) {
        return Err("The selected accent theme is not supported.".to_string());
    }
    if !(0.25..=100.0).contains(&config.settings.thumbnail_cache_gb) {
        return Err("Thumbnail cache size must be between 0.25 and 100 GB.".to_string());
    }
    if !matches!(
        config.settings.thumbnail_capture_position.as_str(),
        "opening" | "early" | "middle" | "late" | "ending"
    ) {
        return Err("Thumbnail capture position is not supported.".to_string());
    }

    config.settings.volume = config.settings.volume.min(100);
    domain::normalize_extensions(&mut config.settings.video_extensions);
    domain::normalize_extensions(&mut config.settings.managed_video_extensions);

    if config.settings.video_extensions.is_empty() {
        return Err("At least one supported video extension is required.".to_string());
    }
    for extension in &config.settings.video_extensions {
        if !config.settings.managed_video_extensions.contains(extension) {
            config
                .settings
                .managed_video_extensions
                .push(extension.clone());
        }
    }
    config.settings.managed_video_extensions.sort();
    config.settings.managed_video_extensions.dedup();
    config
        .workspace_sort
        .retain(|_, sort| domain::is_supported_sort_key(&sort.key));

    // The filename is always the first visible column; other metadata columns may be rearranged.
    domain::normalize_list_columns(&mut config.settings.list_columns);

    // Normalize and de-duplicate favorites before writing so a path has one stable identity.
    let mut known_paths = HashSet::new();
    config.favorites.retain_mut(|favorite| {
        let normalized_path = path_string(&PathBuf::from(&favorite.path));
        if !known_paths.insert(normalized_path.to_ascii_lowercase()) {
            return false;
        }
        favorite.path = normalized_path;
        if favorite.name.trim().is_empty() {
            favorite.name = folder_name(Path::new(&favorite.path));
        }
        true
    });
    config
        .favorites
        .sort_by_key(|favorite| favorite.name.to_lowercase());
    config.version = CONFIG_VERSION;
    Ok(())
}

pub(super) fn write_config(config: &AppConfig) -> Result<(), String> {
    let path = config_path()?;
    let temporary_path = path.with_extension("json.tmp");
    let serialized = serde_json::to_string_pretty(config)
        .map_err(|error| format!("Unable to serialize the configuration: {error}"))?;

    fs::write(&temporary_path, serialized)
        .map_err(|error| format!("Unable to stage the configuration: {error}"))?;
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|error| format!("Unable to replace the previous configuration: {error}"))?;
    }
    fs::rename(&temporary_path, &path)
        .map_err(|error| format!("Unable to commit the configuration: {error}"))?;
    Ok(())
}

pub(super) fn load_config() -> Result<AppConfig, String> {
    let path = config_path()?;
    if !path.exists() {
        let config = AppConfig::default();
        write_config(&config)?;
        return Ok(config);
    }

    let source = fs::read_to_string(&path)
        .map_err(|error| format!("Unable to read the configuration: {error}"))?;
    let mut config = match serde_json::from_str::<AppConfig>(&source) {
        Ok(config) => config,
        Err(_) => {
            backup_corrupt_config(&path)?;
            let config = AppConfig::default();
            write_config(&config)?;
            return Ok(config);
        }
    };

    if validate_config(&mut config).is_err() {
        backup_corrupt_config(&path)?;
        let config = AppConfig::default();
        write_config(&config)?;
        return Ok(config);
    }

    Ok(config)
}

pub(super) fn is_supported_video_path(path: &Path, settings: &Preferences) -> bool {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| format!(".{}", extension.to_ascii_lowercase()))
        .unwrap_or_default();
    settings
        .video_extensions
        .iter()
        .any(|configured| configured == &extension)
}
