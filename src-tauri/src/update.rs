use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Serialize;
use tauri::{Manager, Runtime};
use tauri_plugin_updater::UpdaterExt;

/// Stable channel endpoint. `releases/latest` resolves to the newest
/// non-prerelease release, so this always serves the latest stable.
const STABLE_UPDATE_ENDPOINT: &str =
    "https://github.com/jaydenrussell/CallerFlash/releases/latest/download/update.json";

/// Metadata handed to the renderer. Mirrors the shape the
/// `tauri-plugin-updater` JS `Update` class expects, so the frontend can
/// construct a real `Update` and drive download/install through the plugin.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    pub rid: u32,
    pub current_version: String,
    pub version: String,
    pub date: Option<String>,
    pub body: Option<String>,
    pub raw_json: serde_json::Value,
}

#[derive(Serialize)]
pub struct VerifyResult {
    pub valid: bool,
}

const VERIFY_PUBLIC_KEY_B64: &str = "RXv0FZ3tFJwx3XH8qGJWzOJ3zKzXG6y5Y0k8L9aBc1E=";

fn get_verifying_key() -> Result<VerifyingKey, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(VERIFY_PUBLIC_KEY_B64)
        .map_err(|e| format!("Base64 decode failed: {}", e))?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "Invalid public key length".to_string())?;
    VerifyingKey::from_bytes(&arr).map_err(|e| format!("Invalid Ed25519 key: {}", e))
}

#[tauri::command]
pub fn cmd_verify_update(signature_b64: String, data_hex: String) -> Result<VerifyResult, String> {
    let key = get_verifying_key()?;

    use base64::Engine;
    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(&signature_b64)
        .map_err(|e| format!("Signature base64 decode failed: {}", e))?;
    let signature =
        Signature::from_slice(&sig_bytes).map_err(|e| format!("Invalid signature bytes: {}", e))?;

    let data = hex::decode(&data_hex).map_err(|e| format!("Hex decode failed: {}", e))?;

    let valid = key.verify(&data, &signature).is_ok();
    Ok(VerifyResult { valid })
}

/// Restrict the check endpoint to the hard-coded GitHub release hosts. The
/// updater verifies the downloaded bytes against the pinned minisign public
/// key regardless, but this keeps the check URL itself on trusted hosts even
/// if the renderer is compromised.
fn validate_update_endpoint(endpoint: &str) -> Result<String, String> {
    let url = url::Url::parse(endpoint).map_err(|e| format!("Invalid update endpoint: {e}"))?;
    if url.scheme() != "https" {
        return Err("Update endpoint must use HTTPS".into());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Update endpoint has no host".to_string())?;
    if !matches!(host, "github.com" | "api.github.com" | "objects.githubusercontent.com") {
        return Err(format!("Update endpoint host not allowed: {host}"));
    }
    Ok(endpoint.to_string())
}

/// Channel-aware update check.
///
/// The renderer resolves the per-channel endpoint (stable → `releases/latest`,
/// beta → the latest beta tag's release) and passes it here; the endpoint is
/// validated against the host allow-list, then `tauri-plugin-updater` is used
/// for the actual check and signature-verified download/install later.
#[tauri::command]
pub async fn cmd_check_update<R: Runtime>(
    webview: tauri::Webview<R>,
    endpoint: Option<String>,
) -> Result<Option<UpdateMetadata>, String> {
    let endpoint = match endpoint {
        Some(url) => validate_update_endpoint(&url)?,
        None => STABLE_UPDATE_ENDPOINT.to_string(),
    };

    let updater = webview
        .updater_builder()
        .endpoints(vec![
            url::Url::parse(&endpoint).map_err(|e| format!("Invalid update endpoint URL: {e}"))?,
        ])
        .map_err(|e| format!("Failed to configure updater: {e}"))?
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to build updater: {e}"))?;

    let update = updater
        .check()
        .await
        .map_err(|e| format!("Update check failed: {e}"))?;

    if let Some(update) = update {
        let metadata = UpdateMetadata {
            current_version: update.current_version.clone(),
            version: update.version.clone(),
            date: update.date.map(|d| d.to_string()),
            body: update.body.clone(),
            raw_json: update.raw_json.clone(),
            rid: webview.resources_table().add(update),
        };
        Ok(Some(metadata))
    } else {
        Ok(None)
    }
}
