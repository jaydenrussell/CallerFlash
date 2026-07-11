# CI Build Only

Enforce that all builds happen via GitHub Actions, never locally.

## Rules

1. **NEVER run `npm run build:tauri`, `cargo build`, `cargo tauri build`, or any build command locally.** Local builds waste time, produce confusion about which build is current, and risk clone/environment drift.

2. **Always commit and push to GitHub immediately after making changes.** The local clone at `C:\Users\JAYDEN~1\AppData\Local\Temp\CallerFlash` is the git working directory; GitHub (`origin/refactor/tauri`) is the source of truth.

3. **After every commit, run `git push origin refactor/tauri`.** No exceptions.

4. **To verify changes compile or tests pass, run only:**
   - `npx tsc --noEmit` (TypeScript type-check, fast, no build)
   - `cargo check` (Rust type-check, fast, no build)
   - `cargo test --package callerflash --lib sip::tests` (unit tests only, no Tauri deps rebuild needed)
   These are allowed because they are NOT builds — they verify correctness without producing artifacts.

5. **Never produce an installer or binary locally.** Installers come from GitHub Actions on push.

## CI Build Trigger

The GitHub Actions workflow builds on every push to `refactor/tauri`:
- `.github/workflows/build.yml` (or equivalent)

If CI fails, inspect the logs and fix the issue locally (check + test only), then commit the fix and push again. Never attempt a full build to "verify it works here."

## Work Directory

All work happens in the single local clone:
- `C:\Users\JAYDEN~1\AppData\Local\Temp\CallerFlash`
- Never use any other directory
- Never re-clone
- Never stash or switch branches unnecessarily
