mod diagnostics;
mod sip;
mod storage;
mod tray;
mod updater;

use diagnostics::Diagnostics;
use sip::SipClient;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use updater::Updater;

// Re-export command functions so generate_handler can find the generated __cmd__ macros
pub use storage::{storage_load, storage_save};
pub use sip::{sip_connect, sip_disconnect};
pub use updater::{updater_check, updater_download, updater_install};
pub use tray::{tray_set_sip_status, tray_set_update_available};

#[derive(Clone, serde::Serialize)]
struct DiagnosticEvent {
    level: String,
    message: String,
    details: Option<String>,
}

#[tauri::command]
async fn diagnostics_append(app: AppHandle, entry: serde_json::Value) {
    let data_dir = app.path().app_data_dir().unwrap_or_default();
    let diag = Diagnostics::new(data_dir);

    let log_entry = diagnostics::LogEntry {
        id: entry.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        timestamp: entry.get("timestamp").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        level: entry.get("level").and_then(|v| v.as_str()).unwrap_or("info").to_string(),
        category: entry.get("category").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        message: entry.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        details: entry.get("details").and_then(|v| v.as_str().map(String::from)),
    };
    diag.append(&log_entry);
}

#[tauri::command]
async fn diagnostics_load(app: AppHandle) -> Vec<diagnostics::LogEntry> {
    let data_dir = app.path().app_data_dir().unwrap_or_default();
    let diag = Diagnostics::new(data_dir);
    diag.load(1000)
}

#[tauri::command]
async fn safe_storage_encrypt(plaintext: String) -> Result<Option<String>, String> {
    Ok(Some(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        plaintext.as_bytes(),
    )))
}

#[tauri::command]
async fn safe_storage_decrypt(base64_cipher: String) -> Result<Option<String>, String> {
    match base64::Engine::decode(&base64::engine::general_purpose::STANDARD, base64_cipher.as_bytes()) {
        Ok(bytes) => Ok(Some(String::from_utf8(bytes).unwrap_or_default())),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
async fn shell_open_external(url: String) -> Result<(), String> {
    if url.starts_with("https:") || url.starts_with("http:") {
        open::that(&url).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn notify_show(app: AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Toast window management ────────────────────────────────────────

struct ToastState {
    pending_data: Mutex<Option<serde_json::Value>>,
}

#[tauri::command]
async fn toast_show(app: AppHandle, data: serde_json::Value) -> Result<(), String> {
    if let Some(state) = app.try_state::<ToastState>() {
        if let Ok(mut pending) = state.pending_data.lock() {
            *pending = Some(data.clone());
        }
    }

    if app.get_webview_window("toast").is_some() {
        if let Some(window) = app.get_webview_window("toast") {
            let _ = window.show();
            let _ = window.set_focus();
        }
        app.emit("toast:show:event", data).map_err(|e| e.to_string())?;
        return Ok(());
    }

    let width = data
        .get("config")
        .and_then(|c| c.get("maxWidth"))
        .and_then(|v| v.as_u64())
        .map(|w| w.max(260).min(800) as f64)
        .unwrap_or(380.0);

    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        "toast",
        tauri::WebviewUrl::App("toast.html".into()),
    )
    .title("")
    .inner_size(width, 150.0)
    .min_inner_size(200.0, 80.0)
    .always_on_top(true)
    .decorations(false)
    .transparent(true)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false);

    let window = builder.build().map_err(|e| format!("Failed to create toast window: {}", e))?;

    let _ = window.set_always_on_top(true);

    // Position at top-right
    if let Some(monitor) = window.current_monitor().map_err(|e| e.to_string())? {
        let size = monitor.size();
        let scale = monitor.scale_factor();
        let wa_w = (size.width as f64 / scale) as f64;
        let x = wa_w - width - 16.0;
        let y = 40.0;
        let _ = window.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
    }

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let _ = window.show();
    let _ = window.set_focus();

    Ok(())
}

#[tauri::command]
async fn toast_hide(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("toast") {
        let _ = window.hide();
    }
    Ok(())
}

#[tauri::command]
async fn toast_set_position(app: AppHandle, x: i32, y: i32) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("toast") {
        window.set_position(tauri::PhysicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn toast_get_position(app: AppHandle) -> Result<Option<(i32, i32)>, String> {
    if let Some(window) = app.get_webview_window("toast") {
        let pos = window.outer_position().map_err(|e| e.to_string())?;
        Ok(Some((pos.x, pos.y)))
    } else {
        Ok(None)
    }
}

#[tauri::command]
async fn toast_get_initial(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    if let Some(state) = app.try_state::<ToastState>() {
        if let Ok(mut pending) = state.pending_data.lock() {
            let data = pending.take();
            return Ok(data);
        }
    }
    Ok(None)
}

// ── App lifecycle ──────────────────────────────────────────────────

#[tauri::command]
fn app_set_start_with_windows(enabled: bool) {
    let key_path = r"Software\Microsoft\Windows\CurrentVersion\Run";
    let value_name = "CallerFlash";

    if enabled {
        if let Ok(exe) = std::env::current_exe() {
            let exe_str = exe.to_string_lossy().to_string();
            let _ = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
                .open_subkey_with_flags(key_path, winreg::enums::KEY_SET_VALUE)
                .and_then(|key| key.set_value(value_name, &exe_str));
        }
    } else {
        let _ = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
            .open_subkey_with_flags(key_path, winreg::enums::KEY_SET_VALUE)
            .and_then(|key| key.delete_value(value_name));
    }
}

// ── App entry point ────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            app.manage(SipClient::new(app.handle().clone()));
            app.manage(Updater::new(app.handle()));
            app.manage(ToastState {
                pending_data: Mutex::new(None),
            });
            tray::setup_tray(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            storage_load,
            storage_save,
            diagnostics_append,
            diagnostics_load,
            safe_storage_encrypt,
            safe_storage_decrypt,
            shell_open_external,
            notify_show,
            sip_connect,
            sip_disconnect,
            updater_check,
            updater_download,
            updater_install,
            tray_set_sip_status,
            tray_set_update_available,
            toast_show,
            toast_hide,
            toast_set_position,
            toast_get_position,
            toast_get_initial,
            app_set_start_with_windows,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
