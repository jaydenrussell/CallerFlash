use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

use crate::error::CommandError;

pub struct SecureStorage {
    settings_path: PathBuf,
    backup_path: PathBuf,
    tmp_path: PathBuf,
}

impl SecureStorage {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            settings_path: data_dir.join("settings.json"),
            backup_path: data_dir.join("settings.json.bak"),
            tmp_path: data_dir.join("settings.json.tmp"),
        }
    }

    pub fn load_data(&self) -> serde_json::Value {
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

    pub fn save_data(&self, data: &serde_json::Value) -> Result<(), CommandError> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_storage() -> (SecureStorage, tempfile::TempDir) {
        let dir = tempfile::TempDir::with_prefix("callerflash-test-").unwrap();
        let storage = SecureStorage::new(dir.path().to_path_buf());
        (storage, dir)
    }

    fn assert_file(path: &PathBuf, expected: &str) {
        let content = fs::read_to_string(path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
        let expected_parsed: serde_json::Value = serde_json::from_str(expected).unwrap();
        assert_eq!(parsed, expected_parsed);
    }

    #[test]
    fn test_save_and_load_roundtrip() {
        let (storage, _dir) = temp_storage();
        let data = serde_json::json!({"sip": {"server": "sip.example.com", "port": 5060}});
        storage.save_data(&data).unwrap();
        let loaded = storage.load_data();
        assert_eq!(loaded, data);
    }

    #[test]
    fn test_load_returns_empty_on_missing() {
        let (storage, _dir) = temp_storage();
        let loaded = storage.load_data();
        assert_eq!(loaded, serde_json::json!({}));
    }

    #[test]
    fn test_load_restores_from_backup_when_main_corrupted() {
        let (storage, _dir) = temp_storage();
        let backup = serde_json::json!({"version": 2, "sip": {"server": "backup.example.com"}});
        fs::write(
            &storage.backup_path,
            serde_json::to_string_pretty(&backup).unwrap(),
        )
        .unwrap();
        fs::write(&storage.settings_path, "not valid json {{{").unwrap();
        let loaded = storage.load_data();
        assert_eq!(loaded, backup);
        assert_file(
            &storage.settings_path,
            r#"{"version":2,"sip":{"server":"backup.example.com"}}"#,
        );
    }

    #[test]
    fn test_save_creates_backup_of_previous_data() {
        let (storage, _dir) = temp_storage();
        let data1 = serde_json::json!({"version": 1});
        let data2 = serde_json::json!({"version": 2});
        storage.save_data(&data1).unwrap();
        storage.save_data(&data2).unwrap();
        let backup_loaded: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&storage.backup_path).unwrap()).unwrap();
        assert_eq!(backup_loaded, data1);
    }

    #[test]
    fn test_atomic_write_orphan_tmp_does_not_affect_load() {
        let (storage, _dir) = temp_storage();
        let data = serde_json::json!({"version": 1});
        storage.save_data(&data).unwrap();
        // Orphan .tmp with different data
        let bogus = serde_json::json!({"version": 99});
        fs::write(
            &storage.tmp_path,
            serde_json::to_string_pretty(&bogus).unwrap(),
        )
        .unwrap();
        let loaded = storage.load_data();
        assert_eq!(loaded, data);
        // Cleanup orphan for clean dir deletion
        let _ = fs::remove_file(&storage.tmp_path);
    }

    #[test]
    fn test_save_errors_on_invalid_path() {
        let storage = SecureStorage::new(PathBuf::from(r#"\0invalid"#));
        let data = serde_json::json!({"key": "value"});
        let result = storage.save_data(&data);
        assert!(result.is_err());
    }
}
