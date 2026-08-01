#![cfg(feature = "migration")]

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::CommandError;
use crate::secure;

const SALT_LENGTH: usize = 32;
const IV_LENGTH: usize = 16;
const TAG_LENGTH: usize = 16;

// Electron safeStorage (Chromium OSCrypt v10) layout used by Sip-Toast:
//   "v10" || nonce[12] || AES-256-GCM ciphertext with tag
const OSCRYPT_V10_PREFIX: &[u8] = b"v10";
const OSCRYPT_NONCE_LENGTH: usize = 12;
const OSCRYPT_KEY_LENGTH: usize = 32;
const OSCRYPT_KEY_PREFIX: &[u8] = b"DPAPI";

const MIGRATION_MARKER: &str = ".migrated_from_sip_toast";

const PREVIOUS_APP_NAMES: &[&str] = &[
    "SIP Caller ID",
    "SIPToast",
    "sip-toast",
    "SIP-Toast",
    "Sip-Toast",
    "sip-callerid",
    "sip-caller-id",
];

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".to_string())
}

fn get_cpu_model() -> String {
    if let Ok(val) = std::env::var("PROCESSOR_IDENTIFIER") {
        return val;
    }
    if let Ok(content) = fs::read_to_string("/proc/cpuinfo") {
        for line in content.lines() {
            if let Some(idx) = line.find(':') {
                let key = line[..idx].trim();
                if key == "model name" || key == "Model Name" {
                    return line[idx + 1..].trim().to_string();
                }
            }
        }
    }
    "unknown".to_string()
}

fn derive_machine_key() -> Result<[u8; 32], CommandError> {
    let hostname = hostname();
    let platform = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let cpu_model = get_cpu_model();

    let machine_id = format!(
        "{}:{}:{}:{}:sip-caller-id-encryption-key-v1",
        hostname, platform, arch, cpu_model
    );

    let mut hasher = Sha256::new();
    hasher.update(machine_id.as_bytes());
    let result = hasher.finalize();

    let mut key = [0u8; 32];
    key.copy_from_slice(&result);
    Ok(key)
}

fn decrypt_enc_format(encrypted: &str) -> Result<String, CommandError> {
    let data = encrypted.strip_prefix("enc:").unwrap_or(encrypted);
    let combined = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| CommandError::crypto(format!("Base64 decode: {}", e)))?;

    if combined.len() < SALT_LENGTH + IV_LENGTH + TAG_LENGTH {
        return Err(CommandError::crypto("Encrypted data too short"));
    }

    let mut offset = 0;
    let salt = &combined[offset..offset + SALT_LENGTH];
    offset += SALT_LENGTH;
    let iv = &combined[offset..offset + IV_LENGTH];
    offset += IV_LENGTH;
    let tag = &combined[offset..offset + TAG_LENGTH];
    offset += TAG_LENGTH;
    let ciphertext = &combined[offset..];

    let machine_key = derive_machine_key()?;

    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&machine_key)
        .map_err(|e| CommandError::crypto(format!("HMAC init: {}", e)))?;
    mac.update(salt);
    let derived_key = mac.finalize().into_bytes();

    let cipher = Aes256Gcm::new_from_slice(&derived_key)
        .map_err(|e| CommandError::crypto(format!("AES init: {}", e)))?;
    let nonce = Nonce::from_slice(iv);

    let mut encrypted_with_tag = ciphertext.to_vec();
    encrypted_with_tag.extend_from_slice(tag);

    let plaintext = cipher
        .decrypt(nonce, encrypted_with_tag.as_ref())
        .map_err(|e| CommandError::crypto(format!("AES-GCM decrypt: {}", e)))?;

    String::from_utf8(plaintext)
        .map_err(|_| CommandError::crypto("Decrypted data is not valid UTF-8"))
}

fn decrypt_fb_format(data: &str) -> Result<String, CommandError> {
    let combined = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| CommandError::crypto(format!("Base64 decode: {}", e)))?;

    if combined.len() < IV_LENGTH + TAG_LENGTH {
        return Err(CommandError::crypto("Encrypted data too short"));
    }

    let iv = &combined[..IV_LENGTH];
    let tag = &combined[IV_LENGTH..IV_LENGTH + TAG_LENGTH];
    let ciphertext = &combined[IV_LENGTH + TAG_LENGTH..];

    let machine_key = derive_machine_key()?;
    let cipher = Aes256Gcm::new_from_slice(&machine_key)
        .map_err(|e| CommandError::crypto(format!("AES init: {}", e)))?;
    let nonce = Nonce::from_slice(iv);

    let mut encrypted_with_tag = ciphertext.to_vec();
    encrypted_with_tag.extend_from_slice(tag);

    let plaintext = cipher
        .decrypt(nonce, encrypted_with_tag.as_ref())
        .map_err(|e| CommandError::crypto(format!("AES-GCM decrypt: {}", e)))?;

    String::from_utf8(plaintext)
        .map_err(|_| CommandError::crypto("Decrypted data is not valid UTF-8"))
}

/// Reads the AES-256-GCM master key that Electron's safeStorage (Chromium
/// OSCrypt) wrapped with DPAPI and stored in `<userData>\Local State` under
/// `os_crypt.encrypted_key`.
fn load_oscrypt_master_key(
    old_config_path: &Path,
) -> Result<[u8; OSCRYPT_KEY_LENGTH], CommandError> {
    let local_state_path = old_config_path
        .parent()
        .ok_or_else(|| CommandError::crypto("Cannot determine config directory"))?
        .join("Local State");

    let raw = fs::read_to_string(&local_state_path).map_err(|e| {
        CommandError::crypto(format!(
            "Cannot read Local State ({}): {}",
            local_state_path.display(),
            e
        ))
    })?;

    let json: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| CommandError::crypto(format!("Cannot parse Local State: {}", e)))?;

    let encrypted_key = json
        .get("os_crypt")
        .and_then(|o| o.get("encrypted_key"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| CommandError::crypto("Local State has no os_crypt.encrypted_key"))?;

    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encrypted_key)
        .map_err(|e| CommandError::crypto(format!("Base64 decode: {}", e)))?;

    let blob = decoded
        .strip_prefix(OSCRYPT_KEY_PREFIX)
        .ok_or_else(|| CommandError::crypto("Encrypted key missing DPAPI prefix"))?;

    let key = secure::dpapi_unprotect(blob)?;
    let key: [u8; OSCRYPT_KEY_LENGTH] = key
        .try_into()
        .map_err(|_| CommandError::crypto("Unexpected key length from Local State"))?;
    Ok(key)
}

fn decrypt_ss_format(
    encrypted: &str,
    key: &[u8; OSCRYPT_KEY_LENGTH],
) -> Result<String, CommandError> {
    let data = encrypted.strip_prefix("ss:").unwrap_or(encrypted);
    let combined = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| CommandError::crypto(format!("Base64 decode: {}", e)))?;

    if !combined.starts_with(OSCRYPT_V10_PREFIX) {
        return Err(CommandError::crypto(
            "Unsupported safeStorage version (expected v10)",
        ));
    }

    let body = &combined[OSCRYPT_V10_PREFIX.len()..];
    if body.len() <= OSCRYPT_NONCE_LENGTH {
        return Err(CommandError::crypto("safeStorage data too short"));
    }

    let nonce = &body[..OSCRYPT_NONCE_LENGTH];
    let encrypted_with_tag = &body[OSCRYPT_NONCE_LENGTH..];

    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| CommandError::crypto(format!("AES init: {}", e)))?;
    let nonce = Nonce::from_slice(nonce);

    let plaintext = cipher
        .decrypt(nonce, encrypted_with_tag.as_ref())
        .map_err(|e| CommandError::crypto(format!("AES-GCM decrypt: {}", e)))?;

    String::from_utf8(plaintext)
        .map_err(|_| CommandError::crypto("Decrypted data is not valid UTF-8"))
}

fn decrypt_password_once(encrypted: &str, old_config_path: &Path) -> Result<String, CommandError> {
    if !encrypted.starts_with("enc:")
        && !encrypted.starts_with("fb:")
        && !encrypted.starts_with("ss:")
    {
        let is_base64 = encrypted.len() >= 50
            && encrypted
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '/' || c == '+' || c == '=');
        if !is_base64 {
            return Ok(encrypted.to_string());
        }
        return decrypt_fb_format(encrypted);
    }

    if encrypted.starts_with("enc:") {
        return decrypt_enc_format(encrypted);
    }

    if encrypted.starts_with("fb:") {
        let data = encrypted.strip_prefix("fb:").unwrap();
        return decrypt_fb_format(data);
    }

    if encrypted.starts_with("ss:") {
        let key = load_oscrypt_master_key(old_config_path)?;
        return decrypt_ss_format(encrypted, &key);
    }

    Err(CommandError::crypto("Unknown encryption format"))
}

/// Decrypt a Sip-Toast password. Handles `enc:`, `fb:`, and `ss:` formats.
///
/// Older Sip-Toast versions re-wrapped undecryptable `ss:` literals inside an
/// `enc:` envelope, so decryption is repeated (bounded) until the value stops
/// changing.
fn decrypt_password(encrypted: &str, old_config_path: &Path) -> Result<String, CommandError> {
    let mut current = encrypted.to_string();
    for _ in 0..3 {
        let next = decrypt_password_once(&current, old_config_path)?;
        if next == current {
            return Ok(next);
        }
        current = next;
    }
    Ok(current)
}

fn find_old_config(app_data_dir: &Path) -> Option<PathBuf> {
    let parent = app_data_dir.parent()?;

    for name in PREVIOUS_APP_NAMES {
        let paths = vec![
            parent.join(name).join(format!("{}.json", name)),
            parent.join(name).join("SIP Caller ID.json"),
            parent.join(name).join("config.json"),
            parent
                .join(name.to_lowercase())
                .join(format!("{}.json", name.to_lowercase())),
            parent
                .join(name.replace(' ', "-"))
                .join(format!("{}.json", name.replace(' ', "-"))),
            parent.join("sip-caller-id").join("SIP Caller ID.json"),
        ];
        for p in paths {
            if p.exists() {
                log::info!("[migrate] Found Sip-Toast config at: {:?}", p);
                return Some(p);
            }
        }
    }
    None
}

fn was_migration_attempted(app_data_dir: &Path) -> bool {
    app_data_dir.join(MIGRATION_MARKER).exists()
}

fn mark_migration_done(app_data_dir: &Path) {
    if let Err(e) = fs::write(app_data_dir.join(MIGRATION_MARKER), "") {
        log::error!("[migrate] Failed to write migration marker: {}", e);
    }
}

pub fn run_migration(app_data_dir: &Path) {
    if was_migration_attempted(app_data_dir) {
        log::info!("[migrate] Migration already attempted, skipping");
        return;
    }

    let old_config_path = match find_old_config(app_data_dir) {
        Some(p) => p,
        None => {
            log::info!("[migrate] No Sip-Toast config found, skipping migration");
            mark_migration_done(app_data_dir);
            return;
        }
    };

    let old_config_raw = match fs::read_to_string(&old_config_path) {
        Ok(c) => c,
        Err(e) => {
            log::error!("[migrate] Failed to read old config: {}", e);
            mark_migration_done(app_data_dir);
            return;
        }
    };

    let old_config: HashMap<String, serde_json::Value> = match serde_json::from_str(&old_config_raw)
    {
        Ok(c) => c,
        Err(e) => {
            log::error!("[migrate] Failed to parse old config JSON: {}", e);
            mark_migration_done(app_data_dir);
            return;
        }
    };

    let sip = match old_config.get("sip") {
        Some(v) => v,
        None => {
            log::info!("[migrate] No SIP config in old settings");
            mark_migration_done(app_data_dir);
            return;
        }
    };

    let server = sip.get("server").and_then(|v| v.as_str()).unwrap_or("");
    let username = sip.get("username").and_then(|v| v.as_str()).unwrap_or("");
    let password_enc = sip.get("password").and_then(|v| v.as_str()).unwrap_or("");

    if server.is_empty() || username.is_empty() {
        log::info!("[migrate] Incomplete SIP config in old settings, skipping");
        mark_migration_done(app_data_dir);
        return;
    }

    let decrypted_password = if password_enc.is_empty() {
        String::new()
    } else {
        match decrypt_password(password_enc, &old_config_path) {
            Ok(p) => p,
            Err(e) => {
                log::warn!(
                    "[migrate] Could not decrypt SIP password ({}); importing the rest - user will need to re-enter the password",
                    e
                );
                String::new()
            }
        }
    };

    let port = sip.get("port").and_then(|v| v.as_u64()).map(|v| v as u16);

    let protocol = sip
        .get("transport")
        .and_then(|v| v.as_str())
        .map(|v| v.to_lowercase());

    let auth_username = sip.get("domain").and_then(|v| v.as_str()).and_then(|v| {
        if v.is_empty() {
            None
        } else {
            Some(v.to_string())
        }
    });

    let sip_config = serde_json::json!({
        "username": username,
        "password": decrypted_password,
        "server": server,
        "port": port,
        "protocol": protocol,
        "auth_username": auth_username,
    });

    let storage = crate::storage::SecureStorage::new(app_data_dir.to_path_buf());
    let existing = storage.load_data();
    let mut merged = existing.as_object().cloned().unwrap_or_default();
    merged.insert("sip".to_string(), sip_config);
    merged.insert("_migrated_from".to_string(), serde_json::json!("sip-toast"));

    let merged_value = serde_json::Value::Object(merged);
    if let Err(e) = storage.save_data(&merged_value) {
        log::error!("[migrate] Failed to save migrated settings: {}", e);
        mark_migration_done(app_data_dir);
        return;
    }

    log::info!(
        "[migrate] Successfully imported SIP settings from Sip-Toast (server={}, user={})",
        server,
        username
    );

    mark_migration_done(app_data_dir);
}
