use serde::Serialize;
use tauri::{Manager, Runtime};
use tauri_plugin_updater::UpdaterExt;

/// Stable channel endpoint. `releases/latest` resolves to the newest
/// non-prerelease release, so this always serves the latest stable.
const STABLE_UPDATE_ENDPOINT: &str =
    "https://github.com/jaydenrussell/CallerFlash/releases/latest/download/update.json";

const UPDATE_REPO_API: &str = "https://api.github.com/repos/jaydenrussell/CallerFlash";

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))
}

/// Mirror of the frontend's `/-(beta|tauri)(\.|$)/i` tag filter: a beta tag
/// ends with (or continues with `.`/`-` after) a `-beta` or `-tauri` marker.
fn matches_beta_tag(tag: &str) -> bool {
    let lower = tag.to_lowercase();
    for marker in ["-beta", "-tauri"] {
        let mut from = 0;
        while let Some(pos) = lower[from..].find(marker) {
            let abs = from + pos;
            let rest = &lower[abs + marker.len()..];
            if rest.is_empty() || rest.starts_with('.') || rest.starts_with('-') {
                return true;
            }
            from = abs + marker.len();
        }
    }
    false
}

/// GitHub has no "latest prerelease" alias, so the beta channel endpoint is
/// resolved by listing recent releases. Any failure falls back to the stable
/// endpoint — the updater still signature-verifies whatever it downloads.
async fn resolve_channel_endpoint(channel: &str) -> String {
    if channel != "beta" {
        return STABLE_UPDATE_ENDPOINT.to_string();
    }
    let tag = async {
        let resp = http_client()
            .ok()?
            .get(format!("{UPDATE_REPO_API}/releases?per_page=20"))
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let releases: serde_json::Value = resp.json().await.ok()?;
        releases.as_array()?.iter().find_map(|r| {
            let tag = r.get("tag_name")?.as_str()?;
            r.get("prerelease")?.as_bool()?;
            matches_beta_tag(tag).then(|| tag.to_string())
        })
    };
    match tag.await {
        Some(tag) => format!(
            "https://github.com/jaydenrussell/CallerFlash/releases/download/{tag}/update.json"
        ),
        None => STABLE_UPDATE_ENDPOINT.to_string(),
    }
}

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
    if !matches!(
        host,
        "github.com" | "api.github.com" | "objects.githubusercontent.com"
    ) {
        return Err(format!("Update endpoint host not allowed: {host}"));
    }
    Ok(endpoint.to_string())
}

/// Channel-aware update check.
///
/// The endpoint is resolved entirely in the backend from the requested
/// channel (stable → `releases/latest`, beta → the latest beta tag's
/// release), validated against the host allow-list, then handed to
/// `tauri-plugin-updater` for the signature-verified check/download/install.
/// The renderer never supplies a URL.
#[tauri::command]
pub async fn cmd_check_update<R: Runtime>(
    webview: tauri::Webview<R>,
    channel: Option<String>,
) -> Result<Option<UpdateMetadata>, String> {
    let resolved = resolve_channel_endpoint(channel.as_deref().unwrap_or("stable")).await;
    let endpoint = validate_update_endpoint(&resolved)?;

    let updater = webview
        .updater_builder()
        .endpoints(vec![
            url::Url::parse(&endpoint).map_err(|e| format!("Invalid update endpoint URL: {e}"))?
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

/// Trimmed release info for the renderer's release-history panel. Only the
/// fields the UI renders are forwarded — no asset URLs or author metadata.
#[derive(Serialize)]
pub struct ReleaseInfo {
    pub tag_name: String,
    pub name: Option<String>,
    pub published_at: Option<String>,
    pub prerelease: bool,
    pub body: Option<String>,
    pub html_url: String,
}

/// Fetch the recent GitHub releases for the release-history UI. Runs in the
/// backend so the renderer needs no direct api.github.com access (CSP has no
/// external connect-src). Rate-limited: unauthenticated GitHub API quota is
/// 60 req/hour per IP.
#[tauri::command]
pub async fn cmd_list_releases() -> Result<Vec<ReleaseInfo>, String> {
    if !crate::ratelimit::RATE_LIMITER.check("list_releases") {
        return Err("Too many requests. Try again shortly.".into());
    }
    let resp = http_client()?
        .get(format!("{UPDATE_REPO_API}/releases?per_page=20"))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch releases: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GitHub API returned {}", resp.status()));
    }
    let releases: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid release list response: {e}"))?;
    let arr = releases
        .as_array()
        .ok_or_else(|| "Unexpected release list shape".to_string())?;
    Ok(arr
        .iter()
        .filter_map(|r| {
            Some(ReleaseInfo {
                tag_name: r.get("tag_name")?.as_str()?.to_string(),
                name: r.get("name").and_then(|v| v.as_str()).map(String::from),
                published_at: r
                    .get("published_at")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                prerelease: r
                    .get("prerelease")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                body: r.get("body").and_then(|v| v.as_str()).map(String::from),
                html_url: r.get("html_url")?.as_str()?.to_string(),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::matches_beta_tag;

    #[test]
    fn beta_tags_match() {
        assert!(matches_beta_tag("v2.1.0-beta"));
        assert!(matches_beta_tag("v2.1.0-beta.28"));
        assert!(matches_beta_tag("V2.1.0-BETA.3"));
        assert!(matches_beta_tag("v2.0.0-tauri"));
        assert!(matches_beta_tag("v2.0.0-tauri.1"));
    }

    #[test]
    fn stable_and_lookalike_tags_do_not_match() {
        assert!(!matches_beta_tag("v2.1.0"));
        assert!(!matches_beta_tag("v2.1.0-betauser"));
        assert!(!matches_beta_tag("v2.1.0-alpine"));
        assert!(!matches_beta_tag("betatest"));
    }
}
