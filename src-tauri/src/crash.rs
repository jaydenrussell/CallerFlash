use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::SystemTime;

/// Initialise the global panic hook so every panic writes a crash dump
/// to `%APPDATA%/CallerFlash/crashes/` before the process tears down.
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

        let report = format!(
            "CallerFlash Crash Report\n\
             Timestamp: {ts}\n\
             Panic: {info}\n\
             Version: {version}\n\
             OS: {os} {arch}\n\
             Args: {args}\n\
             Location: {loc}\n",
            ts = ts,
            info = info,
            version = env!("CARGO_PKG_VERSION"),
            os = std::env::consts::OS,
            arch = std::env::consts::ARCH,
            args = std::env::args().collect::<Vec<_>>().join(" "),
            loc = loc,
        );

        // Write to %APPDATA%/CallerFlash/crashes/
        let app_dir = std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("CallerFlash")
            .join("crashes");
        let _ = fs::create_dir_all(&app_dir);
        if let Ok(mut f) = fs::File::create(app_dir.join(format!("crash-{}.log", ts))) {
            let _ = f.write_all(report.as_bytes());
        }

        // Also write to %TEMP% for discoverability
        let temp_crash = std::env::temp_dir().join(format!("CallerFlash-crash-{}.log", ts));
        if let Ok(mut f) = fs::File::create(&temp_crash) {
            let _ = f.write_all(report.as_bytes());
        }

        prev(info);
    }));
}
