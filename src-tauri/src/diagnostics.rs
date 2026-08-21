use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

use crate::error::CommandError;
use crate::ratelimit::RATE_LIMITER;

const MAX_LINES: usize = 10000;
const MAX_SIZE: u64 = 10 * 1024 * 1024;
const MAX_MESSAGE_LENGTH: usize = 4096;
const MAX_CATEGORY_LENGTH: usize = 64;
const MAX_FIELD_LENGTH: usize = 2048;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LogEntry {
    pub id: String,
    pub timestamp: String,
    pub level: String,
    pub category: String,
    pub message: String,
    pub details: Option<String>,
}

impl LogEntry {
    pub fn validate(&self) -> Result<(), CommandError> {
        if self.id.len() > 128 {
            return Err(CommandError::invalid_input("Log entry id too long"));
        }
        if self.timestamp.len() > 64 {
            return Err(CommandError::invalid_input("Log entry timestamp too long"));
        }
        if self.level.len() > 16 {
            return Err(CommandError::invalid_input("Log entry level too long"));
        }
        if self.category.len() > MAX_CATEGORY_LENGTH {
            return Err(CommandError::invalid_input("Log entry category too long"));
        }
        if self.message.len() > MAX_MESSAGE_LENGTH {
            return Err(CommandError::invalid_input("Log entry message too long"));
        }
        if let Some(ref details) = self.details {
            if details.len() > MAX_FIELD_LENGTH {
                return Err(CommandError::invalid_input("Log entry details too long"));
            }
        }
        Ok(())
    }
}

pub struct Diagnostics {
    path: PathBuf,
}

impl Diagnostics {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            path: data_dir.join("diagnostics.log"),
        }
    }

    pub fn append(&self, entry: &LogEntry) {
        let Ok(line) = serde_json::to_string(entry) else {
            return;
        };
        if let Ok(meta) = fs::metadata(&self.path) {
            if meta.len() + line.len() as u64 + 1 > MAX_SIZE {
                if let Ok(contents) = fs::read_to_string(&self.path) {
                    let lines: Vec<&str> = contents.split('\n').filter(|l| !l.is_empty()).collect();
                    let start = lines.len().saturating_sub(MAX_LINES);
                    let _ = fs::write(&self.path, lines[start..].join("\n") + "\n");
                }
            }
        }
        use std::io::Write;
        if let Ok(mut f) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
        {
            let _ = writeln!(f, "{}", line);
        }
    }

    /// Best-effort sanitization of the on-disk log: overwrite with zeros
    /// (so the plaintext entries don't linger in unallocated sectors), then
    /// delete the file.
    pub fn clear(&self) {
        let zeros = vec![
            0u8;
            fs::metadata(&self.path)
                .map(|m| m.len() as usize)
                .unwrap_or(0)
        ];
        if let Err(e) = fs::write(&self.path, &zeros) {
            log::warn!("[diagnostics] Could not overwrite log: {}", e);
        }
        if let Err(e) = fs::remove_file(&self.path) {
            log::warn!("[diagnostics] Could not delete log: {}", e);
        } else {
            log::info!("[diagnostics] Cleared on-disk log at {:?}", self.path);
        }
    }

    pub fn load(&self, limit: usize) -> Vec<LogEntry> {
        let limit = limit.min(1000);
        let content = match fs::read_to_string(&self.path) {
            Ok(c) => c,
            Err(_) => return Vec::new(),
        };
        let lines: Vec<&str> = content
            .trim()
            .split('\n')
            .filter(|l| !l.is_empty())
            .collect();
        let start = lines.len().saturating_sub(limit);
        let mut entries: Vec<LogEntry> = Vec::new();
        for line in lines[start..].iter() {
            if let Ok(e) = serde_json::from_str(line) {
                entries.push(e);
            }
        }
        entries.reverse();
        entries
    }
}

#[tauri::command]
pub fn diagnostics_append(
    app: tauri::AppHandle,
    entry: serde_json::Value,
) -> Result<(), CommandError> {
    if !RATE_LIMITER.check("diagnostics_append") {
        return Err(CommandError::rate_limited());
    }
    let log_entry: LogEntry = serde_json::from_value(entry)
        .map_err(|e| CommandError::invalid_input(format!("Invalid log entry: {}", e)))?;
    log_entry.validate()?;
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let diag = Diagnostics::new(data_dir);
    diag.append(&log_entry);
    Ok(())
}

#[tauri::command]
pub fn diagnostics_export(text: String) -> Result<String, CommandError> {
    if !RATE_LIMITER.check("diagnostics_export") {
        return Err(CommandError::rate_limited());
    }
    if text.len() > MAX_SIZE as usize {
        return Err(CommandError::invalid_input(
            "Export text exceeds maximum size of 10MB",
        ));
    }
    let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S");
    let uniq = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_micros())
        .unwrap_or(0);
    let filename = format!("callerflash-diagnostics-{}-{:06}.log", timestamp, uniq);
    let path = std::env::temp_dir().join(&filename);
    fs::write(&path, &text).map_err(|e| CommandError::io(format!("Write failed: {}", e)))?;
    let display = path.to_string_lossy().to_string();
    log::info!("[diagnostics] Exported log to {:?}", path);
    let _ = open::that(path);
    Ok(display)
}

#[tauri::command]
pub fn diagnostics_load(app: tauri::AppHandle) -> Vec<LogEntry> {
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let diag = Diagnostics::new(data_dir);
    diag.load(1000)
}

#[tauri::command]
pub fn diagnostics_clear(app: tauri::AppHandle) -> Result<(), CommandError> {
    if !RATE_LIMITER.check("diagnostics_clear") {
        return Err(CommandError::rate_limited());
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    Diagnostics::new(data_dir).clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{Diagnostics, LogEntry};
    use std::fs;

    fn entry(id: &str) -> LogEntry {
        LogEntry {
            id: id.to_string(),
            timestamp: "2026-08-21T00:00:00Z".to_string(),
            level: "info".to_string(),
            category: "TEST".to_string(),
            message: "hello".to_string(),
            details: None,
        }
    }

    #[test]
    fn clear_removes_log_file_and_entries() {
        let dir = tempfile::tempdir().expect("tempdir");
        let diag = Diagnostics::new(dir.path().to_path_buf());
        diag.append(&entry("1"));
        assert!(diag.load(100).len() == 1);
        assert!(diag.path.exists());

        diag.clear();

        assert!(!diag.path.exists(), "log file should be deleted");
        assert!(diag.load(100).is_empty());
    }

    #[test]
    fn clear_on_missing_file_is_noop() {
        let dir = tempfile::tempdir().expect("tempdir");
        let diag = Diagnostics::new(dir.path().to_path_buf());
        diag.clear();
        assert!(!diag.path.exists());
    }

    #[test]
    fn append_then_load_returns_newest_first() {
        let dir = tempfile::tempdir().expect("tempdir");
        let diag = Diagnostics::new(dir.path().to_path_buf());
        fs::remove_file(&diag.path).ok();
        diag.append(&entry("first"));
        diag.append(&entry("second"));
        let loaded = diag.load(100);
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].id, "second", "newest entry first");
        assert_eq!(loaded[1].id, "first");
    }
}
