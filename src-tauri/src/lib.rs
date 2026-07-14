mod diagnostics;
mod error;
mod migrate;
mod ratelimit;
mod sip;
mod startup;
mod storage;
mod tray;
mod update;

use diagnostics::{diagnostics_append, diagnostics_export, diagnostics_load};
use error::CommandError;
use ratelimit::RATE_LIMITER;
use sip::SipClient;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Listener, Manager};

pub use sip::{sip_connect, sip_disconnect, sip_test_connection};
pub use storage::{storage_load, storage_save};
pub use tray::{tray_set_sip_status, tray_set_update_available};
pub use update::cmd_verify_update;

const MAX_NOTIFY_TITLE_LENGTH: usize = 256;
const MAX_NOTIFY_BODY_LENGTH: usize = 1024;

// Rate limiters are defined in ratelimit.rs — use RATE_LIMITER and SIP_RATE_LIMITER

#[tauri::command]
async fn shell_open_external(url: String) -> Result<(), CommandError> {
    let url = url.trim().to_string();
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(CommandError::invalid_input(
            "Only HTTP and HTTPS URLs are allowed",
        ));
    }
    if url.len() > 2048 {
        return Err(CommandError::invalid_input("URL too long"));
    }
    if url.contains('\r') || url.contains('\n') || url.contains('\t') {
        return Err(CommandError::invalid_input(
            "URL contains control characters",
        ));
    }
    if let Some(host_start) = url.find("://") {
        let after_protocol = &url[host_start + 3..];
        if after_protocol.starts_with("localhost")
            || after_protocol.starts_with("127.")
            || after_protocol.starts_with("10.")
            || after_protocol.starts_with("192.168.")
            || after_protocol.starts_with("169.254.")
            || after_protocol.starts_with("0.")
            || after_protocol.starts_with("172.16.")
            || after_protocol.starts_with("::1")
            || after_protocol.starts_with("[::1]")
        {
            return Err(CommandError::invalid_input(
                "URL points to a private or loopback address",
            ));
        }
    }
    open::that(&url).map_err(|e| CommandError::io(format!("Failed to open URL: {}", e)))?;
    Ok(())
}

#[tauri::command]
async fn notify_show(app: AppHandle, title: String, body: String) -> Result<(), CommandError> {
    if !RATE_LIMITER.check("notify_show") {
        return Err(CommandError::rate_limited());
    }
    let title = title.trim().to_string();
    let body = body.trim().to_string();
    if title.is_empty() {
        return Err(CommandError::invalid_input(
            "Notification title is required",
        ));
    }
    if title.len() > MAX_NOTIFY_TITLE_LENGTH {
        return Err(CommandError::invalid_input("Notification title too long"));
    }
    if body.len() > MAX_NOTIFY_BODY_LENGTH {
        return Err(CommandError::invalid_input("Notification body too long"));
    }
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| CommandError::io(format!("Failed to show notification: {}", e)))?;
    Ok(())
}

// ── Toast window management ────────────────────────────────────────

struct ToastState {
    pending_data: Mutex<Option<serde_json::Value>>,
}

const MAX_TOAST_WIDTH: u64 = 800;
const MIN_TOAST_WIDTH: u64 = 260;
const DEFAULT_TOAST_WIDTH: f64 = 380.0;
const TOAST_INNER_HEIGHT: f64 = 150.0;
const TOAST_MIN_WIDTH: f64 = 200.0;
const TOAST_MIN_HEIGHT: f64 = 80.0;

#[tauri::command]
async fn toast_show(app: AppHandle, data: serde_json::Value) -> Result<(), CommandError> {
    if !RATE_LIMITER.check("toast_show") {
        return Err(CommandError::rate_limited());
    }
    if !data.is_object() {
        return Err(CommandError::invalid_input(
            "Toast data must be a JSON object",
        ));
    }

    // Size limit: 64KB max toast payload
    let serialized = serde_json::to_string(&data).map_err(|e| {
        CommandError::invalid_input(format!("Toast data serialization failed: {}", e))
    })?;
    if serialized.len() > 65536 {
        return Err(CommandError::invalid_input(
            "Toast data exceeds maximum size of 64KB",
        ));
    }

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
        app.emit("toast:show:event", data)
            .map_err(|e| CommandError::unknown(format!("Emit failed: {}", e)))?;
        return Ok(());
    }

    let width = data
        .get("config")
        .and_then(|c| c.get("maxWidth"))
        .and_then(|v| v.as_u64())
        .map(|w| w.clamp(MIN_TOAST_WIDTH, MAX_TOAST_WIDTH) as f64)
        .unwrap_or(DEFAULT_TOAST_WIDTH);

    let _duration = data
        .get("config")
        .and_then(|c| c.get("duration"))
        .and_then(|v| v.as_u64())
        .map(|d| d.clamp(5, 300))
        .unwrap_or(10);

    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        "toast",
        tauri::WebviewUrl::App("toast.html".into()),
    )
    .title("")
    .inner_size(width, TOAST_INNER_HEIGHT)
    .min_inner_size(TOAST_MIN_WIDTH, TOAST_MIN_HEIGHT)
    .always_on_top(true)
    .decorations(false)
    .transparent(true)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false);

    let window = builder
        .build()
        .map_err(|e| CommandError::unknown(format!("Failed to create toast window: {}", e)))?;

    let _ = window.set_always_on_top(true);

    if let Some(monitor) = window
        .current_monitor()
        .map_err(|e| CommandError::unknown(format!("Monitor error: {}", e)))?
    {
        let mon_pos = monitor.position();
        let mon_size = monitor.size();
        let scale = monitor.scale_factor();
        // Use logical coordinates: convert physical monitor bounds to logical,
        // clamp to the monitor's right edge with 16px margin, 40px from top.
        let x = ((mon_pos.x as f64) / scale) + ((mon_size.width as f64) / scale) - width - 16.0;
        let y = ((mon_pos.y as f64) / scale) + 40.0;
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    }

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let _ = window.show();
    let _ = window.set_focus();

    Ok(())
}

#[tauri::command]
async fn toast_hide(app: AppHandle) -> Result<(), CommandError> {
    if !RATE_LIMITER.check("toast_hide") {
        return Err(CommandError::rate_limited());
    }
    if let Some(window) = app.get_webview_window("toast") {
        let _ = window.hide();
    }
    Ok(())
}

#[tauri::command]
async fn toast_set_position(app: AppHandle, x: i32, y: i32) -> Result<(), CommandError> {
    if let Some(window) = app.get_webview_window("toast") {
        window
            .set_position(tauri::PhysicalPosition::new(x, y))
            .map_err(|e| CommandError::unknown(format!("Position error: {}", e)))?;
    }
    Ok(())
}

#[tauri::command]
async fn toast_get_position(app: AppHandle) -> Result<Option<(i32, i32)>, CommandError> {
    if let Some(window) = app.get_webview_window("toast") {
        let pos = window
            .outer_position()
            .map_err(|e| CommandError::unknown(format!("Position error: {}", e)))?;
        Ok(Some((pos.x, pos.y)))
    } else {
        Ok(None)
    }
}

#[tauri::command]
async fn toast_get_initial(app: AppHandle) -> Result<Option<serde_json::Value>, CommandError> {
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
#[cfg(target_os = "windows")]
fn app_set_start_with_windows(enabled: bool) -> Result<(), CommandError> {
    let key_path = r"Software\Microsoft\Windows\CurrentVersion\Run";
    let value_name = "CallerFlash";

    use winreg::enums::KEY_SET_VALUE;
    use winreg::RegKey;
    let key = RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey_with_flags(key_path, KEY_SET_VALUE)
        .map_err(|e| CommandError::io(format!("Failed to open Run registry key: {}", e)))?;

    if enabled {
        let exe = std::env::current_exe()
            .map_err(|e| CommandError::io(format!("Cannot get exe path: {}", e)))?;
        let exe_str = exe.to_string_lossy().to_string();
        // Quote the path if it contains spaces so Windows Run dialog parses it correctly
        let quoted = if exe_str.contains(' ') {
            format!("\"{}\"", exe_str)
        } else {
            exe_str
        };
        key.set_value(value_name, &quoted)
            .map_err(|e| CommandError::io(format!("Failed to set startup registry: {}", e)))?;
        log::info!("[startup] Set Start with Windows registry: {}", quoted);
    } else {
        key.delete_value(value_name)
            .map_err(|e| CommandError::io(format!("Failed to remove startup registry: {}", e)))?;
        log::info!("[startup] Removed Start with Windows registry");
    }
    Ok(())
}

#[tauri::command]
#[cfg(not(target_os = "windows"))]
fn app_set_start_with_windows(_enabled: bool) -> Result<(), CommandError> {
    log::info!("[startup] Start with Windows not supported on this platform");
    Ok(())
}

#[tauri::command]
#[cfg(target_os = "windows")]
fn app_get_start_with_windows() -> Result<bool, CommandError> {
    use winreg::enums::KEY_READ;
    use winreg::RegKey;

    // 1. Check whether the Run key entry exists
    let run_key = RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\Run", KEY_READ)
        .map_err(|e| CommandError::io(format!("Failed to open Run key: {}", e)))?;
    if run_key.get_value::<String, _>("CallerFlash").is_err() {
        log::info!("[startup] Run key entry missing — startup disabled externally");
        return Ok(false);
    }

    // 2. Check Task Manager / Settings "StartupApproved" state
    //    Byte 8 = 2 means disabled, 3 means enabled.
    if let Ok(approved_key) = RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey_with_flags(
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run",
            KEY_READ,
        )
    {
        if let Ok(raw) = approved_key.get_raw_value("CallerFlash") {
            let data = raw.bytes;
            if data.len() >= 9 && data[8] == 2 {
                log::info!("[startup] StartupApproved shows disabled — toggling off");
                return Ok(false);
            }
        }
    }

    Ok(true)
}

#[tauri::command]
#[cfg(not(target_os = "windows"))]
fn app_get_start_with_windows() -> Result<bool, CommandError> {
    Ok(false)
}

// ── Startup check command ──────────────────────────────────────────

#[tauri::command]
fn run_startup_checks(app: AppHandle) -> error::StartupReport {
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    startup::run_self_check(data_dir)
}

// ── App entry point ────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::default().build())
        .setup(|app| {
            app.manage(SipClient::new(app.handle().clone()));
            app.manage(ToastState {
                pending_data: Mutex::new(None),
            });
            tray::setup_tray(app.handle())?;

            if let Some(main_window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                main_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = app_handle.get_webview_window("main").map(|w| w.hide());
                        let _ = app_handle.emit("window:restored-from-tray", ());
                    }
                });
            }

            let app_handle = app.handle().clone();
            let _ = app.listen("window:minimize", move |_| {
                if let Some(w) = app_handle.get_webview_window("main") {
                    let _ = w.minimize();
                }
            });
            let app_handle = app.handle().clone();
            let _ = app.listen("window:maximize", move |_| {
                if let Some(w) = app_handle.get_webview_window("main") {
                    if w.is_maximized().unwrap_or(false) {
                        let _ = w.unmaximize();
                    } else {
                        let _ = w.maximize();
                    }
                }
            });
            let app_handle = app.handle().clone();
            let _ = app.listen("window:close", move |_| {
                if let Some(w) = app_handle.get_webview_window("main") {
                    let _ = w.hide();
                }
            });
            let app_handle = app.handle().clone();
            let _ = app.listen("window:hide-to-tray", move |_| {
                if let Some(w) = app_handle.get_webview_window("main") {
                    let _ = w.hide();
                }
            });

            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            let report = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                startup::run_self_check(data_dir.clone())
            }))
            .unwrap_or_else(|_| error::StartupReport {
                checks: Vec::new(),
                all_ok: false,
                os_name: "unknown".to_string(),
                os_version: "0".to_string(),
                is_windows_11: false,
                edition: String::new(),
            });
            if !report.all_ok {
                log::warn!("[startup] Some self-checks failed — see report for details");
            }
            if report.os_name == "windows"
                && !report.is_windows_11
            {
                log::warn!(
                    "[startup] Running on pre-Windows 11 build {} (edition: {}) — some features may behave differently",
                    report.os_version, report.edition
                );
            }

            #[cfg(feature = "migration")]
            migrate::run_migration(&data_dir);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            storage_load,
            storage_save,
            diagnostics_append,
            diagnostics_export,
            diagnostics_load,
            shell_open_external,
            notify_show,
            sip_connect,
            sip_disconnect,
            sip_test_connection,
            tray_set_sip_status,
            tray_set_update_available,
            toast_show,
            toast_hide,
            toast_set_position,
            toast_get_position,
            toast_get_initial,
            app_set_start_with_windows,
            app_get_start_with_windows,
            run_startup_checks,
            cmd_verify_update,
        ]);

    builder.run(tauri::generate_context!()).unwrap_or_else(|e| {
        log::error!("Failed to run application: {}", e);
        eprintln!("CallerFlash: Fatal error — {}", e);
    });
}
