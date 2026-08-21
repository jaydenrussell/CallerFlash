use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::SystemTime;

/// Collapse a panic payload into something safe to persist: printable
/// characters only (no control bytes / terminal escapes), bounded length.
/// Panic messages are formatted from arbitrary state, so never write them raw.
fn sanitize_panic_message(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|&c| c.is_ascii_graphic() || c == ' ')
        .take(512)
        .collect();
    cleaned.trim().to_string()
}

/// Initialise the global panic hook so every panic writes a sanitized crash
/// dump to `%APPDATA%/CallerFlash/crashes/` before the process tears down.
pub fn init_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let ts = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let loc = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "unknown".to_string());

        // Payload only — no process args or environment, which can carry secrets.
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "non-string panic payload".to_string());

        let report = format!(
            "CallerFlash Crash Report\n\
             Timestamp: {ts}\n\
             Panic: {panic}\n\
             Version: {version}\n\
             OS: {os} {arch}\n\
             Location: {loc}\n",
            ts = ts,
            panic = sanitize_panic_message(&payload),
            version = env!("CARGO_PKG_VERSION"),
            os = std::env::consts::OS,
            arch = std::env::consts::ARCH,
            loc = loc,
        );

        // Write to %APPDATA%/CallerFlash/crashes/ only. No %TEMP% copy:
        // world-readable temp locations widen the exposure for no benefit.
        let app_dir = std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("CallerFlash")
            .join("crashes");
        let _ = fs::create_dir_all(&app_dir);
        if let Ok(mut f) = fs::File::create(app_dir.join(format!("crash-{}.log", ts))) {
            let _ = f.write_all(report.as_bytes());
        }

        prev(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::sanitize_panic_message;

    #[test]
    fn strips_control_chars_and_bounds_length() {
        let dirty = format!("bad \u{1b}[31mthing\u{7} {}", "x".repeat(2000));
        let clean = sanitize_panic_message(&dirty);
        assert!(!clean.contains('\u{1b}'));
        assert!(!clean.contains('\u{7}'));
        assert!(clean.chars().count() <= 512);
        assert!(clean.starts_with("bad [31mthing"));
    }

    #[test]
    fn trims_whitespace() {
        assert_eq!(sanitize_panic_message("  hello  "), "hello");
    }
}
