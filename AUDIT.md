# CallerFlash — Production-Readiness Audit

**Audited commit:** `9120ab6` (`main`, post `v2.1.0` stable)
**Audit date:** 2026-08-14
**Scope:** Tauri 2 (Rust backend) + React/TypeScript (Vite) frontend, GitHub Actions CI/CD, packaging, update channel, threat model.
**Method:** Full source review (Rust + TS), config/capabilities review, workflow review, repo settings inspection (`gh api`), live `npm audit` / `cargo audit`, CodeQL alert review, fresh local verification (`tsc`, ESLint, Vitest, Vite build, `cargo fmt/clippy/test`). No live pentest; SIP parser fuzzing recommended (see roadmap).

> This document **replaces** the previous audit (2026-08-04, commit `2c479e9`, score 72/100). It tracks every prior finding (F1–F16) to its current status and adds new observations.

---

## Executive summary

CallerFlash is **production-ready as a Windows desktop application**, with two meaningful caveats: `main` still has no branch protection, and the installer is not Authenticode-signed.

Since the last audit the application was fully rewritten onto Tauri 2 (Rust + rsipstack; the Electron/PJSIP stack is gone), the release pipeline was rebuilt (SHA-pinned actions, `release`-environment approval gate, build-provenance attestation, first-party `gh release create`), stable `v2.1.0` was published through that gated pipeline, and the dependency tree is clean (`npm audit`: 0 vulnerabilities; `cargo audit`: exit 0 with 17 documented informational ignores).

Application security posture remains strong: DPAPI at-rest credential encryption, strict IPC input validation with SSRF guards (unit-tested), per-command rate limiting, a single redaction chokepoint, least-privilege capabilities (separate `main`/`toast` capability files), strict CSP, minisign-pinned updater with an HTTPS host allow-list, single-instance enforcement, and close-to-tray lifecycle handling.

**Overall score: 76/100** — GO for production rollout; complete the items in the 7-day list to claim "hardened."

---

## Verification results (this audit)

| Check | Result |
|---|---|
| `tsc --noEmit` | Pass |
| ESLint | Pass (18 pre-existing warnings, 0 errors) |
| Vitest | 58 passed / 5 files |
| Vite build | Pass |
| `cargo fmt --check` | Pass |
| `cargo clippy --all-targets --features migration -- -D warnings` | Pass |
| `cargo test` | 40 passed |
| `npm audit` | 0 vulnerabilities |
| `cargo audit` | Exit 0 (17 documented ignores: Linux-only gtk-rs family, unmaintained `unic-*`, `proc-macro-error`) |
| CodeQL | 0 open alerts (6 fixed, 1 dismissed `actions/missing-workflow-permissions` on the promote job, which legitimately needs `contents: write`) |
| Repo security features | Secret scanning ✓, push protection ✓, dependabot security updates ✓ |

---

## Prior findings — current status

### Resolved since last audit

| ID | Issue | Status |
|---|---|---|
| F2 | Unpinned release actions, broad permissions, non-reproducible build | **Resolved** — all actions SHA-pinned; per-job permissions; PJSIP/choco steps eliminated (pure-cargo `rsipstack` build) |
| F12 | `npm audit` high advisory (undici, dev-only) | **Resolved** — dependency refresh landed; live audit reports 0 vulnerabilities |
| F13 | Auto-bump workflow didn't sync `Cargo.lock` | **Moot** — `version-bump.yml` removed; the release `promote` job writes all four manifests including `Cargo.lock` |
| F14 | Stale governance docs | **Mostly resolved** — `AGENTS.md` rewritten to the real operating model |
| F1 (partial) | Approval-gated signed releases | **Resolved** — `release` environment gates the build/sign job (verified live: build waited for manual approval); `attest-build-provenance` attached; first-party `gh release create`; tag-creation ruleset active |

### Still open

#### HIGH

**F1 (remainder) — No branch protection on `main`.**
`GET /branches/main/protection` → 404. Anyone with write access can push directly to `main` and tag a release. The compensating controls are real (signing key only reachable behind the approved `release` environment; provenance attestation binds artifacts to the workflow run), which downgrades this from Critical to High — but the review-before-merge gate is still missing.
*Fix:* enable branch protection requiring the `Lint & Build Check` and `Rust Checks` checks, 1 approving review, enforce for admins, block force pushes.

**F3 — Installer is not Authenticode-signed.**
`tauri.conf.json` has no `signCommand`; the shipped `.exe` triggers SmartScreen "unknown publisher". Updater integrity is fine (minisign), but manual downloads are unverifiable to Windows and enterprises can't deploy via MDM.
*Fix:* add `bundle.windows.signCommand` invoking `signtool` with an EV/OV cert (`/tr` timestamp server), keep `TAURI_SIGNING_*` for updater signatures.

**F4 — CSP defense-in-depth gaps.**
`style-src … 'unsafe-inline'` (React inline styles), `script-src … 'wasm-unsafe-eval'` (no wasm ships), and `connect-src` GitHub hosts exist solely for renderer-side beta-endpoint resolution. No CSP violation reporting.
*Fix:* move beta-endpoint resolution into `cmd_check_update` (Rust already validates endpoints against a host allow-list), then drop `'wasm-unsafe-eval'` and the GitHub `connect-src` entries; add a CSP violation handler routed to diagnostics.

**F5 — Security documentation describes a different app.**
`SECURITY.md` still documents AES-256-GCM/keyring credential storage and openssl Ed25519 detached signatures. Reality: DPAPI at rest (`secure.rs`/`storage.rs`) and minisign updater signatures via `tauri-plugin-updater`. `cmd_verify_update` + `VERIFY_PUBLIC_KEY_B64` (`update.rs:30-58`) are dead code with no frontend caller.
*Fix:* rewrite `SECURITY.md` around DPAPI + minisign (document key rotation/recovery); delete `cmd_verify_update`, its key constant, the `pub use` in `lib.rs`, and the registration entry.

#### MEDIUM

**F6 — Raw error tails reach the renderer.** `sip.rs:180` falls back to `format!("SIP error: {}", first 128 chars)` for unmapped errors, leaking host/IP/OS detail to UI and diagnostics. *Fix:* fully generic fallback; keep detail in `log::error!`.

**F8 — No coverage gate.** 58 TS + 40 Rust unit tests pass, but no threshold and the bridge layer (`tauri-bridge.ts` sanitizers, endpoint resolution, `SecureStorage` queue) has thin direct coverage. *Fix:* `vitest --coverage` + `cargo llvm-cov` floors in CI.

**F9 — Panic hook writes raw payload.** `crash.rs` persists the raw panic message plus full process args to `%APPDATA%\CallerFlash\crashes\` **and** `%TEMP%`, unredacted. *Fix:* redact before writing; drop the `%TEMP%` copy.

**F10 — Rate-limiter mutex poisoning.** `ratelimit.rs:24` uses `lock().unwrap()`; a panicking holder turns spam-containment into crash propagation. *Fix:* `lock().unwrap_or_else(|e| e.into_inner())`.

**F11 — No integrity check on settings.json.** Atomic writes + backup + JSON validation exist; non-secret fields are locally tamperable by the same OS user (who already owns that boundary). *Accept as documented risk* or add HMAC keyed no weaker than DPAPI.

#### LOW

**F7 — Legacy migration key derivation is not secret** (`migrate.rs` hostname/CPU-derived AES key for Electron-era `enc:`/`fb:` blobs). One-time migration path only; document, delete legacy config after success.

**F15 — Diagnostics persist server/usernames** (never passwords). Add a clear-diagnostics action that deletes the on-disk file; disclose contents in UI.

**F16 — Mutable `releases/latest` update pointer.** Integrity holds via pinned minisign key; harden later with immutable storage + documented key rotation.

### New observations (this audit)

| ID | Severity | Observation |
|---|---|---|
| N1 | Low | `tauri_plugin_log` runs at **Debug** level in production builds (`lib.rs:399`). Verbose logs raise leak surface and disk noise. Gate to `Info` for release profiles. |
| N2 | Info | Manifest versions in git (`package.json`/`tauri.conf.json` = `1.9.6-beta`) are stale between releases; the `promote` job rewrites them at build time, so shipped artifacts are correct. Cosmetic only. |
| N3 | Info | Production `unwrap()` scan: only three non-test hits — `ratelimit.rs:24` (F10), `tray.rs:66` embedded-icon `expect` (safe: build-time constant), `builder.run(...)` in `run()` (intentional fatal path). Clean overall. |
| N4 | Info | `cmd_check_update` endpoint allow-list (`github.com`/`api.github.com`/`objects.githubusercontent.com`, HTTPS-only) is a solid renderer-compromise containment — keep this pattern when moving beta resolution into Rust (F4). |

---

## Threat model (current)

**Assets:** SIP credentials, caller-ID records, registration session, app config, update-channel trust, minisign signing key.

| Attack path | Mitigation | Gap |
|---|---|---|
| Remote XSS in WebView | Strict CSP, `withGlobalTauri:false`, no remote content, sanitized caller-ID | `'unsafe-inline'` styles, no CSP reporting (F4) |
| Crafted INVITE from provider | Sanitize at parse exit; caller-ID-only (never answers); digest auth | No parser fuzzing |
| GitHub account compromise | Signing key behind approved `release` environment; provenance attestation; tag ruleset | No branch protection on `main` (F1) |
| Local disk theft of settings.json | DPAPI (user-bound); password never in localStorage/logs | No HMAC on non-secret fields (F11, accepted-risk candidate) |
| Malicious update endpoint | HTTPS + host allow-list + pinned minisign pubkey | Mutable pointer (F16) |
| Compromised renderer spams IPC | Per-command rate limits + validation + 64KB toast cap | Mutex poisoning edge (F10) |
| Tampered installer (manual download) | SHA256SUMS published per release | No Authenticode (F3) |

---

## Roadmap

### 7 days — hardening gate
1. **F1** Branch protection on `main` (required checks, 1 review, enforce admins, no force pushes).
2. **F5** Rewrite `SECURITY.md` (DPAPI + minisign reality); delete `cmd_verify_update` dead code + unused secret.
3. **F10** Rate-limiter poisoning fix (one-liner).
4. **N1** Log level `Info` for release builds.

### 30 days
5. **F3** Authenticode signing via `signCommand`.
6. **F4** Move beta-endpoint resolution to Rust; tighten CSP; add violation reporting.
7. **F6** Generic SIP error fallback.
8. **F9** Redact panic payloads; drop `%TEMP%` copy.
9. **F8** Coverage gates (TS + Rust) incl. bridge-layer tests.

### 90 days — enterprise readiness
10. **F16** Immutable update storage; documented minisign rotation/recovery.
11. SBOM (SPDX) attached to releases.
12. **F7** Post-migration legacy-config cleanup.
13. External pentest + SIP parser fuzzing.
14. **F15** Diagnostics clear action + disclosure; incident runbook.

---

## Release-gate verdict

**GO.**

- Stable `v2.1.0` was produced entirely through the gated, attested, signature-verified pipeline; all quality gates pass fresh; no open CodeQL alerts; dependency audits clean.
- Conditions to claim "hardened": the four 7-day items (branch protection, truthful security docs + dead-code removal, rate-limiter fix, release log level).
- Known accepted gaps for current rollout: SmartScreen warning (unsigned installer), mutable update pointer, no coverage gate, no external pentest.

---
*Findings are advisory. Re-run after each release window.*
