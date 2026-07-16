use super::*;

const WORKSPACE_STATE_VERSION: u32 = 1;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedConfig {
    version: u32,
    favorites: Vec<FavoriteFolder>,
    last_workspace: Option<String>,
    settings: Preferences,
}

impl From<&AppConfig> for PersistedConfig {
    fn from(config: &AppConfig) -> Self {
        Self {
            version: config.version,
            favorites: config.favorites.clone(),
            last_workspace: config.last_workspace.clone(),
            settings: config.settings.clone(),
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceStateFile {
    version: u32,
    #[serde(default)]
    workspace_focus: HashMap<String, WorkspaceFocus>,
    #[serde(default)]
    workspace_sort: HashMap<String, WorkspaceSort>,
}

impl WorkspaceStateFile {
    fn from_config(config: &AppConfig) -> Self {
        Self {
            version: WORKSPACE_STATE_VERSION,
            workspace_focus: config.workspace_focus.clone(),
            workspace_sort: config.workspace_sort.clone(),
        }
    }

    fn validate(&mut self) -> Result<(), String> {
        if self.version != WORKSPACE_STATE_VERSION {
            return Err(format!(
                "Workspace state version {} is not supported.",
                self.version
            ));
        }
        self.workspace_sort
            .retain(|_, sort| domain::is_supported_sort_key(&sort.key));
        Ok(())
    }
}

pub(super) struct ConfigStore {
    config_path: PathBuf,
    workspace_state_path: PathBuf,
    state: Mutex<AppConfig>,
}

impl ConfigStore {
    pub(super) fn open(config_path: PathBuf) -> Result<Self, String> {
        let mut config = load_config_from_path(&config_path)?;
        let workspace_state_path = config_path
            .parent()
            .ok_or_else(|| "Unable to resolve the configuration directory.".to_string())?
            .join("workspace-state.json");
        let workspace_state = load_workspace_state_from_path(
            &workspace_state_path,
            WorkspaceStateFile::from_config(&config),
        )?;
        config.workspace_focus = workspace_state.workspace_focus;
        config.workspace_sort = workspace_state.workspace_sort;
        Ok(Self {
            config_path,
            workspace_state_path,
            state: Mutex::new(config),
        })
    }

    pub(super) fn snapshot(&self) -> Result<AppConfig, String> {
        self.state
            .lock()
            .map(|config| config.clone())
            .map_err(|_| "Unable to access the configuration state.".to_string())
    }

    pub(super) fn update_config<F>(&self, update: F) -> Result<AppConfig, String>
    where
        F: FnOnce(&mut AppConfig) -> Result<(), String>,
    {
        let mut current = self
            .state
            .lock()
            .map_err(|_| "Unable to access the configuration state.".to_string())?;
        let mut next = current.clone();
        update(&mut next)?;
        validate_config(&mut next)?;
        write_config_to_path(&self.config_path, &next)?;
        *current = next.clone();
        Ok(next)
    }

    pub(super) fn update_workspace_state<F>(&self, update: F) -> Result<AppConfig, String>
    where
        F: FnOnce(&mut AppConfig) -> Result<(), String>,
    {
        let mut current = self
            .state
            .lock()
            .map_err(|_| "Unable to access the workspace state.".to_string())?;
        let mut next = current.clone();
        update(&mut next)?;
        let mut workspace_state = WorkspaceStateFile::from_config(&next);
        workspace_state.validate()?;
        write_workspace_state_to_path(&self.workspace_state_path, &workspace_state)?;
        next.workspace_focus = workspace_state.workspace_focus;
        next.workspace_sort = workspace_state.workspace_sort;
        *current = next.clone();
        Ok(next)
    }
}

pub(super) fn folder_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| path_string(path))
}

fn backup_corrupt_file(path: &Path, prefix: &str) -> Result<Option<PathBuf>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let backup_dir = path
        .parent()
        .ok_or_else(|| "Unable to resolve the configuration directory.".to_string())?
        .join("backups");
    fs::create_dir_all(&backup_dir)
        .map_err(|error| format!("Unable to create the configuration backup directory: {error}"))?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let backup_path = backup_dir.join(format!("{prefix}-corrupt-{timestamp}.json"));
    fs::copy(path, &backup_path)
        .map_err(|error| format!("Unable to back up the invalid {prefix}: {error}"))?;
    Ok(Some(backup_path))
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
    domain::normalize_list_columns(&mut config.settings.list_columns);

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

fn write_json_atomically<T: Serialize>(
    path: &Path,
    value: &T,
    temporary_prefix: &str,
    label: &str,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Unable to resolve the configuration directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Unable to create the configuration directory: {error}"))?;
    let serialized = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Unable to serialize the {label}: {error}"))?;
    let temporary_path = parent.join(format!(
        ".{temporary_prefix}-{}-{}.tmp",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    ));

    let result = (|| {
        let mut temporary = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
            .map_err(|error| format!("Unable to stage the {label}: {error}"))?;
        std::io::Write::write_all(&mut temporary, &serialized)
            .map_err(|error| format!("Unable to stage the {label}: {error}"))?;
        temporary
            .sync_all()
            .map_err(|error| format!("Unable to flush the staged {label}: {error}"))?;
        drop(temporary);
        atomic_replace_file(&temporary_path, path, label)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

fn write_config_to_path(path: &Path, config: &AppConfig) -> Result<(), String> {
    write_json_atomically(
        path,
        &PersistedConfig::from(config),
        "config",
        "configuration",
    )
}

fn write_workspace_state_to_path(
    path: &Path,
    workspace_state: &WorkspaceStateFile,
) -> Result<(), String> {
    write_json_atomically(path, workspace_state, "workspace-state", "workspace state")
}

fn migrate_config_source(source: &str) -> Result<(AppConfig, bool), String> {
    let value: serde_json::Value = serde_json::from_str(source)
        .map_err(|error| format!("Unable to parse the configuration: {error}"))?;
    let version = value
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "The configuration version is missing or invalid.".to_string())?;
    if version == 0 || version > u64::from(CONFIG_VERSION) {
        return Err(format!("Configuration version {version} is not supported."));
    }

    let contains_legacy_workspace_state =
        value.get("workspaceFocus").is_some() || value.get("workspaceSort").is_some();
    let mut config: AppConfig = serde_json::from_value(value)
        .map_err(|error| format!("Unable to decode the configuration: {error}"))?;
    let migrated = config.version != CONFIG_VERSION || contains_legacy_workspace_state;
    validate_config(&mut config)?;
    Ok((config, migrated))
}

fn load_config_from_path(path: &Path) -> Result<AppConfig, String> {
    if !path.exists() {
        let config = AppConfig::default();
        write_config_to_path(path, &config)?;
        return Ok(config);
    }

    let source = fs::read_to_string(path)
        .map_err(|error| format!("Unable to read the configuration: {error}"))?;
    match migrate_config_source(&source) {
        Ok((config, migrated)) => {
            if migrated {
                write_config_to_path(path, &config)?;
            }
            Ok(config)
        }
        Err(error) => {
            let backup = backup_corrupt_file(path, "config")?;
            log::warn!(
                "Configuration recovery was required: {error}; backup={}",
                backup
                    .as_deref()
                    .map(path_string)
                    .unwrap_or_else(|| "<none>".to_string())
            );
            let config = AppConfig::default();
            write_config_to_path(path, &config)?;
            Ok(config)
        }
    }
}

fn load_workspace_state_from_path(
    path: &Path,
    fallback: WorkspaceStateFile,
) -> Result<WorkspaceStateFile, String> {
    if !path.exists() {
        write_workspace_state_to_path(path, &fallback)?;
        return Ok(fallback);
    }

    let source = fs::read_to_string(path)
        .map_err(|error| format!("Unable to read the workspace state: {error}"))?;
    match serde_json::from_str::<WorkspaceStateFile>(&source) {
        Ok(mut workspace_state) => match workspace_state.validate() {
            Ok(()) => Ok(workspace_state),
            Err(error) => recover_workspace_state(path, fallback, error),
        },
        Err(error) => recover_workspace_state(
            path,
            fallback,
            format!("Unable to parse the workspace state: {error}"),
        ),
    }
}

fn recover_workspace_state(
    path: &Path,
    fallback: WorkspaceStateFile,
    error: String,
) -> Result<WorkspaceStateFile, String> {
    let backup = backup_corrupt_file(path, "workspace-state")?;
    log::warn!(
        "Workspace state recovery was required: {error}; backup={}",
        backup
            .as_deref()
            .map(path_string)
            .unwrap_or_else(|| "<none>".to_string())
    );
    write_workspace_state_to_path(path, &fallback)?;
    Ok(fallback)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "video-sweeper-config-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock should be after epoch")
                .as_nanos()
        ));
        fs::create_dir_all(&path).expect("test directory should be created");
        path
    }

    #[test]
    fn migrates_embedded_workspace_state_to_its_own_file() {
        let directory = test_directory("migration");
        let path = directory.join("config.json");
        let mut legacy = AppConfig {
            version: 1,
            ..AppConfig::default()
        };
        legacy.workspace_focus.insert(
            "D:\\Videos".to_string(),
            WorkspaceFocus {
                video_path: "D:\\Videos\\focused.mp4".to_string(),
            },
        );
        fs::write(&path, serde_json::to_vec_pretty(&legacy).unwrap()).unwrap();

        let store = ConfigStore::open(path.clone()).expect("legacy config should migrate");
        assert_eq!(store.snapshot().unwrap().version, CONFIG_VERSION);
        assert!(store
            .snapshot()
            .unwrap()
            .workspace_focus
            .contains_key("D:\\Videos"));
        let persisted: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(persisted.get("workspaceFocus").is_none());
        assert!(persisted.get("workspaceSort").is_none());
        let workspace_state: WorkspaceStateFile =
            serde_json::from_slice(&fs::read(directory.join("workspace-state.json")).unwrap())
                .unwrap();
        assert!(workspace_state.workspace_focus.contains_key("D:\\Videos"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn backs_up_and_recovers_corrupt_configuration() {
        let directory = test_directory("recovery");
        let path = directory.join("config.json");
        fs::write(&path, b"{ definitely not json").unwrap();

        let store = ConfigStore::open(path.clone()).expect("corrupt config should recover");
        assert_eq!(store.snapshot().unwrap().version, CONFIG_VERSION);
        let backups = fs::read_dir(directory.join("backups"))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(backups.len(), 1);
        assert_eq!(
            fs::read(backups[0].path()).unwrap(),
            b"{ definitely not json"
        );
        serde_json::from_slice::<serde_json::Value>(&fs::read(&path).unwrap()).unwrap();
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn backs_up_and_recovers_corrupt_workspace_state() {
        let directory = test_directory("workspace-recovery");
        let path = directory.join("config.json");
        let store = ConfigStore::open(path.clone()).unwrap();
        drop(store);
        fs::write(
            directory.join("workspace-state.json"),
            b"{ definitely not json",
        )
        .unwrap();

        ConfigStore::open(path).expect("corrupt workspace state should recover");
        let backups = fs::read_dir(directory.join("backups"))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(backups.len(), 1);
        assert!(backups[0]
            .file_name()
            .to_string_lossy()
            .starts_with("workspace-state-corrupt-"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn settings_and_workspace_state_are_physically_isolated() {
        let directory = test_directory("isolated-updates");
        let path = directory.join("config.json");
        let store = Arc::new(ConfigStore::open(path.clone()).unwrap());
        let settings_store = Arc::clone(&store);
        let settings = thread::spawn(move || {
            settings_store
                .update_config(|config| {
                    config.settings.volume = 42;
                    config.settings.muted = true;
                    Ok(())
                })
                .unwrap();
        });
        let focus_store = Arc::clone(&store);
        let focus = thread::spawn(move || {
            focus_store
                .update_workspace_state(|config| {
                    config.workspace_focus.insert(
                        "D:\\Videos".to_string(),
                        WorkspaceFocus {
                            video_path: "D:\\Videos\\focused.mp4".to_string(),
                        },
                    );
                    Ok(())
                })
                .unwrap();
        });
        settings.join().unwrap();
        focus.join().unwrap();

        let config = store.snapshot().unwrap();
        assert_eq!(config.settings.volume, 42);
        assert!(config.settings.muted);
        assert!(config.workspace_focus.contains_key("D:\\Videos"));
        let persisted_config: serde_json::Value =
            serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(persisted_config["settings"]["volume"], 42);
        assert!(persisted_config.get("workspaceFocus").is_none());
        let persisted_workspace: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.join("workspace-state.json")).unwrap())
                .unwrap();
        assert!(persisted_workspace.get("settings").is_none());
        assert_eq!(
            persisted_workspace["workspaceFocus"]["D:\\Videos"]["videoPath"],
            "D:\\Videos\\focused.mp4"
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
