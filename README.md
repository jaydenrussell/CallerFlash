# CallerFlash

A SIP-compliant Windows desktop client with toast notifications. Built with Tauri 2.0 (Rust backend) and React (frontend). Optimized for VoIP.ms, works with any standard SIP provider.

## Features

- **Universal SIP** — UDP, TCP, or TLS; works with VoIP.ms, Twilio, Telnyx, Bandwidth, and any RFC-compliant SIP provider
- **Toast notifications** — fully customizable font, colors, position, duration, border radius, and opacity
- **Auto clipboard copy** — caller number automatically copied to your clipboard
- **Draggable toasts** — reposition any notification; position persists for future calls
- **Start with Windows** — optionally launch minimized, calls still detected in background
- **Auto-update** — signed releases with SHA-256 + Ed25519 verification
- **Full diagnostics** — SIP, toast, and system logs with export
- **Security hardened** — CSP, input validation at the IPC trust boundary, encrypted credential storage, credential redaction, SIP input sanitization, clipboard injection protection

## Quick Start (for users)

1. Go to the [Releases](https://github.com/jaydenrussell/CallerFlash/releases) page
2. Download the latest `CallerFlash-Setup-x.x.x.exe`
3. Run the installer — no dependencies required
4. Configure your SIP provider credentials in Settings
5. Click **Connect** on the Dashboard
6. When calls come in, toasts appear and numbers auto-copy to your clipboard

## Development

```bash
# Clone
git clone https://github.com/jaydenrussell/CallerFlash.git
cd callerflash

# Install frontend dependencies
npm install

# Dev server (frontend only)
npm run dev

# Build frontend for production
npm run build

# Build Windows installer (requires Windows + Rust toolchain)
npm run tauri:build

# Run Rust tests
cd src-tauri && cargo test

# Run all Rust checks
cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test

# Run frontend tests
npm test

# Run frontend lint
npm run lint
```

## Architecture

### Trust Boundary

```
[Frontend (React)] --IPC (invoke)--> [Tauri Backend (Rust)]
       ^                                    |
       |  Events (listen/emit)              |
       +------------------------------------+
```

The **trust boundary** sits at the IPC layer. The frontend is treated as untrusted input:

- All IPC command parameters are validated and sanitized on the Rust side before processing
- `serde_json::Value` parameters are schema-validated with field-level length and type checks
- Notification titles/bodies have length limits (256/1024 bytes)
- Toast data is verified to be a JSON object before access
- SIP config is validated (username, server required; port, protocol, expiry range-checked)
- Storage data must be a JSON object (validated on the Rust side)
- URLs for `shell_open_external` must be `http://`/`https://` (≤2048 chars) and must not resolve to a private or loopback address

### Module Layout

```
src-tauri/src/
├── main.rs          # Entry point, windows_subsystem attribute
├── lib.rs           # App setup, command registration, window management
├── error.rs         # Structured error types (CommandError, ErrorKind, StartupReport)
├── startup.rs       # Self-check routine (directories, settings integrity, Win11 detection)
├── storage.rs       # Atomic settings store; SIP password encrypted at rest via DPAPI
├── diagnostics.rs   # Rolling log file, bounded at 10K lines/10MB
├── sip.rs           # UDP/TCP/TLS SIP client, MD5 digest auth, INVITE parsing
└── tray.rs          # System tray menu, icon, event handlers
```

## Security

### Permissions and Capabilities

The app requests only the minimum permissions needed (see `src-tauri/capabilities/default.json`):

| Permission | Purpose | Risk |
|---|---|---|
| `core:default` | Core IPC plumbing | None |
| `core:window:allow-*` | Window show/hide/focus/position for main + toast windows | Safe — no create/close on arbitrary windows |
| `core:event:allow-*` | Frontend ↔ backend event communication | Required for SIP status, toast events |
| `shell:allow-open` | Open HTTPS links in default browser | Scoped to HTTPS only, validated on Rust side |
| `notification:default` | Native Windows notifications | User must grant permission |
| `notification:allow-*` | Notify, check/request permission | Standard OS notification flow |
| `updater:default` | Check and install updates | Uses Ed25519-verified signatures |

**Removed:** `core:window:allow-create` (not needed — toast window is created from Rust setup), `shell:default` (too broad — replaced with specific `shell:allow-open`).

### Permissions NOT requested

- `shell:allow-spawn` — no arbitrary command execution
- `shell:allow-execute` — no arbitrary binary execution
- `fs:*` — no filesystem access from frontend
- `dialog:*` — no file dialogs
- `clipboard:*` — not requested; auto-copy uses the WebView2 `navigator.clipboard` API directly

### Content Security Policy

The CSP in `tauri.conf.json` (and mirrored in `index.html`) restricts:
- `script-src 'self' 'wasm-unsafe-eval'` — no inline scripts
- `style-src 'self' https://fonts.googleapis.com 'unsafe-inline'` — Tailwind/React inline styles + font CDN
- `font-src 'self' https://fonts.gstatic.com data:` — bundled + Google Fonts
- `connect-src 'self' https://api.github.com https://github.com https://objects.githubusercontent.com` — IPC + update checks
- `img-src 'self' data:` — images from bundle or data URIs
- `form-action 'none'`, `object-src 'none'`, `frame-ancestors 'none'`

The toast window (`toast.html`) has its own strict `<meta>` CSP (`script-src 'self'`) and is compiled from `src/toast/main.ts` by the same Vite build; it runs in an isolated webview with no user input surface.

### Credential Storage

SIP passwords are encrypted at rest using Windows DPAPI (`CryptProtectData`, current-user scope):
- Stored value is a `dpapi:<base64>` blob — tied to the machine and user, no key to manage
- The settings file is plain JSON with only the password field encrypted (other fields are not secret)
- Credentials are never written to WebView `localStorage` — the password lives only in the DPAPI-encrypted file
- Atomic temp-file + rename writes with a `settings.json.bak` backup protect against corruption
- Decryption failures produce user-safe messages ("A secure storage error occurred")

### Input Validation

Every IPC command validates its inputs:

| Command | Validation |
|---|---|
| `sip_connect` | Username required (≤128), server required (≤256), port (1–65535), protocol (UDP/TCP/TLS), expiry (30–86400) |
| `notify_show` | Title required (≤256), body (≤1024) |
| `shell_open_external` | Must start with `http://` or `https://`, ≤2048 chars, no control chars, host must not resolve to private/loopback |
| `storage_save` | Must be a JSON object |
| `diagnostics_append` | Schema-validated via serde, field length limits |
| `toast_show` | Must be JSON object |
| `toast_set_position` | i32 values (safe by type) |

### Error Handling

All commands return `Result<_, CommandError>` where `CommandError` has two message fields:
- `message`: user-safe error message (shown in the frontend)
- `kind` (internal): detailed error for logging (not exposed to frontend)

The `user_safe()` method returns a sanitized message:
- IO errors → "A filesystem error occurred. Check logs for details."
- Crypto errors → "A secure storage error occurred. Check logs for details."
- Permission errors, invalid input, config errors → specific messages

## Windows 11 Compatibility

### Home vs Pro

The app is designed to work identically on Windows 11 Home and Pro. No features require Pro-only capabilities:

| Feature | Home | Pro | Notes |
|---|---|---|---|
| WebView2 runtime | ✓ | ✓ | Bundled with Windows 11, auto-installed if missing |
| System keyring | ✓ | ✓ | DPAPI is built into Windows — credential storage works on both |
| Auto-start (registry) | ✓ | ✓ | Uses HKEY_CURRENT_USER, no elevation needed |
| NSIS per-user install | ✓ | ✓ | No admin required |
| Toast notifications | ✓ | ✓ | Uses Tauri notification plugin |
| System tray | ✓ | ✓ | Available on both editions |
| UDP networking | ✓ | ✓ | Core OS feature |

### Detection

On startup, the app runs a self-check that:
1. Reads `EditionID` from registry (`HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion`)
2. Reads `CurrentBuild` to detect Windows 11 (build ≥ 22000)
3. Logs the detected edition and build for diagnostics

If pre-Windows 11 is detected, a warning is logged. The app continues in all cases.

### WebView2 Runtime

Tauri requires the WebView2 runtime, which is:
- **Included** with Windows 11 (all builds)
- **Auto-installed** by the NSIS installer if missing (via `WebView2Bootstrapper`)
- **Checked** during app startup via Tauri's internal initialization

If WebView2 is unavailable, the app will fail to launch with an error message directing the user to install it from https://developer.microsoft.com/microsoft-edge/webview2/

## Startup Self-Check

On every launch, `run_self_check()` in `startup.rs` verifies:

1. **App data directory** — exists or is created, reports failure path
2. **Settings file** — reads and validates JSON, logs warnings for corruption
3. **OS version and edition** — detects Windows 11 vs pre-Win11, Home vs Pro

Results are logged via `log` crate and available to the frontend via `run_startup_checks` command (returns `StartupReport`).

## Known Limitations

- **Multiple calls**: Only one incoming call is handled at a time; subsequent calls are ignored (the app never answers or sends responses).
- **No call rejection**: There is no way to reject a call from the toast notification itself.
- **Single SIP account**: Only one SIP account can be configured at a time.
- **No DTMF**: In-call DTMF tone sending is not supported.

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| DPAPI encryption failure (rare) | Very Low | SIP password saved without encryption | Error logged; value left as-is, never double-encrypted |
| Settings file corruption | Low | Lost settings | Backup file (`settings.json.bak`) auto-restored |
| SIP password compromise via credential theft | Low | Credential exposure | DPAPI (current-user, machine-bound) at rest; attacker needs the same Windows session |
| Frontend sends malicious IPC payload | Very Low | Rejected at trust boundary | Every command validates input; oversized/invalid inputs rejected |
| Auto-update MITM | Very Low | Malicious payload | Ed25519 signature verification; pinned public key |
| WebView2 runtime missing | Low | App won't launch | Installer includes bootstrapper; clear error message |
| Panic in SIP task | Low | Connection lost | `catch_unwind` boundary; panic logged, task restarts on next connect |

## Test Instructions

### Rust Tests

```bash
cd src-tauri
cargo test                    # Run all 30 unit tests
cargo fmt --check             # Format check
cargo clippy -- -D warnings   # Lint check
cargo build --release         # Release build verification
```

### Frontend Tests

```bash
npm test                      # 42 vitest tests
npm run lint                  # ESLint
```

### CI Checks (GitHub Actions)

`ci.yml` runs on pull requests and `feature/**`/`fix/**` branches:
- `tsc --noEmit`, ESLint, Vitest, `vite build`, `npm audit`
- `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`, `cargo audit`

`codeql.yml` runs GitHub CodeQL static analysis. `release.yml` builds and signs the NSIS installer on release tags. `version-bump.yml` automates `chore: bump` PRs.

## Release Hardening Checklist

Before tagging a release:

- [ ] `cargo fmt --check` passes
- [ ] `cargo clippy -- -D warnings` passes
- [ ] `cargo test` passes (all 30 tests)
- [ ] `npm test` passes (all 42 frontend tests)
- [ ] `npm run lint` passes
- [ ] `cargo audit` has no vulnerabilities
- [ ] `npm audit` has no vulnerabilities
- [ ] `npm run build` succeeds
- [ ] `cargo tauri build` succeeds on CI
- [ ] CSP reviewed for any new external resources
- [ ] Capabilities reviewed for any new commands/plugins
- [ ] IPC input validation exists for any new commands
- [ ] Signing keys are accessible in CI secrets
- [ ] `update.json` is generated with correct version
- [ ] `latest-tauri` tag is updated after release
- [ ] Windows 11 Home tested (or CI-validated)

## Security Review Checklist

- [ ] No `unwrap()` or `expect()` in production paths (exceptions documented)
- [ ] All IPC commands return `Result<_, CommandError>` (not `String`)
- [ ] User-safe error messages don't leak internal paths/state
- [ ] Frontend treated as untrusted — no `#[tauri::command]` without input validation
- [ ] No shell execution or filesystem access exposed to frontend
- [ ] SIP passwords encrypted at rest (DPAPI, `dpapi:` prefix in settings.json)
- [ ] CSP restricts script sources to `'self' 'wasm-unsafe-eval'` for the main window
- [ ] Capabilities use least-privilege (no `shell:default`, no `fs:*`, no `dialog:*`)
- [ ] URL open restricted to `https:` and `http:` only
- [ ] Storage data is size-limited and schema-validated
- [ ] Panic boundary on SIP connection task

## License

MIT
