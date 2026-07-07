use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Serialize;

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
