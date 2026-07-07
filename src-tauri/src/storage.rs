use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use rand::RngCore;
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

use crate::error::CommandError;

const KEYRING_SERVICE: &str = "callerflash";
const KEYRING_USER: &str = "storage-key";

fn keyring_entry() -> Result<keyring::Entry, CommandError> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| CommandError::crypto(format!("Failed to create keyring entry: {}", e)))
}

fn get_or_create_key() -> Result<[u8; 32], CommandError> {
    let entry = keyring_entry()?;
    match entry.get_password() {
        Ok(b64) => {
            let mut key = [0u8; 32];
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(b64.as_bytes())
                .map_err(|e| CommandError::crypto(format!("Key base64 decode failed: {}", e)))?;
            if decoded.len() != 32 {
                return Err(CommandError::crypto("Stored key has invalid length"));
            }
            key.copy_from_slice(&decoded);
            Ok(key)
        }
        Err(keyring::Error::NoEntry) => {
            let mut key = [0u8; 32];
            OsRng.fill_bytes(&mut key);
            let b64 = base64::engine::general_purpose::STANDARD.encode(key);
            entry
                .set_password(&b64)
                .map_err(|e| CommandError::crypto(format!("Failed to store key: {}", e)))?;
            Ok(key)
        }
        Err(e) => {
            log::error!("[storage] Keyring access failed: {}", e);
            Err(CommandError::crypto(format!(
                "Keyring access failed: {}",
                e
            )))
        }
    }
}

fn encrypt_data(key: &[u8; 32], plaintext: &[u8]) -> Result<(String, String), CommandError> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| CommandError::crypto(format!("AES init: {}", e)))?;
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| CommandError::crypto(format!("Encryption failed: {}", e)))?;
    Ok((
        base64::engine::general_purpose::STANDARD.encode(ciphertext),
        base64::engine::general_purpose::STANDARD.encode(nonce_bytes),
    ))
}

fn decrypt_data(
    key: &[u8; 32],
    ciphertext_b64: &str,
    nonce_b64: &str,
) -> Result<Vec<u8>, CommandError> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| CommandError::crypto(format!("AES init: {}", e)))?;
    let ciphertext = base64::engine::general_purpose::STANDARD
        .decode(ciphertext_b64.as_bytes())
        .map_err(|e| CommandError::crypto(format!("Ciphertext decode failed: {}", e)))?;
    let nonce_bytes = base64::engine::general_purpose::STANDARD
        .decode(nonce_b64.as_bytes())
        .map_err(|e| CommandError::crypto(format!("Nonce decode failed: {}", e)))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|e| CommandError::crypto(format!("Decryption failed: {}", e)))
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
                        match get_or_create_key() {
                            Ok(key) => match decrypt_data(&key, ct, nonce) {
                                Ok(decrypted) => {
                                    if let Ok(data) =
                                        serde_json::from_slice::<serde_json::Value>(&decrypted)
                                    {
                                        return data;
                                    }
                                }
                                Err(e) => {
                                    log::error!("[storage] Failed to decrypt settings: {}", e);
                                }
                            },
                            Err(e) => {
                                log::error!("[storage] Failed to get encryption key: {}", e);
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

    fn save_data(&self, data: &serde_json::Value) -> Result<(), CommandError> {
        let key = get_or_create_key()?;
        let plaintext = serde_json::to_string(data)
            .map_err(|e| CommandError::config(format!("Serialize: {}", e)))?;
        let (ciphertext_b64, nonce_b64) = encrypt_data(&key, plaintext.as_bytes())?;

        let envelope = serde_json::json!({
            "_encrypted": true,
            "_version": 3,
            "_ciphertext": ciphertext_b64,
            "_nonce": nonce_b64,
            "_savedAt": chrono::Utc::now().to_rfc3339(),
        });
        let output = serde_json::to_string_pretty(&envelope)
            .map_err(|e| CommandError::config(format!("Serialize envelope: {}", e)))?;

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
        let fallback = dirs_fallback();
        log::warn!(
            "[storage] app_data_dir() failed, using fallback: {:?}",
            fallback
        );
        fallback
    })
}

fn dirs_fallback() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("data")
}

const MAX_STORAGE_SIZE: u64 = 5 * 1024 * 1024;

fn validate_storage_data(data: &serde_json::Value) -> Result<(), CommandError> {
    let serialized = serde_json::to_string(data)
        .map_err(|e| CommandError::invalid_input(format!("JSON: {}", e)))?;
    if serialized.len() as u64 > MAX_STORAGE_SIZE {
        return Err(CommandError::invalid_input(format!(
            "Storage data exceeds maximum size of {} bytes",
            MAX_STORAGE_SIZE
        )));
    }
    if !data.is_object() {
        return Err(CommandError::invalid_input(
            "Storage data must be a JSON object",
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn storage_load(app: AppHandle) -> serde_json::Value {
    let data_dir = default_data_dir(&app);
    let storage = SecureStorage::new(data_dir);
    storage.load_data()
}

#[tauri::command]
pub fn storage_save(app: AppHandle, data: serde_json::Value) -> Result<(), CommandError> {
    validate_storage_data(&data)?;
    let data_dir = default_data_dir(&app);
    let storage = SecureStorage::new(data_dir);
    storage.save_data(&data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_round_trip() {
        let key = [0x42u8; 32];
        let plaintext = b"hello world";
        let (ct, nonce) = encrypt_data(&key, plaintext).expect("encrypt");
        let decrypted = decrypt_data(&key, &ct, &nonce).expect("decrypt");
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_encrypt_decrypt_empty() {
        let key = [0xabu8; 32];
        let plaintext = b"";
        let (ct, nonce) = encrypt_data(&key, plaintext).expect("encrypt");
        let decrypted = decrypt_data(&key, &ct, &nonce).expect("decrypt");
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_decrypt_wrong_key_fails() {
        let key1 = [0x01u8; 32];
        let key2 = [0x02u8; 32];
        let plaintext = b"secret";
        let (ct, nonce) = encrypt_data(&key1, plaintext).expect("encrypt");
        let result = decrypt_data(&key2, &ct, &nonce);
        assert!(result.is_err());
    }

    #[test]
    fn test_decrypt_tampered_ciphertext_fails() {
        let key = [0x55u8; 32];
        let plaintext = b"data";
        let (mut ct, nonce) = encrypt_data(&key, plaintext).expect("encrypt");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(ct.as_bytes())
            .expect("decode");
        let mut tampered = bytes.clone();
        if !tampered.is_empty() {
            tampered[0] ^= 0xff;
        }
        ct = base64::engine::general_purpose::STANDARD.encode(tampered);
        let result = decrypt_data(&key, &ct, &nonce);
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_storage_data_rejects_non_object() {
        let result = validate_storage_data(&serde_json::json!("string"));
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_storage_data_accepts_valid_object() {
        let result = validate_storage_data(&serde_json::json!({"key": "value"}));
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_storage_data_rejects_oversized() {
        let large = serde_json::json!({"data": "x".repeat(6 * 1024 * 1024)});
        let result = validate_storage_data(&large);
        assert!(result.is_err());
    }
}
