use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

use crate::error::CommandError;
use crate::secure;

pub struct SecureStorage {
    settings_path: PathBuf,
    backup_path: PathBuf,
    tmp_path: PathBuf,
}

/// Encrypt the password field under the given top-level key if present.
/// Handles both the current (`sipConfig`) and legacy (`sip`) shapes so
/// credentials are protected regardless of which the caller uses.
fn encrypt_password_field_for_key(data: &mut serde_json::Value, key: &str) {
    if let Some(password) = data.get_mut(key).and_then(|s| s.get_mut("password")) {
        if let Some(value) = password.as_str() {
            if !value.is_empty() && !secure::is_encrypted(value) {
                match secure::encrypt_string(value) {
                    Ok(encrypted) => {
                        *password = serde_json::Value::String(encrypted);
                    }
                    Err(e) => {
                        log::error!("[storage] Failed to encrypt SIP password at rest: {}", e);
                    }
                }
            }
        }
    }
}

fn encrypt_password_field(data: &mut serde_json::Value) {
    encrypt_password_field_for_key(data, "sipConfig");
    encrypt_password_field_for_key(data, "sip");
}

/// Decrypt the password field under the given top-level key if present.
fn decrypt_password_field_for_key(data: &mut serde_json::Value, key: &str) {
    if let Some(password) = data.get_mut(key).and_then(|s| s.get_mut("password")) {
        if let Some(value) = password.as_str() {
            if value.starts_with("dpapi:") {
                match secure::decrypt_string(value) {
                    Ok(plain) => {
                        *password = serde_json::Value::String(plain);
                    }
                    Err(e) => {
                        log::error!("[storage] Failed to decrypt SIP password at rest: {}", e);
                    }
                }
            }
        }
    }
}

fn decrypt_password_field(data: &mut serde_json::Value) {
    decrypt_password_field_for_key(data, "sipConfig");
    decrypt_password_field_for_key(data, "sip");
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
        let mut parsed = fs::read_to_string(&self.settings_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());

        if parsed.is_none() {
            if let Ok(raw) = fs::read_to_string(&self.backup_path) {
                if let Ok(p) = serde_json::from_str::<serde_json::Value>(&raw) {
                    let _ = fs::copy(&self.backup_path, &self.settings_path);
                    parsed = Some(p);
                }
            }
        }

        let mut data = parsed.unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()));
        decrypt_password_field(&mut data);
        data
    }

    fn read_raw_parsed(&self) -> Option<serde_json::Value> {
        let raw = fs::read_to_string(&self.settings_path).ok()?;
        serde_json::from_str::<serde_json::Value>(&raw).ok()
    }

    /// Merge `incoming` over whatever is currently stored, then persist.
    ///
    /// Merging (instead of replacing) means a partial or stale writer can
    /// never wipe keys it did not send. On top of that, an empty password
    /// never blanks a stored credential unless the caller passes the
    /// explicit `__clearSipPassword` sentinel - the belt-and-braces guard
    /// for the renderer-side hydration race that once erased credentials.
    pub fn save_data(&self, data: &serde_json::Value) -> Result<(), CommandError> {
        const CLEAR_FLAG: &str = "__clearSipPassword";
        let mut incoming = data.clone();
        let explicit_clear = incoming
            .get(CLEAR_FLAG)
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if let Some(obj) = incoming.as_object_mut() {
            obj.remove(CLEAR_FLAG);
        }

        let mut merged = self
            .read_raw_parsed()
            .unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()));
        if let (Some(dst), Some(src)) = (merged.as_object_mut(), incoming.as_object()) {
            for (key, value) in src {
                match (dst.get_mut(key), value) {
                    (Some(serde_json::Value::Object(existing)), serde_json::Value::Object(new)) => {
                        if key == "sipConfig" || key == "sip" {
                            merge_sip_section(existing, new, explicit_clear);
                        } else {
                            *existing = new.clone();
                        }
                    }
                    _ => {
                        dst.insert(key.clone(), value.clone());
                    }
                }
            }
        }

        encrypt_password_field(&mut merged);
        let output = serde_json::to_string_pretty(&merged)
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

/// Shallow-merge a sip config section while protecting any stored
/// credential: a blank incoming password is ignored unless
/// `explicit_clear` is set.
fn merge_sip_section(
    existing: &mut serde_json::Map<String, serde_json::Value>,
    incoming: &serde_json::Map<String, serde_json::Value>,
    explicit_clear: bool,
) {
    let stored_password = existing
        .get("password")
        .and_then(|p| p.as_str())
        .map(str::to_owned);
    for (k, v) in incoming {
        existing.insert(k.clone(), v.clone());
    }
    let Some(stored) = stored_password else {
        return;
    };
    if stored.is_empty() {
        return;
    }
    let incoming_blank =
        matches!(existing.get("password"), Some(serde_json::Value::String(s)) if s.is_empty());
    if incoming_blank && !explicit_clear {
        log::warn!("[storage] Ignored write that would blank the stored SIP password");
        existing.insert("password".to_string(), serde_json::Value::String(stored));
    } else if incoming_blank && explicit_clear {
        log::info!("[storage] SIP password cleared by explicit request");
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
    fn test_password_is_encrypted_at_rest() {
        let (storage, _dir) = temp_storage();
        let data = serde_json::json!({"sip": {"server": "sip.example.com", "password": "hunter2"}});
        storage.save_data(&data).unwrap();
        let raw = fs::read_to_string(&storage.settings_path).unwrap();
        let on_disk: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let password = on_disk["sip"]["password"].as_str().unwrap();
        assert!(password.starts_with("dpapi:"), "got: {}", password);
        assert_ne!(password, "hunter2");
    }

    #[test]
    fn test_password_is_encrypted_at_rest_under_sipconfig_key() {
        let (storage, _dir) = temp_storage();
        let data =
            serde_json::json!({"sipConfig": {"server": "sip.example.com", "password": "hunter2"}});
        storage.save_data(&data).unwrap();
        let raw = fs::read_to_string(&storage.settings_path).unwrap();
        let on_disk: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let password = on_disk["sipConfig"]["password"].as_str().unwrap();
        assert!(password.starts_with("dpapi:"), "got: {}", password);
        assert_ne!(password, "hunter2");
    }

    #[test]
    fn test_password_is_decrypted_on_load_under_sipconfig_key() {
        let (storage, _dir) = temp_storage();
        let data =
            serde_json::json!({"sipConfig": {"server": "sip.example.com", "password": "hunter2"}});
        storage.save_data(&data).unwrap();
        let loaded = storage.load_data();
        assert_eq!(
            loaded["sipConfig"]["password"],
            serde_json::json!("hunter2")
        );
    }

    #[test]
    fn test_password_is_decrypted_on_load() {
        let (storage, _dir) = temp_storage();
        let data = serde_json::json!({"sip": {"server": "sip.example.com", "password": "hunter2"}});
        storage.save_data(&data).unwrap();
        let loaded = storage.load_data();
        assert_eq!(loaded["sip"]["password"], serde_json::json!("hunter2"));
    }

    #[test]
    fn test_already_encrypted_password_is_not_double_encrypted() {
        let (storage, _dir) = temp_storage();
        let data = serde_json::json!({"sip": {"password": "dpapi:QWJjZA=="}});
        storage.save_data(&data).unwrap();
        let raw = fs::read_to_string(&storage.settings_path).unwrap();
        let on_disk: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            on_disk["sip"]["password"],
            serde_json::json!("dpapi:QWJjZA==")
        );
    }

    #[test]
    fn test_empty_password_stays_empty() {
        let (storage, _dir) = temp_storage();
        let data = serde_json::json!({"sip": {"password": ""}});
        storage.save_data(&data).unwrap();
        let loaded = storage.load_data();
        assert_eq!(loaded["sip"]["password"], serde_json::json!(""));
    }

    #[test]
    fn test_save_merges_top_level_keys_instead_of_replacing() {
        let (storage, _dir) = temp_storage();
        storage
            .save_data(&serde_json::json!({"sipConfig": {"server": "a.example.com"}}))
            .unwrap();
        storage
            .save_data(&serde_json::json!({"updateChannel": "beta"}))
            .unwrap();
        let loaded = storage.load_data();
        assert_eq!(loaded["updateChannel"], serde_json::json!("beta"));
        assert_eq!(
            loaded["sipConfig"]["server"],
            serde_json::json!("a.example.com")
        );
    }

    #[test]
    fn test_blank_write_cannot_erase_stored_password() {
        let (storage, _dir) = temp_storage();
        storage
            .save_data(&serde_json::json!(
                {"sipConfig": {"server": "a", "password": "hunter2"}}
            ))
            .unwrap();
        // Simulate a stale/partial writer sending a blanked section.
        storage
            .save_data(&serde_json::json!(
                {"sipConfig": {"server": "b", "password": ""}}
            ))
            .unwrap();
        let loaded = storage.load_data();
        assert_eq!(loaded["sipConfig"]["password"], "hunter2");
        assert_eq!(loaded["sipConfig"]["server"], "b");
    }

    #[test]
    fn test_missing_password_key_preserves_stored_password() {
        let (storage, _dir) = temp_storage();
        storage
            .save_data(&serde_json::json!(
                {"sip": {"server": "a", "password": "hunter2"}}
            ))
            .unwrap();
        storage
            .save_data(&serde_json::json!({"sip": {"port": 5061}}))
            .unwrap();
        let loaded = storage.load_data();
        assert_eq!(loaded["sip"]["password"], "hunter2");
        assert_eq!(loaded["sip"]["port"], 5061);
    }

    #[test]
    fn test_explicit_clear_flag_erases_password() {
        let (storage, _dir) = temp_storage();
        storage
            .save_data(&serde_json::json!(
                {"sipConfig": {"password": "hunter2"}}
            ))
            .unwrap();
        storage
            .save_data(&serde_json::json!(
                {"__clearSipPassword": true, "sipConfig": {"password": ""}}
            ))
            .unwrap();
        let loaded = storage.load_data();
        assert_eq!(loaded["sipConfig"]["password"], "");
    }

    #[test]
    fn test_nonempty_new_password_overwrites_stored() {
        let (storage, _dir) = temp_storage();
        storage
            .save_data(&serde_json::json!(
                {"sipConfig": {"password": "old"}}
            ))
            .unwrap();
        storage
            .save_data(&serde_json::json!(
                {"sipConfig": {"password": "new"}}
            ))
            .unwrap();
        let raw = fs::read_to_string(&storage.settings_path).unwrap();
        let on_disk: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let stored = on_disk["sipConfig"]["password"].as_str().unwrap();
        assert!(stored.starts_with("dpapi:"));
        assert_ne!(stored, "old");
        assert_eq!(storage.load_data()["sipConfig"]["password"], "new");
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
