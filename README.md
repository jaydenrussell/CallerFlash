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
- Storage data is size-limited (5MB max) and must be a JSON object
- URLs for `shell_open_external` are restricted to `http://` and `https://` only, max 2048 chars

### Module Layout

```
src-tauri/src/
├── main.rs          # Entry point, windows_subsystem attribute
├── lib.rs           # App setup, command registration, window management
├── error.rs         # Structured error types (CommandError, ErrorKind, StartupReport)
├── startup.rs       # Self-check routine (directories, keyring, Win11 detection)
├── storage.rs       # AES-256-GCM encrypted settings, keyring-backed key storage
├── diagnostics.rs   # Rolling log file, bounded at 10K lines/10MB
├── sip.rs           # UDP SIP client, MD5 digest auth, INVITE parsing
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
- `clipboard:*` — clipboard is read-only via `tauri-bridge.ts`

### Content Security Policy

The CSP in `tauri.conf.json` restricts:
- `script-src 'self'` — no inline scripts or eval
- `style-src 'self' 'unsafe-inline'` — required for Tailwind/React inline styles
- `connect-src 'self' ws: wss:` — IPC and WebSocket connections
- `img-src 'self' data:` — images from bundle or data URIs
- `form-action 'none'`, `object-src 'none'`, `frame-ancestors 'none'`

The toast window (`toast.html`) has a separate, permissive CSP that allows its inline script (`'unsafe-inline'`). This is necessary because the toast script is embedded (no build step) and runs in an isolated webview with no user input surface.

### Credential Storage

SIP passwords are encrypted at rest using AES-256-GCM:
- Encryption key is stored in the Windows Credential Manager via the `keyring` crate
- Key is generated once on first use (OS-level RNG)
- Settings file uses a versioned envelope format (`_version: 3`, `_encrypted: true`)
- Decryption failures produce user-safe messages ("A secure storage error occurred")
- Fallback: if keyring is unavailable, the app continues with in-memory-only operation

### Input Validation

Every IPC command validates its inputs:

| Command | Validation |
|---|---|
| `sip_connect` | Username required (≤128), server required (≤256), port (1–65535), protocol (UDP/TCP/TLS), expiry (30–86400) |
| `notify_show` | Title required (≤256), body (≤1024) |
| `shell_open_external` | Must start with `http://` or `https://`, ≤2048 chars |
| `storage_save` | Must be JSON object, ≤5MB serialized |
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
| System keyring | ✓ | ✓ | Windows Credential Manager available on both |
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
3. **System keyring** — checks accessibility, reports degraded/fallback state
4. **OS version and edition** — detects Windows 11 vs pre-Win11, Home vs Pro

Results are logged via `log` crate and available to the frontend via `run_startup_checks` command (returns `StartupReport`).

## Known Limitations

- **TCP/TLS SIP**: TCP and TLS transport are not yet implemented. UDP is used for all connections.
- **Multiple calls**: Only one incoming call is handled at a time. The SIP `486 Busy Here` response is sent for subsequent calls.
- **No call rejection**: There is no way to reject a call from the toast notification itself.
- **Single SIP account**: Only one SIP account can be configured at a time.
- **No DTMF**: In-call DTMF tone sending is not supported.
- **Registration on port 5060**: The app binds to UDP port 5060, which may conflict with other SIP software. A configurable bind port is planned.

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Keyring service unavailable (headless/CI) | Low | Cannot store encryption key | Falls back to in-memory storage; warning logged |
| Settings file corruption | Low | Lost settings, re-encrypts with new key | Backup file exists; old format still readable |
| SIP password compromise via keyring theft | Low | Credential exposure | AES-256-GCM at rest; attacker needs both file + keyring access |
| UDP port 5060 conflict | Medium | Registration fails | Error emitted to frontend; configurable port planned |
| Frontend sends malicious IPC payload | Very Low | Rejected at trust boundary | Every command validates input; oversized/invalid inputs rejected |
| Auto-update MITM | Very Low | Malicious payload | Ed25519 signature verification; pinned public key |
| WebView2 runtime missing | Low | App won't launch | Installer includes bootstrapper; clear error message |
| Panic in SIP task | Low | Connection lost | `catch_unwind` boundary; panic logged, task restarts on next connect |

## Test Instructions

### Rust Tests

```bash
cd src-tauri
cargo test                    # Run all 25 unit tests
cargo fmt --check             # Format check
cargo clippy -- -D warnings   # Lint check
cargo build --release         # Release build verification
```

### Frontend Tests

```bash
npm test                      # 21 vitest tests
npm run lint                  # ESLint
```

### CI Checks (GitHub Actions)

Both `ci.yml` and `tauri.yml` run:
- `cargo fmt --check`
- `cargo clippy -- -D warnings`
- `cargo test`
- `cargo audit`
- `npm test`
- `npm audit`
- `tsc --noEmit`
- ESLint + Prettier

## Release Hardening Checklist

Before tagging a release:

- [ ] `cargo fmt --check` passes
- [ ] `cargo clippy -- -D warnings` passes
- [ ] `cargo test` passes (all 25 tests)
- [ ] `npm test` passes (all 21 frontend tests)
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
- [ ] SIP passwords encrypted at rest (AES-256-GCM + keyring)
- [ ] CSP restricts script sources to `'self'` for main window
- [ ] Capabilities use least-privilege (no `shell:default`, no `fs:*`, no `dialog:*`)
- [ ] URL open restricted to `https:` and `http:` only
- [ ] Storage data is size-limited and schema-validated
- [ ] Panic boundary on SIP connection task

## License

MIT
