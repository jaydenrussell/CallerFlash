use crate::error::{StartupCheck, StartupReport};
use std::path::PathBuf;

fn check_directory(path: &std::path::Path, name: &str, checks: &mut Vec<StartupCheck>) {
    match std::fs::create_dir_all(path) {
        Ok(_) => checks.push(StartupCheck {
            name: format!("{} directory", name),
            ok: true,
            message: Some(path.to_string_lossy().to_string()),
        }),
        Err(e) => checks.push(StartupCheck {
            name: format!("{} directory", name),
            ok: false,
            message: Some(format!("Cannot create {}: {}", path.display(), e)),
        }),
    }
}

fn check_config_integrity(data_dir: &std::path::Path) {
    let settings_path = data_dir.join("settings.json");
    if settings_path.exists() {
        match std::fs::read_to_string(&settings_path) {
            Ok(raw) => {
                if let Err(e) = serde_json::from_str::<serde_json::Value>(&raw) {
                    log::warn!("[startup] Corrupted settings.json ({}), will recreate", e);
                }
            }
            Err(e) => {
                log::warn!("[startup] Cannot read settings.json: {}", e);
            }
        }
    }
}

fn detect_windows_info() -> (String, String, String) {
    let os = std::env::consts::OS;
    if os != "windows" {
        return (
            "linux".to_string(),
            "0.0.0".to_string(),
            "Unknown".to_string(),
        );
    }

    let version = read_registry_string(
        r"SOFTWARE\Microsoft\Windows NT\CurrentVersion",
        "CurrentVersion",
    )
    .unwrap_or_else(|| "10.0".to_string());

    let build = read_registry_string(
        r"SOFTWARE\Microsoft\Windows NT\CurrentVersion",
        "CurrentBuild",
    )
    .unwrap_or_else(|| "0".to_string());

    let edition =
        read_registry_string(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "EditionID")
            .unwrap_or_else(|| "Unknown".to_string());

    let full_version = format!("{}.{}", version, build);
    (os.to_string(), full_version, edition)
}

fn read_registry_string(key_path: &str, value_name: &str) -> Option<String> {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_LOCAL_MACHINE;
        use winreg::RegKey;
        if let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(key_path) {
            if let Ok(val) = key.get_value::<String, _>(value_name) {
                return Some(val);
            }
        }
    }
    None
}

fn is_windows_11(build: &str, edition: &str) -> bool {
    if let Ok(build_num) = build.parse::<u32>() {
        if build_num >= 22000 {
            return true;
        }
    }
    edition.contains("11") || edition.contains("Server")
}

pub fn run_self_check(data_dir: PathBuf) -> StartupReport {
    let mut checks: Vec<StartupCheck> = Vec::new();
    let (os_name, os_version, edition) = detect_windows_info();

    let build = os_version.split('.').next_back().unwrap_or("0").to_string();
    let is_win11 = is_windows_11(&build, &edition);

    check_directory(&data_dir, "App data", &mut checks);
    check_config_integrity(&data_dir);

    let all_ok = checks.iter().all(|c| c.ok);

    if !all_ok {
        log::warn!("[startup] Some checks failed — continuing in degraded mode");
        for c in &checks {
            if !c.ok {
                log::warn!(
                    "[startup]   FAIL: {} — {}",
                    c.name,
                    c.message.as_deref().unwrap_or("no detail")
                );
            }
        }
    }

    log::info!(
        "[startup] OS: {} {} (Windows 11: {}, Edition: {})",
        os_name,
        os_version,
        is_win11,
        edition
    );

    if os_name == "windows" && !is_win11 {
        log::warn!(
            "[startup] Detected pre-Windows 11 build {} — some features may differ",
            build
        );
    }

    StartupReport {
        checks,
        all_ok,
        os_name,
        os_version,
        is_windows_11: is_win11,
        edition,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_detect_windows_info_returns_strings() {
        let (os, version, edition) = detect_windows_info();
        assert!(!os.is_empty());
        assert!(!version.is_empty());
        assert!(!edition.is_empty());
    }

    #[test]
    fn test_is_windows_11_build_threshold() {
        assert!(is_windows_11("22000", "Professional"));
        assert!(is_windows_11("22621", "Home"));
        assert!(is_windows_11("25900", "Pro"));
        assert!(!is_windows_11("19045", "Professional"));
        assert!(!is_windows_11("17763", "Enterprise"));
    }

    #[test]
    fn test_is_windows_11_edition_fallback() {
        assert!(is_windows_11("0", "Windows 11 Home"));
        assert!(!is_windows_11("0", "Windows 10 Pro"));
    }

    #[test]
    fn test_check_directory_creates_and_reports() {
        let dir = std::env::temp_dir().join("callerflash-test-startup-dir");
        let _ = fs::remove_dir_all(&dir);
        let mut checks = Vec::new();
        check_directory(&dir, "Test", &mut checks);
        assert!(checks[0].ok);
        assert!(dir.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_run_self_check_does_not_panic() {
        let dir = std::env::temp_dir().join("callerflash-self-check-test");
        let _ = fs::create_dir_all(&dir);
        let report = run_self_check(dir.clone());
        assert!(!report.os_name.is_empty());
        assert!(!report.os_version.is_empty());
        assert!(!report.edition.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_config_integrity_bad_json_does_not_panic() {
        let dir = std::env::temp_dir().join("callerflash-config-bad");
        let _ = fs::create_dir_all(&dir);
        fs::write(dir.join("settings.json"), "not valid json {{{").ok();
        check_config_integrity(&dir);
        let _ = fs::remove_dir_all(&dir);
    }
}
