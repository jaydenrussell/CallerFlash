use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

use crate::error::CommandError;

pub(crate) struct SecureStorage {
    settings_path: PathBuf,
    backup_path: PathBuf,
    tmp_path: PathBuf,
}

impl SecureStorage {
    pub(crate) fn new(data_dir: PathBuf) -> Self {
        Self {
            settings_path: data_dir.join("settings.json"),
            backup_path: data_dir.join("settings.json.bak"),
            tmp_path: data_dir.join("settings.json.tmp"),
        }
    }

    pub(crate) fn load_data(&self) -> serde_json::Value {
        if let Ok(raw) = fs::read_to_string(&self.settings_path) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
                return parsed;
            }
        }

        if let Ok(raw) = fs::read_to_string(&self.backup_path) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
                let _ = fs::copy(&self.backup_path, &self.settings_path);
                return parsed;
            }
        }

        serde_json::Value::Object(serde_json::Map::new())
    }

    pub(crate) fn save_data(&self, data: &serde_json::Value) -> Result<(), CommandError> {
        let output = serde_json::to_string_pretty(data)
            .map_err(|e| CommandError::config(format!("Serialize: {}", e)))?;

        if self.settings_path.exists() {
            if let Err(e) = fs::copy(&self.settings_path, &self.backup_path) {
                log::error!("[storage] Failed to create backup: {}", e);
            }
        }

        fs::write(&self.tmp_path, &output)
            .map_err(|e| CommandError::io(format!("Failed to write settings: {}", e)))?;
        fs::rename(&self.tmp_path, &self.settings_path)
            .map_err(|e| CommandError::io(format!("Failed to rename settings: {}", e)))?;

        Ok(())
    }
}

fn default_data_dir(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| {
        log::warn!("[storage] app_data_dir() failed, using executable parent");
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .unwrap_or_else(|| PathBuf::from("."))
            .join("data")
    })
}

#[tauri::command]
pub fn storage_load(app: AppHandle) -> serde_json::Value {
    let data_dir = default_data_dir(&app);
    let storage = SecureStorage::new(data_dir);
    storage.load_data()
}

#[tauri::command]
pub fn storage_save(app: AppHandle, data: serde_json::Value) -> Result<(), CommandError> {
    if !data.is_object() {
        return Err(CommandError::invalid_input(
            "Storage data must be a JSON object",
        ));
    }
    let data_dir = default_data_dir(&app);
    let storage = SecureStorage::new(data_dir);
    storage.save_data(&data)
}
