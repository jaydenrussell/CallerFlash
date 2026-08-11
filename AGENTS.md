# AGENTS.md

## Operating model (HARD RULE)

- The working copy is the git checkout at `D:\CallerFlash` on `main`; edit and build there (`cargo check`, `npm run ...`). Publish changes to GitHub `main` via `gh api` (contents + PUT with the file's `sha`), then keep the local file in sync so the checkout never drifts from what CI sees.
- Read a file from GitHub with `gh api repos/jaydenrussell/CallerFlash/contents/<path>?ref=main` (base64 `content`), decode to a temp file, edit, re-encode, and `PUT` with the file's `sha`. New files use `POST`.
- The branch to work on is **`main`**. The older Electron app (`jaydenrussell/Sip-Toast`) is a stale predecessor — do not edit it.

## What this repo is

CallerFlash: a Windows SIP caller-ID app (registers to a SIP trunk, shows toast notifications on inbound calls, optional Acuity client lookup). `main` is the **Tauri (Rust backend + React frontend)** rewrite. It is NOT the Electron version.

## Architecture map

- `src-tauri/src/` — Rust backend (compiled with `cargo`):
  - `sip.rs` — SIP client via `rsipstack`; emits `sip:status` events with states `connecting` / `registered` / `error` / `disconnected`; `sip_connect`, `sip_disconnect`, `sip_test_connection` commands.
  - `tray.rs` — system tray. Icon/tooltip are driven by a backend listener on `sip:status` (status→color: green=registered, red=error, amber=connecting, blue=idle). `tray_set_sip_status` updates the tooltip only.
  - `diagnostics.rs` — append/load diagnostic log store.
  - `lib.rs` — Tauri builder + `invoke_handler` registration (every new `#[tauri::command]` must be added here and re-exported via `pub use`).
  - `main.rs` — entry point, calls `app_lib::run()`.
- `src/` — React frontend (Vite + TypeScript, Zustand store):
  - `tauri-bridge.ts` — wraps Tauri `invoke`/`listen`/`emit` into `window.callerflash`. **Add any new backend command here AND in `electron-bridge.d.ts`** (the `CallerFlashBridge` interface) or TypeScript will error.
  - `store/useAppStore.ts` — app state; `sipConnected` / `sipRegistered` / `isConnecting` drive the UI.
  - `components/SipSettings.tsx`, `Sidebar.tsx`, `Dashboard.tsx`, `Diagnostics.tsx` — UI.
- `src-tauri/Cargo.toml` — Tauri `2.11.x`; tray features require `"tray-icon"` + `"image-png"`.

## SIP status gotchas

- A REGISTER response wait is bounded by a 15s `tokio::time::timeout` in `sip.rs` (`do_register`). If you change the transaction/receive loop, keep a timeout or the client hangs on "connecting" forever.
- `sip_test_connection` does DNS timing + IP/family + a TCP/TLS port probe (or UDP bind check). Extend it there; surface results through `SipSettings.tsx` → Diagnostics log.

## Build / verify constraints

- Local builds work in `D:\CallerFlash` (`cargo check`, `cargo test`, `npm run build`) and are the first validation step before pushing. After pushing to GitHub `main`, CI (`.github/workflows/*.yml`) re-validates; watch CI and fix any compile errors there.
- Lint: `eslint` for TS. Keep Rust additions minimal and API-correct (Tauri 2 `Image::from_rgba(w,h,rgba) -> Result<Image,Error>`, `tray.set_icon(Image)`, `app.listen` returns a `Copy` `EventId` so ignoring it is safe).
