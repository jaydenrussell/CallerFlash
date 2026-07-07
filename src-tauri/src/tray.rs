use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

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
        "Failed to load tray icon — ensure src-tauri/icons/32x32.png exists and is a valid PNG",
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
    let tip = format!("CallerFlash — SIP {}", status);
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
            "CallerFlash — Update {} available",
            ver.trim_start_matches('v')
        )
    } else {
        "CallerFlash".to_string()
    };
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(&tip));
    }
}
