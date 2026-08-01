use std::ptr;

use windows_sys::Win32::Foundation::{GetLastError, LocalFree};
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

use crate::error::CommandError;

const DPAPI_PREFIX: &str = "dpapi:";

fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    }
}

pub fn dpapi_protect(data: &[u8]) -> Result<Vec<u8>, CommandError> {
    let input = blob(data);
    let mut output = CRYPT_INTEGER_BLOB::default();
    let ok = unsafe {
        CryptProtectData(
            &input,
            ptr::null(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        let code = unsafe { GetLastError() };
        return Err(CommandError::crypto(format!(
            "CryptProtectData failed (Win32 error {})",
            code
        )));
    }
    let protected =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(protected)
}

pub fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>, CommandError> {
    let input = blob(data);
    let mut output = CRYPT_INTEGER_BLOB::default();
    let mut descr: windows_sys::core::PWSTR = ptr::null_mut();
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            &mut descr,
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        let code = unsafe { GetLastError() };
        return Err(CommandError::crypto(format!(
            "CryptUnprotectData failed (Win32 error {})",
            code
        )));
    }
    let plain =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe {
        LocalFree(output.pbData.cast());
        if !descr.is_null() {
            LocalFree(descr.cast());
        }
    }
    Ok(plain)
}

/// Encrypt a plaintext string using DPAPI (current user scope) and return it
/// as a `dpapi:<base64>` value suitable for storage.
pub fn encrypt_string(plaintext: &str) -> Result<String, CommandError> {
    use base64::Engine;
    let protected = dpapi_protect(plaintext.as_bytes())?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(protected);
    Ok(format!("{}{}", DPAPI_PREFIX, encoded))
}

/// Decrypt a `dpapi:<base64>` value produced by [`encrypt_string`].
pub fn decrypt_string(value: &str) -> Result<String, CommandError> {
    use base64::Engine;
    let payload = value
        .strip_prefix(DPAPI_PREFIX)
        .ok_or_else(|| CommandError::crypto("Value does not use the dpapi: format"))?;
    let data = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| CommandError::crypto(format!("Base64 decode: {}", e)))?;
    let plain = dpapi_unprotect(&data)?;
    String::from_utf8(plain).map_err(|_| CommandError::crypto("Decrypted data is not valid UTF-8"))
}

/// Returns true when the value uses one of the known encrypted-at-rest formats.
pub fn is_encrypted(value: &str) -> bool {
    value.starts_with(DPAPI_PREFIX)
        || value.starts_with("ss:")
        || value.starts_with("enc:")
        || value.starts_with("fb:")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let plain = "correct horse battery staple";
        let encrypted = encrypt_string(plain).unwrap();
        assert!(encrypted.starts_with(DPAPI_PREFIX));
        assert_ne!(encrypted, format!("{}{}", DPAPI_PREFIX, plain));
        let decrypted = decrypt_string(&encrypted).unwrap();
        assert_eq!(decrypted, plain);
    }

    #[test]
    fn test_dpapi_is_nondeterministic() {
        let plain = "password123";
        let a = encrypt_string(plain).unwrap();
        let b = encrypt_string(plain).unwrap();
        assert_ne!(a, b);
        assert_eq!(decrypt_string(&a).unwrap(), decrypt_string(&b).unwrap());
    }

    #[test]
    fn test_decrypt_rejects_unknown_format() {
        let result = decrypt_string("plaintext-without-prefix");
        assert!(result.is_err());
    }

    #[test]
    fn test_decrypt_rejects_garbage_base64() {
        let result = decrypt_string(&format!("{}!!not-base64!!", DPAPI_PREFIX));
        assert!(result.is_err());
    }

    #[test]
    fn test_is_encrypted_detects_known_formats() {
        assert!(is_encrypted(&format!("{}abc", DPAPI_PREFIX)));
        assert!(is_encrypted("ss:abc"));
        assert!(is_encrypted("enc:abc"));
        assert!(is_encrypted("fb:abc"));
        assert!(!is_encrypted("plaintext"));
        assert!(!is_encrypted(""));
    }
}
