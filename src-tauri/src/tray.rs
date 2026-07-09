use serde_json::Value;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Listener, Manager,
};

/// Map a SIP status string (backend `sip:status` or frontend label) to an icon tint.
fn status_color(status: &str) -> (u8, u8, u8) {
    match status.to_lowercase().as_str() {
        "registered" => (22, 163, 74),          // green
        "error" => (220, 38, 38),               // red
        "connecting" => (234, 179, 8),          // amber
        "disconnected" | "offline" => (37, 99, 235), // blue
        _ => (37, 99, 235),                     // blue (default/idle)
    }
}

/// Build a 32x32 RGBA tray icon tinted with the given color (transparent corners).
fn build_status_icon(rgb: (u8, u8, u8)) -> Option<tauri::image::Image<'static>> {
    let size: u32 = 32;
    let mut rgba: Vec<u8> = Vec::with_capacity((size * size * 4) as usize);
    let cx = size as f32 / 2.0;
    let cy = size as f32 / 2.0;
    let radius: f32 = 13.0;
    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 - cx;
            let dy = y as f32 - cy;
            let dist = (dx * dx + dy * dy).sqrt();
            if dist <= radius {
                rgba.extend_from_slice(&[rgb.0, rgb.1, rgb.2, 255]);
            } else {
                rgba.extend_from_slice(&[0, 0, 0, 0]);
            }
        }
    }
    Some(tauri::image::Image::new_owned(rgba, size, size))
}

/// Update the tray icon + tooltip to reflect the current SIP status.
fn apply_sip_status(app: &AppHandle, status: &str) {
    let color = status_color(status);
    let tip = format!("CallerFlash - SIP {}", status);
    if let Some(tray) = app.tray_by_id("main") {
        if let Some(icon) = build_status_icon(color) {
            let _ = tray.set_icon(Some(icon));
        }
        let _ = tray.set_tooltip(Some(&tip));
    }
}

pub struct TrayState {
    pub sip_status: std::sync::Mutex<String>,
    pub update_version: std::sync::Mutex<Option<String>>,
}

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show CallerFlash", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "Hide to Tray", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit CallerFlash", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show, &hide, &separator, &quit])?;

    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png")).expect(
        "Failed to load tray icon - ensure src-tauri/icons/32x32.png exists and is a valid PNG",
    );

    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("CallerFlash")
        .on_tray_icon_event(move |tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                let _ = app.emit("window:restored-from-tray", ());
            }
            "hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
                let _ = app.emit("window:hidden-to-tray", ());
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    // Reflect real backend SIP state in the tray icon/tooltip. This is the
    // authoritative source (includes the "error" state, which the frontend
    // label alone does not surface).
    let tray_app = app.clone();
    app.listen("sip:status", move |event| {
        let payload = event.payload();
        if let Ok(value) = serde_json::from_str::<Value>(payload) {
            if let Some(status) = value.get("status").and_then(|v| v.as_str()) {
                apply_sip_status(&tray_app, status);
            }
        }
    });

    app.manage(TrayState {
        sip_status: std::sync::Mutex::new("Offline".to_string()),
        update_version: std::sync::Mutex::new(None),
    });

    Ok(())
}

#[tauri::command]
pub fn tray_set_sip_status(app: AppHandle, status: String) {
    if let Some(state) = app.try_state::<TrayState>() {
        if let Ok(mut s) = state.sip_status.lock() {
            *s = status.clone();
        }
    }
    let tip = format!("CallerFlash - SIP {}", status);
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(&tip));
    }
}

#[tauri::command]
pub fn tray_set_update_available(app: AppHandle, version: Option<String>) {
    if let Some(state) = app.try_state::<TrayState>() {
        if let Ok(mut v) = state.update_version.lock() {
            *v = version.clone();
        }
    }
    let tip = if let Some(ref ver) = version {
        format!(
            "CallerFlash - Update {} available",
            ver.trim_start_matches('v')
        )
    } else {
        "CallerFlash".to_string()
    };
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(&tip));
    }
}
