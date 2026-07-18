use super::*;

pub(super) fn load_config() -> Result<AppConfig, String> {
    CONFIG_STORE
        .get()
        .ok_or_else(|| "The configuration store is not initialized.".to_string())?
        .snapshot()
}

pub(super) fn update_config<F>(update: F) -> Result<AppConfig, String>
where
    F: FnOnce(&mut AppConfig) -> Result<(), String>,
{
    CONFIG_STORE
        .get()
        .ok_or_else(|| "The configuration store is not initialized.".to_string())?
        .update_config(update)
}

pub(super) fn update_workspace_state<F>(update: F) -> Result<AppConfig, String>
where
    F: FnOnce(&mut AppConfig) -> Result<(), String>,
{
    CONFIG_STORE
        .get()
        .ok_or_else(|| "The configuration store is not initialized.".to_string())?
        .update_workspace_state(update)
}
