use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use rand::RngCore;
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

const KEYRING_SERVICE: &str = "callerflash";
const KEYRING_USER: &str = "storage-key";

fn keyring_entry() -> keyring::Entry {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).expect("keyring entry")
}

fn get_or_create_key() -> Result<[u8; 32], String> {
    match keyring_entry().get_password() {
        Ok(b64) => {
            let mut key = [0u8; 32];
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(b64.as_bytes())
                .map_err(|e| format!("key decode: {}", e))?;
            if decoded.len() != 32 {
                return Err("invalid key length".into());
            }
            key.copy_from_slice(&decoded);
            Ok(key)
        }
        Err(keyring::Error::NoEntry) => {
            let mut key = [0u8; 32];
            OsRng.fill_bytes(&mut key);
            let b64 = base64::engine::general_purpose::STANDARD.encode(key);
            keyring_entry()
                .set_password(&b64)
                .map_err(|e| format!("key store: {}", e))?;
            Ok(key)
        }
        Err(e) => Err(format!("keyring: {}", e)),
    }
}

fn encrypt_data(key: &[u8; 32], plaintext: &[u8]) -> Result<(String, String), String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("cipher: {}", e))?;
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| format!("encrypt: {}", e))?;
    Ok((
        base64::engine::general_purpose::STANDARD.encode(ciphertext),
        base64::engine::general_purpose::STANDARD.encode(nonce_bytes),
    ))
}

fn decrypt_data(key: &[u8; 32], ciphertext_b64: &str, nonce_b64: &str) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("cipher: {}", e))?;
    let ciphertext = base64::engine::general_purpose::STANDARD
        .decode(ciphertext_b64.as_bytes())
        .map_err(|e| format!("ciphertext decode: {}", e))?;
    let nonce_bytes = base64::engine::general_purpose::STANDARD
        .decode(nonce_b64.as_bytes())
        .map_err(|e| format!("nonce decode: {}", e))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|e| format!("decrypt: {}", e))
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

    fn load_data(&self) -> serde_json::Value {
        if let Ok(raw) = fs::read_to_string(&self.settings_path) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
                let enc = parsed
                    .get("_encrypted")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if enc {
                    if let (Some(ct), Some(nonce)) = (
                        parsed.get("_ciphertext").and_then(|v| v.as_str()),
                        parsed.get("_nonce").and_then(|v| v.as_str()),
                    ) {
                        if let Ok(key) = get_or_create_key() {
                            if let Ok(decrypted) = decrypt_data(&key, ct, nonce) {
                                if let Ok(data) =
                                    serde_json::from_slice::<serde_json::Value>(&decrypted)
                                {
                                    return data;
                                }
                            }
                        }
                    }
                } else if let Some(data) = parsed.get("_data") {
                    return data.clone();
                } else {
                    return parsed;
                }
            }
        }

        if let Ok(raw) = fs::read_to_string(&self.backup_path) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
                let enc = parsed
                    .get("_encrypted")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if enc {
                    if let (Some(ct), Some(nonce)) = (
                        parsed.get("_ciphertext").and_then(|v| v.as_str()),
                        parsed.get("_nonce").and_then(|v| v.as_str()),
                    ) {
                        if let Ok(key) = get_or_create_key() {
                            if let Ok(decrypted) = decrypt_data(&key, ct, nonce) {
                                if let Ok(data) =
                                    serde_json::from_slice::<serde_json::Value>(&decrypted)
                                {
                                    let _ = fs::copy(&self.backup_path, &self.settings_path);
                                    return data;
                                }
                            }
                        }
                    }
                } else if let Some(data) = parsed.get("_data") {
                    return data.clone();
                }
            }
        }

        serde_json::Value::Object(serde_json::Map::new())
    }

    fn save_data(&self, data: &serde_json::Value) -> Result<(), String> {
        let key = get_or_create_key()?;
        let plaintext = serde_json::to_string(data).map_err(|e| format!("serialize: {}", e))?;
        let (ciphertext_b64, nonce_b64) = encrypt_data(&key, plaintext.as_bytes())?;

        let envelope = serde_json::json!({
            "_encrypted": true,
            "_version": 3,
            "_ciphertext": ciphertext_b64,
            "_nonce": nonce_b64,
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
