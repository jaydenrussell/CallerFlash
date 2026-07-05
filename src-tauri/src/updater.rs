use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::io::Write;
use tauri::{AppHandle, Emitter, Manager};
use futures_util::StreamExt;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UpdateInfo {
    pub version: String,
    pub download_url: String,
    pub published_at: String,
    pub friendly_name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UpdateStatus {
    pub status: String,
    pub version: Option<String>,
    pub message: Option<String>,
    pub progress: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    prerelease: bool,
    draft: bool,
    published_at: String,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

pub struct Updater {
    client: Client,
    pub temp_dir: PathBuf,
    current_version: String,
}

impl Updater {
    pub fn new(app: &AppHandle) -> Self {
        let temp_dir = app.path().app_data_dir().unwrap_or_default().join("updates");
        let _ = fs::create_dir_all(&temp_dir);
        Self {
            client: Client::builder()
                .user_agent("CallerFlash")
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_default(),
            temp_dir,
            current_version: "1.4.2".to_string(),
        }
    }

    pub fn normalise_version(v: &str) -> String {
        v.trim_start_matches('v').to_string()
    }

    fn parse_version(v: &str) -> Option<(u32, u32, u32, String, u32)> {
        let v = v.trim_start_matches('v');
        let parts: Vec<&str> = v.splitn(2, |c| c == '-' || c == '+').collect();
        let base = parts[0];
        let pre = if parts.len() > 1 { parts[1] } else { "" };

        let nums: Vec<&str> = base.split('.').collect();
        if nums.len() != 3 { return None; }
        let major: u32 = nums[0].parse().ok()?;
        let minor: u32 = nums[1].parse().ok()?;
        let patch: u32 = nums[2].parse().ok()?;

        let pre_type = if pre.is_empty() {
            String::new()
        } else if pre.contains("alpha") {
            "alpha".to_string()
        } else if pre.contains("beta") {
            "beta".to_string()
        } else {
            pre.to_string()
        };

        let pre_num = pre.rsplit(|c: char| !c.is_ascii_digit())
            .next()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);

        Some((major, minor, patch, pre_type, pre_num))
    }

    fn is_update_available(current: &str, remote: &str) -> bool {
        let current = Self::normalise_version(current);
        let remote = Self::normalise_version(remote);
        if current == remote { return false; }

        let r = Self::parse_version(&remote);
        let l = Self::parse_version(&current);

        match (r, l) {
            (Some((rmaj, rmin, rpat, rpre, rn)), Some((lmaj, lmin, lpat, lpre, ln))) => {
                if rmaj != lmaj { return rmaj > lmaj; }
                if rmin != lmin { return rmin > lmin; }
                if rpat != lpat { return rpat > lpat; }
                if rpre.is_empty() && !lpre.is_empty() { return true; }
                if !rpre.is_empty() && lpre.is_empty() { return false; }
                if rpre == lpre { return rn > ln; }
                let order = |t: &str| -> u32 { match t { "alpha" => 0, "beta" => 1, _ => 2 } };
                order(&rpre) > order(&lpre)
            }
            _ => remote > current,
        }
    }

    fn friendly_version(version: &str) -> String {
        let v = Self::normalise_version(version);
        if v.ends_with("-alpha") {
            format!("Alpha {}", v.trim_end_matches("-alpha"))
        } else if v.ends_with("-beta") {
            format!("Beta {}", v.trim_end_matches("-beta"))
        } else {
            v
        }
    }

    pub async fn check_for_updates(&self, channel: &str) -> Result<UpdateInfo, String> {
        let resp = self
            .client
            .get("https://api.github.com/repos/jaydenrussell/CallerFlash/releases")
            .send()
            .await
            .map_err(|e| format!("HTTP request failed: {}", e))?;

        let releases: Vec<GitHubRelease> = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse releases: {}", e))?;

        let filtered: Vec<&GitHubRelease> = releases
            .iter()
            .filter(|r| !r.draft)
            .filter(|r| match channel {
                "stable" => !r.tag_name.contains("alpha") && !r.tag_name.contains("beta"),
                "beta" => r.tag_name.contains("beta"),
                "alpha" => r.tag_name.contains("alpha"),
                _ => false,
            })
            .collect();

        let latest = match filtered.into_iter().max_by(|a, b| {
            if Self::is_update_available(&a.tag_name, &b.tag_name) {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Less
            }
        }) {
            Some(r) => r,
            None => return Err("No releases found for channel".to_string()),
        };

        let exe = latest
            .assets
            .iter()
            .find(|a| a.name.ends_with(".exe"))
            .ok_or_else(|| "No .exe asset found".to_string())?;

        let version = Self::normalise_version(&latest.tag_name);

        if !Self::is_update_available(&self.current_version, &version) {
            return Err("Up to date".to_string());
        }

        Ok(UpdateInfo {
            version: latest.tag_name.clone(),
            download_url: exe.browser_download_url.clone(),
            published_at: latest.published_at.clone(),
            friendly_name: Self::friendly_version(&latest.tag_name),
        })
    }

    pub async fn download_update(
        &self,
        version: &str,
        download_url: &str,
        emit_progress: impl Fn(u32),
    ) -> Result<PathBuf, String> {
        let filename = format!("CallerFlash-{}.exe", Self::normalise_version(version));
        let dest = self.temp_dir.join(&filename);

        if dest.exists() {
            return Ok(dest);
        }

        let resp = self
            .client
            .get(download_url)
            .send()
            .await
            .map_err(|e| format!("Download failed: {}", e))?;

        let total = resp.content_length().unwrap_or(0);
        let mut downloaded: u64 = 0;
        let mut file = fs::File::create(&dest).map_err(|e| format!("File create failed: {}", e))?;

        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("Download stream error: {}", e))?;
            downloaded += chunk.len() as u64;
            if total > 0 {
                let pct = ((downloaded as f64 / total as f64) * 100.0) as u32;
                emit_progress(pct);
            }
            file.write_all(&chunk)
                .map_err(|e| format!("File write error: {}", e))?;
        }

        // Clean old downloads
        if let Ok(entries) = fs::read_dir(&self.temp_dir) {
            let vers = Self::normalise_version(version);
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.ends_with(".exe") && !name.contains(&vers) {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }

        Ok(dest)
    }
}

#[tauri::command]
pub async fn updater_check(app: AppHandle, channel: String) -> Result<serde_json::Value, String> {
    let updater = app.state::<Updater>();
    match updater.check_for_updates(&channel).await {
        Ok(info) => Ok(serde_json::json!({
            "version": info.version,
            "downloadUrl": info.download_url,
            "publishedAt": info.published_at,
            "friendlyName": info.friendly_name,
        })),
        Err(e) => {
            if e == "Up to date" {
                Ok(serde_json::json!({"upToDate": true}))
            } else {
                Ok(serde_json::json!({"error": e}))
            }
        }
    }
}

#[tauri::command]
pub async fn updater_download(
    app: AppHandle,
    _channel: String,
    version: String,
    download_url: String,
) -> Result<serde_json::Value, String> {
    let updater = app.state::<Updater>();
    let app_clone = app.clone();
    let result = updater
        .download_update(&version, &download_url, move |pct| {
            let _ = app_clone.emit("updater:progress", serde_json::json!({"percent": pct}));
        })
        .await;

    match result {
        Ok(path) => {
            let _ = app.emit("updater:status", UpdateStatus {
                status: "ready".to_string(),
                version: Some(version),
                message: None,
                progress: None,
            });
            Ok(serde_json::json!({"status": "ready", "path": path}))
        }
        Err(e) => {
            let _ = app.emit("updater:status", UpdateStatus {
                status: "error".to_string(),
                version: None,
                message: Some(e.clone()),
                progress: None,
            });
            Ok(serde_json::json!({"status": "error", "error": e}))
        }
    }
}

#[tauri::command]
pub async fn updater_install(app: AppHandle, version: String) -> Result<serde_json::Value, String> {
    let updater = app.state::<Updater>();
    let exe_path = updater
        .temp_dir
        .join(format!("CallerFlash-{}.exe", Updater::normalise_version(&version)));

    if !exe_path.exists() {
        return Ok(serde_json::json!({"status": "error", "error": "File not found. Download again."}));
    }

    let preloader_path = app
        .path()
        .resource_dir()
        .unwrap_or_default()
        .join("CallerFlash-Preloader.exe");

    if !preloader_path.exists() {
        return Ok(serde_json::json!({"status": "error", "error": "Update component not found. Reinstall the app."}));
    }

    let current_exe = std::env::current_exe().unwrap_or_default();
    let install_dir = current_exe.parent().unwrap_or(std::path::Path::new("."));

    let child = std::process::Command::new(&preloader_path)
        .arg("--parent-pid")
        .arg(std::process::id().to_string())
        .arg("--installer")
        .arg(exe_path.to_string_lossy().to_string())
        .arg("--installdir")
        .arg(install_dir.to_string_lossy().to_string())
        .arg("--app")
        .arg(current_exe.to_string_lossy().to_string())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();

    match child {
        Ok(_c) => {
            let _ = app.emit("updater:status", UpdateStatus {
                status: "installing".to_string(),
                version: Some(version),
                message: None,
                progress: None,
            });
            tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
            std::process::exit(0);
        }
        Err(e) => Ok(serde_json::json!({"status": "error", "error": format!("Failed to start preloader: {}", e)})),
    }
}
