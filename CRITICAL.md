# CRITICAL RULES — READ BEFORE ANY WORK

1. NO LOCAL BUILDS. EVER. `npm run build:tauri`, `cargo build`, `cargo tauri build` are FORBIDDEN.
2. Commit → `git push origin refactor/tauri` immediately after every change.
3. Only `tsc --noEmit`, `cargo check`, `cargo test` are allowed for verification.
4. GitHub Actions builds the installer. Check CI logs if it fails.
5. Working directory: `C:\Users\JAYDEN~1\AppData\Local\Temp\CallerFlash` only.
