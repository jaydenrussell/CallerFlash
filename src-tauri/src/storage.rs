use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

type HmacSha256 = Hmac<Sha256>;

#[derive(Serialize, Deserialize)]
struct StorageEnvelope {
    _version: u32,
    _hmac: String,
    _data: serde_json::Value,
    _saved_at: String,
}

struct SecureStorage {
    settings_path: PathBuf,
    backup_path: PathBuf,
    tmp_path: PathBuf,
}

impl SecureStorage {
    fn new(data_dir: PathBuf) -> Self {
        Self {
            settings_path: data_dir.join("settings.json"),
            backup_path: data_dir.join("settings.json.bak"),
            tmp_path: data_dir.join("settings.json.tmp"),
        }
    }

    fn hmac_key(&self) -> Vec<u8> {
        use sha2::Digest;
        let mut hasher = sha2::Sha256::new();
        hasher.update(format!("callerflash-storage-v1:{}", self.settings_path.display()).as_bytes());
        hasher.finalize().to_vec()
    }

    fn compute_hmac(&self, data: &str) -> String {
        let mut mac = HmacSha256::new_from_slice(&self.hmac_key()).expect("HMAC key");
        mac.update(data.as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    fn verify_hmac(&self, data: &str, expected_hmac: &str) -> bool {
        use subtle::ConstantTimeEq;
        let actual = self.compute_hmac(data);
        actual.as_bytes().ct_eq(expected_hmac.as_bytes()).into()
    }

    fn load_data(&self) -> serde_json::Value {
        if let Ok(raw) = fs::read_to_string(&self.settings_path) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let (Some(hmac), Some(data)) = (
                    parsed.get("_hmac").and_then(|v| v.as_str()),
                    parsed.get("_data"),
                ) {
                    let data_str = serde_json::to_string(data).unwrap_or_default();
                    if self.verify_hmac(&data_str, hmac) {
                        return data.clone();
                    }
                    log::warn!("[storage] HMAC mismatch – attempting backup recovery");
                } else {
                    return parsed;
                }
            }
        }

        if let Ok(raw) = fs::read_to_string(&self.backup_path) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let (Some(hmac), Some(data)) = (
                    parsed.get("_hmac").and_then(|v| v.as_str()),
                    parsed.get("_data"),
                ) {
                    let data_str = serde_json::to_string(data).unwrap_or_default();
                    if self.verify_hmac(&data_str, hmac) {
                        log::info!("[storage] Recovered from backup file");
                        let _ = fs::copy(&self.backup_path, &self.settings_path);
                        return data.clone();
                    }
                } else {
                    return parsed;
                }
            }
        }

        serde_json::Value::Object(serde_json::Map::new())
    }

    fn save_data(&self, data: &serde_json::Value) -> Result<(), String> {
        let data_str = serde_json::to_string(data).map_err(|e| e.to_string())?;
        let hmac = self.compute_hmac(&data_str);

        let envelope = serde_json::json!({
            "_version": 2,
            "_hmac": hmac,
            "_data": data,
            "_savedAt": chrono::Utc::now().to_rfc3339(),
        });
        let output = serde_json::to_string_pretty(&envelope).map_err(|e| e.to_string())?;

        if self.settings_path.exists() {
            let _ = fs::copy(&self.settings_path, &self.backup_path);
        }

        fs::write(&self.tmp_path, &output).map_err(|e| e.to_string())?;
        fs::rename(&self.tmp_path, &self.settings_path).map_err(|e| e.to_string())?;

        Ok(())
    }
}

#[tauri::command]
pub fn storage_load(app: AppHandle) -> serde_json::Value {
    let data_dir = app.path().app_data_dir().unwrap_or_default();
    let storage = SecureStorage::new(data_dir);
    storage.load_data()
}

#[tauri::command]
pub fn storage_save(app: AppHandle, data: serde_json::Value) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().unwrap_or_default();
    let storage = SecureStorage::new(data_dir);
    storage.save_data(&data)
}
