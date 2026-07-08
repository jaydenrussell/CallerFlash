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
| Update channel | Supply-chain compromise via CDN or GitHub account takeover | Ed25519 detached sig, SHA-256 checksum, pinned public key via Tauri updater |
| SIP credentials | Theft from disk or memory | AES-256-GCM at rest, keyring-backed key, never written to logs |
| Caller ID data | Display-name injection (CRLF, control bytes) | Sanitization at parser exit (`sanitize_caller_id`) |
| Clipboard contents | Cross-app injection via auto-copy | Strict digit-only sanitizer |
| WebView renderer | XSS / RCE | Strict CSP, `withGlobalTauri: false`, no `shell:allow-spawn`, input validation at IPC trust boundary |
| External links | Accidental RCE via `javascript:` URIs | URL validated server-side (https/http only, max 2048 chars) |
| Registration spam | Attacker-controlled SIP server | Version monotonicity + pinned Ed25519 key |

---

## Update Security

Every release is signed using **two independent layers**. Both must pass
for the update to install.

### 1. SHA-256 Checksum + Ed25519 Detached Signature

The Tauri updater plugin verifies the installer checksum and Ed25519
signature before applying the update.

```
# Generate the keypair (once, offline)
openssl genpkey -algorithm Ed25519 -out release-signing.key
openssl pkey -in release-signing.key -pubout -out release-signing.pub

# Sign a release
shasum -a 256 CallerFlash-Setup-X.Y.Z.exe > SHA256SUMS
openssl pkeyutl -sign -rawin -in SHA256SUMS -inkey release-signing.key \
    -out CallerFlash-Setup-X.Y.Z.exe.sig

# Users verify with:
openssl pkeyutl -verify -rawin -pubin \
    -inkey release-signing.pub \
    -in SHA256SUMS \
    -sigfile CallerFlash-Setup-X.Y.Z.exe.sig
```

### Additional Gates

* **HTTPS only** + **host allow-list** — updater endpoint is pinned to
  `https://releases.callerflash.app/{{target}}/{{current_version}}`.
* **Version monotonicity** — never installs a release older than the
  currently running version. Defeats roll-back attacks.

---

## Cryptographic Storage

SIP credentials are encrypted at rest using **AES-256-GCM**:

- Encryption key is stored in the Windows Credential Manager via the
  `keyring` crate.
- Key is generated once on first use (OS-level RNG).
- Settings file uses a versioned envelope format (`_version: 3`,
  `_encrypted: true`).
- Decryption failures produce user-safe messages.
- Fallback: if keyring is unavailable, the app continues with
  in-memory-only operation.

---

## WebView Hardening

The Tauri webview is configured with least privilege:

- `withGlobalTauri: false` — no `window.__TAURI__` exposed to scripts.
- Strict CSP in `tauri.conf.json`:
  ```
  script-src 'self'
  style-src 'self' 'unsafe-inline'
  connect-src 'self' ws: wss:
  img-src 'self' data:
  form-action 'none'
  object-src 'none'
  frame-ancestors 'none'
  ```
- Capabilities in `src-tauri/capabilities/default.json` request only
  the minimum permissions needed. No `fs:*`, no `shell:default`, no
  `dialog:*`, no `clipboard:*`.
- The toast window (`toast.html`) has a separate, permissive CSP with
  `'unsafe-inline'` for its inline script — isolated webview with no
  user input surface.

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
- `serde_json::Value` parameters are schema-validated with field-level
  length and type checks.
- Notification titles/bodies have length limits (256/1024 bytes).
- SIP config is validated (username, server required; port, protocol,
  expiry range-checked).
- Storage data is size-limited (5MB max) and must be a JSON object.
- URLs for shell open are restricted to `http://` and `https://` only,
  max 2048 chars.

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

The diagnostic export button writes the **already-redacted** log
buffer to disk — there is no path from SIP password to exported file.

---

## Dependency Hygiene

* `cargo audit` is run on every CI build with an allowlist for
  known-accepted advisories (see `.audit.toml`).
* Rust dependencies are pinned to exact versions in `Cargo.lock`.
* `npm audit --omit=dev` is run on every CI build.
* All JS dependencies are pinned to exact versions in
  `package-lock.json`.

---

## Reporting Compromised Releases

If you discover a release with a tampered binary, a missing signature,
or an unverified checksum, **do not run the binary**. Email
`security@callerflash.app` with the release tag and SHA-256. We will:

1. Yank the release immediately.
2. Invalidate any cached installer URLs.
3. Publish a `security-advisory` GitHub Security Advisory.
4. Force-push a corrected release signed with a fresh key (if the
   signing key is suspected of compromise).

---

## Acknowledgements

We thank the security researchers who have helped harden CallerFlash.
Past disclosures are listed in the
[Security Advisories](../../security/Advisories) tab.
