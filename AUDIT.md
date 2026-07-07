# CallerFlash — Production-Grade Audit

Audit against the production-grade checklist. Findings grouped by severity across Rust backend, TypeScript frontend, and config/CI/CD.

---

## CRITICAL (fix immediately)

### C1. SIP password stored in plaintext under Tauri
**Severity:** Critical · **File:** `src/tauri-bridge.ts`, `src/store/useAppStore.ts`

The `CallerFlashBridge` interface specifies `safeStorage`, but the Tauri bridge omits it entirely. The store checks `window.callerflash?.safeStorage?.encrypt` before persisting — since it's `undefined`, passwords fall through to plaintext in localStorage.

**Fix:** Implement `safeStorage` in the Tauri bridge backed by the Rust `storage_save`/`storage_load` commands (AES-256-GCM + keyring). Remove the plaintext fallback path.

---

### C2. UDP socket binds `0.0.0.0:5060` — all interfaces, standard SIP port
**Severity:** Critical · **File:** `src-tauri/src/sip.rs:271`

`UdpSocket::bind("0.0.0.0:5060")` listens on every network interface on the well-known SIP port. Any local process, VPN peer, or (if firewall allows) LAN machine can send UDP packets to this socket.

**Fix:** Bind to `127.0.0.1:0` (loopback + ephemeral port) and send from that. Or at minimum use `0.0.0.0:0` to let the OS assign a random port. If the SIP RFC requires a consistent source port, document why and add a firewall rule note.

---

### C3. SIP header injection — unsanitized fields in format!()
**Severity:** Critical · **File:** `src-tauri/src/sip.rs:347-386, 442-508, 656-697`

`username`, `server`, `auth_username`, `realm`, and `nonce` are interpolated directly into SIP headers via `format!()` with no character-level sanitization. A value containing `\r\n`, `"`, `;`, or `@` can inject arbitrary SIP headers (e.g., `server: "sip.example.com\r\nInjected: header"`).

**Fix:** Add a `sanitize_sip_token()` function that rejects or strips `\r`, `\n`, `"`, `(`, `)`, `<`, `>`, `@`, `;`, `\`, `,`, `?`, and space characters from all SIP header values. Apply before every `format!()` that builds a SIP message.

---

### C4. CSV injection in CallHistory export
**Severity:** Critical · **File:** `src/components/CallHistory.tsx:37-41`

Caller number and name are interpolated into CSV cells with no escaping. A caller name containing `"`, `,`, `=`, `+`, `-`, or `@` creates a formula injection payload that executes when opened in Excel/Sheets.

**Fix:** Escape CSV fields: wrap all values in double quotes and escape embedded quotes as `""`. Or better, don't include caller name from untrusted SIP data. Apply to caller number too even though it's pre-sanitized (defense in depth).

---

### C5. Unsanitized caller name stored from SIP INVITE
**Severity:** Critical · **File:** `src/App.tsx:196-209`

`callerData.callerNumber` goes through `sanitizeCallerNumberForClipboard()` but `callerData.callerName` is stored raw. This raw value flows into: call history records (displayed in UI), notification body text, CSV export, and persisted storage.

**Fix:** Add `sanitizeCallerName()` — strip control characters (0x00–0x1F except \t), truncate to 128 chars, reject or strip surrogates and invalid UTF-8 byte sequences. Apply before storing.

---

### C6. Dead code with document.write() XSS sink
**Severity:** Critical · **File:** `src/utils/simulateIncomingCall.ts:88-152`

The `showSeparateToast` function builds an HTML document via string concatenation and writes it with `document.write()`. All caller data fields (number, name, font family, colors) are interpolated unsanitized. The function is dead code today but is one `import` away from exploitation.

**Fix:** Either (a) delete the entire `showSeparateToast` function (preferred — Tauri doesn't use it), or (b) if it must stay, replace `document.write()` with a safe DOM construction approach using `document.createElement()`, `textContent`, and `setAttribute()`.

---

### C7. `withGlobalTauri: true` leaks API surface
**Severity:** Critical · **File:** `src-tauri/tauri.conf.json:32`

This makes `window.__TAURI__` available to every script in the webview, including any third-party scripts or compromised code. Any XSS grants full access to all Tauri commands.

**Fix:** Set `"withGlobalTauri": false`. Import specific APIs via ES modules in the bundled code only:
```ts
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
```

---

### C8. CSP `'unsafe-inline'` in style-src permits CSS injection
**Severity:** Critical · **File:** `src-tauri/tauri.conf.json:30`

`style-src 'self' https://fonts.googleapis.com 'unsafe-inline'` — inline styles can be used for data exfiltration via CSS attribute selectors and `background: url(...)` callbacks.

**Fix:** Remove `'unsafe-inline'` from `style-src`. Use nonces or hashes for any required inline styles. Move all styles to external CSS.

---

### C9. CI deletes lockfile and uses `npm install` instead of `npm ci`
**Severity:** Critical · **File:** `.github/workflows/ci.yml:30-31`

```yaml
rm -rf node_modules package-lock.json
npm install
```

This defeats reproducible builds. `npm install` resolves the latest semver-compatible versions, which may differ from what was locally tested and committed.

**Fix:** Replace with `npm ci`. Enable caching.

---

### C10. CI never runs tests
**Severity:** Critical · **File:** `.github/workflows/ci.yml`

The `lint-build` job runs TypeScript check, ESLint, Prettier, npm audit, and build — but never `npm test`. The test suite exists but is never executed in CI.

**Fix:** Add:
```yaml
- name: Run tests
  run: npm test
```

---

## HIGH (fix soon)

### H1. SIP password field has zero validation
**File:** `src-tauri/src/sip.rs:31-81` — `validate()`

The `password` field has no length limit, no character restrictions. A 10MB password would be accepted and held in memory.

**Fix:** Add `max_len(512)` to password validation. Reject non-printable characters.

### H2. Toast and main window share the same capabilities
**File:** `src-tauri/capabilities/default.json:5`

```json
"windows": ["main", "toast"]
```

The toast webview has access to `shell:allow-open`, `updater:allow-check`, `updater:allow-install`, `core:window:allow-set-position`, etc. — the same set as the main window.

**Fix:** Create a separate `toast.json` capability file with only `core:event:allow-listen` and `core:event:allow-emit`. Remove `"toast"` from `default.json`.

### H3. `disconnect` returns `{ success: true }` on failure
**File:** `src/tauri-bridge.ts:203-204`

```typescript
return (await invoke('sip_disconnect').catch(() => ({ success: true }))) as { success: boolean };
```

If the IPC call fails, the frontend believes disconnection succeeded. This is a lie.

**Fix:** Remove the `.catch()` override. Let failures propagate. Handle at the call site in `SipSettings.tsx`.

### H4. Silent catches hide critical errors
**Files:**
- `src/App.tsx:99` — diagnostics load fails silently
- `src/App.tsx:289` — update check fails silently
- `src/components/CallHistory.tsx:23` — clipboard write fails silently
- `src/components/AutoUpdate.tsx:376` — download state fails silently

**Fix:** Log all caught errors to the diagnostics system. Show user-visible feedback for critical operations (update check, clipboard copy).

### H5. Notification body contains unsanitized caller name
**File:** `src/App.tsx:246`

`body: \`${safeNumber}${safeName ? \` - ${safeName}\` : ''}\`` — `safeName` is raw SIP data sent to the native notification API.

**Fix:** Sanitize caller name before passing to notification (same sanitizer as C5).

### H6. CSP allows unrestricted WebSocket + localhost HTTP
**File:** `src-tauri/tauri.conf.json:30`

`connect-src` includes `ws:` and `wss:` with no host restriction, and `http://localhost:*` allowing any local port. An XSS attacker could exfiltrate data via WebSocket to any server or SSRF to local services.

**Fix:** Pin WebSocket origins to the configured SIP server(s). Remove `http://localhost:*` unless explicitly needed and pin to specific ports.

### H7. `shell:allow-open` is overly broad
**File:** `src-tauri/capabilities/default.json`

Allows opening any URL/protocol handler from the frontend. XSS + this = ability to open `mailto:`, `tel:`, `file:///`, arbitrary `https://`.

**Fix:** Gate all URL opening through a Rust command that validates URLs server-side before calling `open::that`.

### H8. `cargo audit` has `continue-on-error: true`
**File:** `.github/workflows/tauri.yml:109-114`

Vulnerability findings are silently ignored. The workflow succeeds regardless.

**Fix:** Remove `continue-on-error: true`. Use `.cargo/audit.toml` allowlist for known-accepted vulnerabilities instead of blanket bypass.

### H9. `npm audit` only checks `--audit-level=high`
**File:** `.github/workflows/tauri.yml:95`, `ci.yml:43`

Moderate and low advisories are never detected.

**Fix:** Remove `--audit-level=high` or use `--audit-level=moderate`.

### H10. No SAST/CodeQL analysis
**Files:** `.github/workflows/tauri.yml`, `ci.yml`

No static analysis security testing is configured. GitHub provides free CodeQL.

**Fix:** Add CodeQL analysis workflow for JavaScript/TypeScript.

### H11. Error details leaked via SipStatus events
**File:** `src-tauri/src/sip.rs:279, 313-316, 397-399, 517-520, 583-587, 627, 632-635`

Detailed OS errors (`"Failed to send REGISTER: Connection refused (os error 61)"`) are sent to the frontend. This leaks network topology and system internals.

**Fix:** Map OS errors to generic user-safe messages before emitting events. Keep full details in Rust-side logs only.

### H12. `.ok()` silences ~20 event emit failures
**File:** `src-tauri/src/sip.rs` — ~20 occurrences

`handle.emit(...).ok()` silently discards all event system failures.

**Fix:** Log failures to the diagnostics system. Don't let them crash the SIP task, but don't hide them either.

### H13. Unsafe `as` type assertions in bridge
**File:** `src/tauri-bridge.ts` — 10+ occurrences

IPC return values are cast with `as` without shape validation. Malformed backend responses silently produce incorrect types at runtime.

**Fix:** Add runtime schema validation for critical IPC responses (sip status, update info, window position). Use zod or manual type guards.

---

## MEDIUM (plan to fix)

### M1. No rate limiting on any Tauri commands
**Files:** All command handlers

Compromised frontend can spam `diagnostics_append`, `storage_save`, `sip_connect`/`sip_disconnect`, `notify_show`, etc.

**Fix:** Add per-command rate limiting (e.g., max 10 calls/second for non-critical commands, 1 call/second for SIP connect/disconnect).

### M2. Tray icon fallback creates 0×0 image
**File:** `src-tauri/src/tray.rs:33-34`

`Image::new(&[], 0, 0)` — if the icon file fails to load, an empty image is used. Could cause undefined behavior in the OS tray subsystem.

**Fix:** Return an error and log if the icon can't be loaded. Don't silently fall back to empty.

### M3. No CSP violation reporting
**File:** `src-tauri/tauri.conf.json:30`

CSP violations fail silently. No way to detect injection attempts or policy misconfigurations.

**Fix:** Add `report-uri` or `report-to` directive. For a desktop app, route reports to the diagnostics log.

### M4. No Windows Authenticode code signing
**File:** `.github/workflows/tauri.yml`

The NSIS installer is not Authenticode-signed. Triggers SmartScreen, can't be deployed via enterprise MDM.

**Fix:** Add code signing step with a Windows certificate (Azure Key Vault or signtool).

### M5. Toast JSON payload has no schema/size validation
**File:** `src-tauri/src/lib.rs:95-156`

`toast_show` accepts arbitrary JSON with no size or schema validation. A very large payload could impact performance.

**Fix:** Validate the JSON payload size (< 64KB) and required field types before processing.

### M6. `parseInt` without radix
**File:** `src/components/SipSettings.tsx:345,372`

`parseInt(e.target.value)` — modern engines default to base-10 for non-`0x` strings, but best practice is `parseInt(e.target.value, 10)`.

**Fix:** Add radix parameter.

### M7. Most npm deps use `^` ranges
**File:** `package.json`

Mitigated by lockfile, but CI deletes lockfile (see C9). Fix C9 first.

### M8. Most Rust deps not pinned to exact versions
**File:** `src-tauri/Cargo.toml`

Mitigated by `Cargo.lock`. Consider pinning security-critical crates (crypto, auth) to exact versions.

### M9. Minimal test coverage
**File:** `src/security/secretRedactor.test.ts` (only test file)

21 tests covering one utility. No Rust tests, no component tests, no integration tests.

**Fix:** Add tests for: state management, SIP configuration validation, IPC bridge error handling, all Rust command handlers.

### M10. `as any` cast on SIP protocol value
**File:** `src/components/SipSettings.tsx:353`

`protocol: e.target.value as any` bypasses the `'UDP' | 'TCP' | 'TLS'` type constraint.

**Fix:** Use a proper type guard.

### M11. Non-null assertion on `getElementById("root")`
**File:** `src/main.tsx:24`

`document.getElementById("root")!` — will produce a confusing runtime error if the element is missing.

**Fix:** Add a null check with a meaningful error message.

---

## LOW (nice to have)

### L1. ESLint `no-explicit-any` and `no-unused-vars` set to `"warn"` instead of `"error"`
**File:** `eslint.config.js:12-13`

Warnings don't fail CI. Accumulate over time.

**Fix:** Set to `"error"` once the codebase is clean.

### L2. No security-focused ESLint plugins
**File:** `eslint.config.js`

No `eslint-plugin-security`, `eslint-plugin-no-unsanitized`, `@typescript-eslint/no-floating-promises`.

**Fix:** Add `eslint-plugin-security` and enable `no-floating-promises`.

### L3. `ignoreDeprecations: "6.0"` suppresses TS deprecations
**File:** `tsconfig.json:9`

**Fix:** Remove and address the underlying warnings.

### L4. `shouldAutoCheck` uses `useState` instead of `useRef`
**File:** `src/components/AutoUpdate.tsx:383-396`

`const hasCheckedRef = useState({ current: false })[0]` — mutates state value directly, anti-pattern.

**Fix:** Use `useRef(false)`.

### L5. `beforeDevCommand` is empty
**File:** `src-tauri/tauri.conf.json:10`

**Fix:** Set to `"npm run dev"` for consistent dev workflow.

### L6. Build filenames have no content hashes
**File:** `vite.config.ts:32-36`

**Fix:** Document as a Tauri constraint.

---

## Summary

| Severity | Count | Key themes |
|----------|-------|------------|
| **Critical** | 10 | Plaintext passwords, 0.0.0.0 bind, SIP injection, CSV injection, unsanitized caller name, dead code XSS, global `__TAURI__`, unsafe-inline CSP, CI supply chain, missing test run |
| **High** | 13 | Missing validation, shared capabilities, lying disconnect, silent catches, notification injection, CSP gaps, broad shell permission, cargo audit bypass, npm audit level, no SAST, error leaks, `.ok()` silencing, unsafe type casts |
| **Medium** | 11 | Rate limiting, tray icon, CSP reporting, code signing, payload validation, radix, dep pinning, test coverage, type safety, null assertions |
| **Low** | 6 | Lint severity, ESLint plugins, TS deprecations, useState misuse, dev command, build hashes |
| **Total** | **40** | |
