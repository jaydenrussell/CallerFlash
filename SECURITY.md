# Security Policy

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security bugs.** Email
`security@callerflash.app` (PGP key on request) or use GitHub's
[private vulnerability reporting](../../security/advisories/new).

We aim to acknowledge within 48 hours and provide a fix or mitigation
within 14 days for high-severity issues.

---

## Threat Model

CallerFlash is a Tauri 2.0 Windows desktop application that maintains a
persistent SIP registration with a third-party VoIP provider. Its threat
surface is:

| Asset | Threat | Mitigation |
|-------|--------|-----------|
| Update channel | Supply-chain compromise via CDN or GitHub account takeover | minisign signature verified by `tauri-plugin-updater` against a pinned public key; backend-only endpoint resolution with an HTTPS host allow-list |
| SIP credentials | Theft from disk or memory | DPAPI (user-bound) encryption at rest, never written to logs, redacted at the single log chokepoint |
| Caller ID data | Display-name injection (CRLF, control bytes) | Sanitization at parser exit (`sanitize_caller_id`) |
| Clipboard contents | Cross-app injection via auto-copy | Strict digit-only sanitizer |
| WebView renderer | XSS / RCE | Strict CSP (`script-src 'self'`, no external `connect-src`), `withGlobalTauri: false`, no `shell:allow-spawn`, validation at the IPC trust boundary |
| External links | RCE via crafted URIs / SSRF to internal hosts | Scheme allow-list (https/http), length + control-char checks, private/loopback host rejection (unit-tested) |
| Registration spam | Attacker-controlled or replayed IPC traffic | Per-command rate limiting on notification and toast commands |

---

## Update Security

Updates are delivered through `tauri-plugin-updater`. Every release ships
a `update.json` manifest and a **minisign detached signature**; the updater
refuses to install anything that does not verify against the public key
pinned in `src-tauri/tauri.conf.json`.

### Endpoint integrity

The renderer never supplies an update URL. `cmd_check_update` resolves the
endpoint entirely in the Rust backend from the requested channel:

- **stable** → `https://github.com/jaydenrussell/CallerFlash/releases/latest/download/update.json`
- **beta** → the latest `-beta`/`-tauri` prerelease tag's `update.json`,
  resolved by listing recent releases from the GitHub API (backend-side)

The resolved URL is then validated against a hard-coded HTTPS host
allow-list (`github.com`, `api.github.com`,
`objects.githubusercontent.com`) before any network request is made.
Even if every check failed, a tampered payload cannot install: the
minisign signature over the installer must verify against the pinned key.

### Release pipeline

- The build/sign job runs in a protected `release` GitHub environment and
  waits for maintainer approval on stable tags.
- Signing material (`TAURI_SIGNING_PRIVATE_KEY`) exists only as a GitHub
  Actions secret — never in the repo.
- Every stable release attaches a build-provenance attestation
  (`attest-build-provenance`), binding artifacts to the exact workflow run.
- `SHA256SUMS` is published with each release for manual verification.

---

## Cryptographic Storage

SIP credentials are encrypted at rest using **Windows DPAPI**
(`CryptProtectData`, via the `windows-sys` crate):

- Ciphertext is stored in `%APPDATA%/CallerFlash/settings.json` as
  `dpapi:<base64>` values.
- DPAPI scopes decryption to the Windows user account that encrypted it —
  the key never exists in application code or config, and nothing to
  rotate or leak.
- Settings writes are atomic (temp file + rename) with a `.bak` backup of
  the previous good file.
- Decryption failures produce user-safe messages and never echo raw
  error content.

Legacy Electron-era settings (`enc:`/`fb:` formats) are migrated once on
first run of the Tauri build and re-encrypted under DPAPI.

---

## WebView Hardening

The Tauri webview is configured with least privilege:

- `withGlobalTauri: false` — no `window.__TAURI__` exposed to scripts.
- Strict CSP (identical policy in `index.html` and `tauri.conf.json`):
  ```
  default-src 'self'
  script-src 'self'
  style-src 'self' https://fonts.googleapis.com 'unsafe-inline'
  font-src  'self' https://fonts.gstatic.com data:
  img-src   'self' data:
  connect-src 'self'
  form-action 'none'
  object-src 'none'
  base-uri 'self'
  frame-ancestors 'none'
  ```
  `'unsafe-inline'` styles remain only because React applies inline style
  attributes; there is no `unsafe-eval`, no wasm, and **no external
  `connect-src`** — update checks and release history are fetched by the
  Rust backend, not the renderer.
- Capabilities are split per window and least-privilege:
  - `capabilities/default.json` (main window): core defaults plus
    `shell:allow-open` restricted to `https://*` URLs.
  - `capabilities/toast.json` (toast window): event listen/emit and basic
    window controls only.

---

## IPC Trust Boundary

```
[Frontend (React)] --IPC (invoke)--> [Tauri Backend (Rust)]
       ^                                    |
       |  Events (listen/emit)              |
       +------------------------------------+
```

The **trust boundary** sits at the IPC layer. The frontend is treated as
untrusted input:

- Every IPC command validates and sanitizes parameters on the Rust side.
- Notification titles/bodies have length limits (256/1024 bytes); toast
  payloads are capped at 64 KB.
- SIP config is validated (username, server required; port, protocol,
  expiry range-checked).
- Storage data is size-limited (5 MB max) and must be a JSON object.
- `shell_open_external` enforces https/http schemes, a 2048-char limit,
  control-character rejection, and rejects loopback/private/obfuscated
  numeric hosts (SSRF containment) — covered by unit tests.
- Rate limiters bound notify/toast command rates (general: 10/s,
  SIP-triggered: 2/s) and use poisoning-tolerant locks.
- Crash reports sanitize panic payloads (printable ASCII, bounded length)
  and contain no process arguments; they are written only to
  `%APPDATA%/CallerFlash/crashes/`.

---

## Secret Handling

`src/security/secretRedactor.ts` is the single chokepoint for log
content. It:

* Replaces any value bound to a sensitive key (password, token,
  authorization, etc.) with `***REDACTED***`.
* Strips JWTs, bearer tokens, SIP auth digests, and long hex blobs
  from free-form log messages.
* Sanitizes caller names at the SIP parser exit, stripping any byte
  outside printable ASCII.
* Sanitizes the clipboard payload to digits-only (plus a leading `+`)
  so a malicious caller-name field cannot piggyback into the clipboard.

Unmapped SIP errors surface a generic message to the UI; full detail goes
only to local logs after redaction. The diagnostic export button writes
the **already-redacted** log buffer to disk — there is no path from SIP
password to exported file.

Release builds log at `Info` level; `Debug` verbosity is dev-build only.

---

## Dependency Hygiene

* `cargo audit` runs on every CI build with a documented inline allowlist
  for known-accepted advisories (Linux-only gtk-rs family, unmaintained
  `unic-*` transitive deps) — see `.github/workflows/ci.yml`.
* `npm audit --audit-level=high` gates every CI build.
* CodeQL scans the repo on every push to `main` and weekly.
* Dependabot security updates are enabled; secret scanning and push
  protection are enabled on the repository.
* All JS dependencies are pinned to exact versions in
  `package-lock.json`; Rust dependencies are locked in `Cargo.lock`.

---

## Reporting Compromised Releases

If you discover a release with a tampered binary, a missing signature,
or an unverified checksum, **do not run the binary**. Email
`security@callerflash.app` with the release tag and SHA-256. We will:

1. Yank the release immediately.
2. Invalidate any cached installer URLs.
3. Publish a `security-advisory` GitHub Security Advisory.
4. Publish a corrected release signed with a fresh minisign key (if the
   signing key is suspected of compromise) and ship a signed app update
   pointing users at it.

---

## Acknowledgements

We thank the security researchers who have helped harden CallerFlash.
Past disclosures are listed in the
[Security Advisories](../../security/Advisories) tab.
