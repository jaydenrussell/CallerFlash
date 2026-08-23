use serde_json::Value;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Listener, Manager,
};

/// Append a backend-generated entry to the user-visible Diagnostics log.
/// Used for tray icon lifecycle events so icon problems are observable from
/// the Diagnostics tab even though release builds have no console.
fn tray_diag(app: &AppHandle, level: &str, message: &str, details: Option<String>) {
    let ts = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let entry = serde_json::json!({
        "id": format!("tray-{millis}"),
        "timestamp": ts,
        "level": level,
        "category": "TRAY",
        "message": message,
        "details": details,
    });
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let diag = crate::diagnostics::Diagnostics::new(data_dir);
    if let Ok(log_entry) = serde_json::from_value::<crate::diagnostics::LogEntry>(entry) {
        if log_entry.validate().is_ok() {
            diag.append(&log_entry);
        }
    }
}

/// Map a SIP status string (backend `sip:status` or frontend label) to an icon tint.
fn status_color(status: &str) -> (u8, u8, u8) {
    match status.to_lowercase().as_str() {
        "registered" => (22, 163, 74),               // green
        "error" => (220, 38, 38),                    // red
        "connecting" => (234, 179, 8),               // amber
        "disconnected" | "offline" => (37, 99, 235), // blue
        _ => (37, 99, 235),                          // blue (default/idle)
    }
}

// ---------------------------------------------------------------------------
// Phone-glyph composition
//
// The tray shows the app logo with a small phone handset overlaid at its
// center, tinted with the current SIP status color. The handset is drawn
// procedurally: an annulus sector (the curved body) plus two discs at the
// ends (ear/mouthpieces), the classic handset silhouette. A soft dark halo
// keeps it legible over any logo artwork. Coverage is computed with 2x2
// supersampling so edges are antialiased at tray sizes.
// ---------------------------------------------------------------------------

#[cfg(test)]
const CANVAS: u32 = 32;
// Arc geometry (pixels, angles in radians). Center sits off-canvas so the
// band sweeps diagonally through the icon center. Sized so the handset
// spans ~18px of the 32px canvas: Windows shows the tray at 16px logical,
// and anything smaller disappears after downscaling.
const ARC_CX: f32 = 2.8;
const ARC_CY: f32 = 2.8;
const ARC_R_IN: f32 = 15.0;
const ARC_R_OUT: f32 = 21.0;
const ARC_R_MID: f32 = 18.0;
// 35deg .. 55deg around the off-canvas center => midpoint lands at ~(15.5, 15.5).
const ARC_A0: f32 = 0.610_865_2;
const ARC_A1: f32 = 0.959_931_1;
const CAP_R: f32 = 4.6;
// Layered contrast so the glyph reads over any logo artwork: a near-white
// rim hugging the glyph (separates from saturated hues like the magenta
// logo body) over a faint dark shadow (separates from light/transparent
// areas). Both are the glyph shape dilated outward.
const RIM_GROW: f32 = 1.4;
const RIM_ALPHA: f32 = 0.95;
const SHADOW_GROW: f32 = 2.4;
const SHADOW_ALPHA: f32 = 0.45;

fn point_at(angle: f32, grow: f32) -> (f32, f32) {
    let r = ARC_R_MID + grow * 0.5;
    (ARC_CX + r * angle.cos(), ARC_CY + r * angle.sin())
}

/// Inside the handset body/caps (grow > 0 widens the shape for the halo).
fn in_phone_shape(x: f32, y: f32, grow: f32) -> bool {
    let dx = x - ARC_CX;
    let dy = y - ARC_CY;
    let d = (dx * dx + dy * dy).sqrt();
    let a = dy.atan2(dx);
    let arc = d >= ARC_R_IN - grow
        && d <= ARC_R_OUT + grow
        && a >= ARC_A0 - grow * 0.055
        && a <= ARC_A1 + grow * 0.055;
    let cap_hit = |p: (f32, f32)| {
        let (ex, ey) = (x - p.0, y - p.1);
        ex * ex + ey * ey <= (CAP_R + grow) * (CAP_R + grow)
    };
    arc || cap_hit(point_at(ARC_A0, grow)) || cap_hit(point_at(ARC_A1, grow))
}

/// Source-over blend of `color` at `alpha` onto one RGBA pixel.
fn blend_pixel(px: &mut [u8], color: (u8, u8, u8), alpha: f32) {
    let a = alpha.clamp(0.0, 1.0);
    if a <= 0.0 {
        return;
    }
    let ia = 1.0 - a;
    let chans = [color.0, color.1, color.2];
    for i in 0..3 {
        let out = (chans[i] as f32) * a + (px[i] as f32) * ia;
        px[i] = out.round().clamp(0.0, 255.0) as u8;
    }
    let out_a = a + ia * (px[3] as f32 / 255.0);
    px[3] = (out_a * 255.0).round().clamp(0.0, 255.0) as u8;
}

/// Overlay the status-tinted phone handset onto a copy of the logo RGBA.
fn compose_tray_icon(base_rgba: &[u8], size: u32, rgb: (u8, u8, u8)) -> Vec<u8> {
    let mut out = base_rgba.to_vec();
    let samples: [(f32, f32); 4] = [(0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)];
    for y in 0..size {
        for x in 0..size {
            let mut cov_glyph = 0.0f32;
            let mut cov_rim = 0.0f32;
            let mut cov_shadow = 0.0f32;
            for (sx, sy) in samples {
                let px = x as f32 + sx;
                let py = y as f32 + sy;
                if in_phone_shape(px, py, 0.0) {
                    cov_glyph += 0.25;
                } else if in_phone_shape(px, py, RIM_GROW) {
                    cov_rim += 0.25;
                } else if in_phone_shape(px, py, SHADOW_GROW) {
                    cov_shadow += 0.25;
                }
            }
            if cov_glyph == 0.0 && cov_rim == 0.0 && cov_shadow == 0.0 {
                continue;
            }
            let idx = ((y * size + x) * 4) as usize;
            let px = &mut out[idx..idx + 4];
            if cov_shadow > 0.0 {
                blend_pixel(px, (10, 12, 18), cov_shadow * SHADOW_ALPHA);
            }
            if cov_rim > 0.0 {
                blend_pixel(px, (250, 250, 252), cov_rim * RIM_ALPHA);
            }
            if cov_glyph > 0.0 {
                blend_pixel(px, rgb, cov_glyph);
            }
        }
    }
    out
}

/// Build the tray icon: app logo + status-colored handset.
fn build_status_icon(rgb: (u8, u8, u8)) -> Option<tauri::image::Image<'static>> {
    let (base, size) = tray_base_logo()?;
    let out = compose_tray_icon(&base, size, rgb);
    // Runtime sanity guard: a malformed buffer would otherwise be handed to
    // the OS as a corrupt icon (or silently rejected, leaving the default).
    if out.len() != (size * size * 4) as usize {
        log::error!(
            "[tray] composed icon buffer is {} bytes, expected {} — refusing to apply",
            out.len(),
            size * size * 4
        );
        return None;
    }
    Some(tauri::image::Image::new_owned(out, size, size))
}

/// Decode the bundled 32x32 logo once; reused for every status change.
fn tray_base_logo() -> Option<(Vec<u8>, u32)> {
    static BASE: std::sync::OnceLock<Option<(Vec<u8>, u32)>> = std::sync::OnceLock::new();
    BASE.get_or_init(|| {
        let img =
            tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png").as_ref()).ok()?;
        Some((img.rgba().to_owned(), img.width()))
    })
    .clone()
}

/// Update the tray icon + tooltip to reflect the current SIP status.
fn apply_sip_status(app: &AppHandle, status: &str) {
    let color = status_color(status);
    let tip = format!("CallerFlash - SIP {}", status);
    let Some(tray) = app.tray_by_id("main") else {
        // Without an id match this function can never touch the real tray —
        // log loudly (and once per run in the Diagnostics tab).
        static WARNED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
        if WARNED.get().is_none() {
            log::error!("[tray] tray handle 'main' not found — status icon updates are no-ops");
            tray_diag(
                app,
                "error",
                "Tray icon not found by id 'main' — status overlay disabled",
                None,
            );
            let _ = WARNED.set(());
        }
        return;
    };
    let Some(icon) = build_status_icon(color) else {
        static WARNED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
        if WARNED.get().is_none() {
            log::error!("[tray] failed to compose status icon (base logo missing or invalid)");
            tray_diag(
                app,
                "error",
                "Failed to compose tray status icon — bundled logo missing or invalid",
                Some(format!("status: {}", status)),
            );
            let _ = WARNED.set(());
        }
        return;
    };
    let size = icon.width();
    if let Err(e) = tray.set_icon(Some(icon)) {
        static WARNED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
        if WARNED.get().is_none() {
            log::error!("[tray] set_icon failed: {}", e);
            tray_diag(
                app,
                "error",
                "Applying tray status icon failed",
                Some(e.to_string()),
            );
            let _ = WARNED.set(());
        }
        return;
    }
    let _ = tray.set_tooltip(Some(&tip));
    // One-time positive validation so it is observable that composition and
    // application actually happened.
    static VALIDATED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if VALIDATED.get().is_none() {
        let _ = VALIDATED.set(true);
        log::info!(
            "[tray] status icon applied: {}x{} RGBA, glyph tinted for '{}'",
            size,
            size,
            status
        );
        tray_diag(
            app,
            "info",
            &format!(
                "Tray status icon applied ({}x{} RGBA, glyph composited)",
                size, size
            ),
            Some(format!("initial status: {}", status)),
        );
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

    // Load the bundled logo; if it is missing/corrupt fall back to the
    // window icon instead of panicking at startup.
    let icon = match tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png")) {
        Ok(icon) => Some(icon),
        Err(e) => {
            log::error!(
                "[tray] Failed to load bundled 32x32.png: {} — falling back to default window icon",
                e
            );
            tray_diag(
                app,
                "error",
                "Bundled tray logo failed to load — using default app icon",
                Some(e.to_string()),
            );
            app.default_window_icon().cloned()
        }
    };

    // The id MUST match the "main" lookups in apply_sip_status /
    // tray_set_sip_status / tray_set_update_available. A builder without an
    // id gets a generated one, so every tray_by_id("main") call silently
    // missed and status icons never applied.
    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("CallerFlash");
    if let Some(icon) = icon {
        builder = builder.icon(icon);
    }
    builder
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

    // Render the status glyph immediately at startup (idle blue). Without
    // this the tray shows a bare logo until the first sip:status event,
    // which reads as "the phone icon is missing".
    apply_sip_status(app, "Offline");

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

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(size: u32, rgba: [u8; 4]) -> Vec<u8> {
        let mut v = Vec::new();
        for _ in 0..size * size {
            v.extend_from_slice(&rgba);
        }
        v
    }

    #[test]
    fn glyph_center_takes_status_color() {
        let base = solid(CANVAS, [255, 0, 0, 255]);
        let out = compose_tray_icon(&base, CANVAS, status_color("registered"));
        let idx = ((16 * CANVAS + 16) * 4) as usize;
        // Fully covered pixel should land on the green status tint.
        assert!(out[idx].abs_diff(22) <= 2);
        assert!(out[idx + 1].abs_diff(163) <= 2);
        assert!(out[idx + 2].abs_diff(74) <= 2);
        assert_eq!(out[idx + 3], 255);
    }

    #[test]
    fn logo_pixels_away_from_glyph_unchanged() {
        let base = solid(CANVAS, [255, 0, 0, 255]);
        let out = compose_tray_icon(&base, CANVAS, status_color("error"));
        for (x, y) in [(1usize, 30usize), (30, 2), (2, 2), (29, 29)] {
            let idx = (y * CANVAS as usize + x) * 4;
            assert_eq!(&out[idx..idx + 4], &[255, 0, 0, 255]);
        }
    }

    #[test]
    fn different_statuses_produce_different_centers() {
        let base = solid(CANVAS, [128, 128, 128, 255]);
        let green = compose_tray_icon(&base, CANVAS, status_color("registered"));
        let red = compose_tray_icon(&base, CANVAS, status_color("error"));
        let amber = compose_tray_icon(&base, CANVAS, status_color("connecting"));
        let blue = compose_tray_icon(&base, CANVAS, status_color("offline"));
        let centers = [&green, &red, &amber, &blue];
        for a in 0..centers.len() {
            for b in (a + 1)..centers.len() {
                let ia = ((16 * CANVAS + 16) * 4) as usize;
                let ib = ((16 * CANVAS + 16) * 4) as usize;
                let pa = &centers[a][ia..ia + 3];
                let pb = &centers[b][ib..ib + 3];
                assert_ne!(pa, pb);
            }
        }
    }

    #[test]
    fn output_preserves_dimensions_and_length() {
        let base = solid(CANVAS, [10, 20, 30, 40]);
        let out = compose_tray_icon(&base, CANVAS, status_color("registered"));
        assert_eq!(out.len(), (CANVAS * CANVAS * 4) as usize);
    }

    #[test]
    fn glyph_footprint_is_large_enough_for_tray_downscaling() {
        // Windows renders the tray at 16px logical; the glyph + rim must
        // occupy enough of the 32px canvas to survive that 2x shrink.
        let base = solid(CANVAS, [128, 128, 128, 255]);
        let out = compose_tray_icon(&base, CANVAS, status_color("registered"));
        let modified = (0..(CANVAS * CANVAS) as usize)
            .filter(|&i| out[i * 4..i * 4 + 3] != base[i * 4..i * 4 + 3])
            .count();
        assert!(
            modified >= 150,
            "only {modified} px touched; glyph too small"
        );
    }

    #[test]
    fn white_rim_separates_glyph_from_logo() {
        // Somewhere just outside the glyph body the composite must be
        // near-white regardless of the underlying logo color.
        let base = solid(CANVAS, [128, 128, 128, 255]);
        let out = compose_tray_icon(&base, CANVAS, status_color("registered"));
        let has_rim = (0..(CANVAS * CANVAS) as usize).any(|i| {
            let p = &out[i * 4..i * 4 + 3];
            p[0] > 220 && p[1] > 220 && p[2] > 220
        });
        assert!(has_rim, "no near-white rim pixels found");
    }
}
