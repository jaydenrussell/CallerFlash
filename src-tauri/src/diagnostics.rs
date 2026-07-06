use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const MAX_LINES: usize = 10000;
const MAX_SIZE: u64 = 10 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LogEntry {
    pub id: String,
    pub timestamp: String,
    pub level: String,
    pub category: String,
    pub message: String,
    pub details: Option<String>,
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
        if let Ok(line) = serde_json::to_string(entry) {
            if let Ok(mut contents) = fs::read_to_string(&self.path) {
                contents.push_str(&line);
                contents.push('\n');
                if contents.len() as u64 > MAX_SIZE {
                    let lines: Vec<&str> = contents.trim().split('\n').collect();
                    if lines.len() > MAX_LINES {
                        let keep = lines[lines.len().saturating_sub(MAX_LINES)..].join("\n");
                        let _ = fs::write(&self.path, keep + "\n");
                        return;
                    }
                }
                let _ = fs::write(&self.path, contents);
            } else {
                let _ = fs::write(&self.path, line + "\n");
            }
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
