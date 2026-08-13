# CallerFlash — Production-Readiness Audit

**Audited commit:** `2c479e9` (`v1.9.6-beta`, branch `main`)
**Audit date:** 2026-08-04
**Scope:** Tauri 2 (Rust backend) + React/TypeScript (Vite) frontend, GitHub Actions CI/CD, packaging, update channel, threat model, compliance mapping.
**Method:** Full source review (Rust + TS), config/capabilities review, workflow review, repo-level settings inspection (`gh api`), live `npm audit`. No live pentest; SIP parser fuzzing and DAST recommended (see roadmap).

> This document **replaces** the previous AUDIT.md, which described an early Electron-era codebase. Nearly all of its CRITICAL/HIGH findings have since been remediated (see [Resolved since last audit](#resolved-since-last-audit)).

---

## Executive summary

CallerFlash is in **good production shape**. The credential-storage regression that shipped in 1.9.5 (SIP password not restored on restart) was root-caused and fixed (`1e410ec`), the fix was verified end-to-end against real user logs (native-load `passwordLen=19` + auto-connect `REGISTER 200 OK`), diagnostics added during the fix were stripped, and stable `1.9.5`/`1.9.6` plus beta `v1.9.6-beta` are cut.

The application-security posture is strong: DPAPI at-rest encryption, strict input validation at the IPC trust boundary, per-command rate limiting, a single redaction chokepoint for secrets, least-privilege capabilities, a strict CSP, minisign-signed updates, and CodeQL/dependabot/secret-scanning active in CI.

**The dominant remaining risk is pipeline integrity, not application code.** `main` has **no branch protection**, the auto-version-bump workflow has `contents: write` and pushes to `main`, and tagged pushes **auto-publish signed releases with no approval gate**. A GitHub-account/repo compromise would therefore be able to land malicious code and serve it through the signed update channel. This is the one item that must be fixed before claiming "production-grade."

**Overall score: 72/100** — conditional release gate.

---

## Scores (0–100)

| Domain | Score | Notes |
|---|---|---|
| Code quality & maintainability | 80 | Clean lint/typecheck, unit tests for storage/SIP/startup/redaction; no coverage gate, some dead code |
| CI/CD & supply chain | 55 | `npm ci`, SHA-pinned ci.yml, CodeQL, dependabot, secret scanning all present; but no branch protection, unpinned release.yml, no approval gate, no provenance |
| IaC & runtime / packaging | 68 | NSIS per-user install, single-instance, tray, updater artifacts; unsigned installer, no SBOM, fragile PJSIP build step |
| Application security | 84 | DPAPI, IPC validation, rate limiting, redaction, CSP, capabilities; `'unsafe-inline'` style-src, error-tail leak, legacy weak migration key |
| Compliance & governance | 60 | Threat model + security policy exist but are stale/incorrect; no incident runbook, no compliance attestation |
| Release readiness | 65 | Minisign update signing + version monotonicity solid; no Authenticode, mutable GitHub endpoint, no staged rollout |
| **Overall** | **72** | Conditional GO (see verdict) |

---

## Remediation at a glance

| Finding | Severity | Fix | Effort | Window |
|---|---|---|---|---|
| F1 — Branch protection + approval-gated signed releases | Critical | Enable protection on `main`; move signing key to a gated environment; draft-then-promote or require reviewer | M | 7 days |
| F2 — release.yml unpinned actions + non-reproducible build | High | Pin actions by SHA; job-level permissions; pin PJSIP/choco; cache build | M | 7–30 days |
| F3 — Authenticode signing not wired in | High | Add `signCommand` using existing `WIN_CSC_LINK` secrets | M | 30 days |
| F4 — WebView CSP defense-in-depth | High | Tighten CSP; move beta resolution to Rust; add reporting | M | 30 days |
| F5 — Security docs describe a different app | High | Rewrite SECURITY.md; delete dead verify path + unused secret | S | 7 days |
| F6 — Raw error tails to renderer | Medium | Generic fallback message; keep detail in Rust logs | S | 30 days |
| F7 — Legacy migration key not secret | Medium | Document; delete old config post-migration | S | 30 days |
| F8 — No coverage gate; thin IPC tests | Medium | Coverage job + threshold; bridge unit tests | M | 30 days |
| F9 — Panic hook writes raw payload | Medium | Redact panic text; drop %TEMP% copy | S | 30 days |
| F10 — Rate-limiter mutex poisoning | Medium | `unwrap_or_else(into_inner)`; document scope | S | 30 days |
| F11 — No integrity check on settings.json | Medium | Document accepted risk or add HMAC | M | 30 days |
| F12 — `npm audit` gate at high only | Medium | Merge undici PR; consider moderate | S | 7 days |
| F13 — Auto-bump doesn't sync Cargo.lock | Medium | Bump Cargo.lock in workflow | S | 30 days |
| F14 — Stale AGENTS.md / CRITICAL.md | Low | Rewrite to real workflow | S | 7 days |
| F15 — Diagnostics persist host/usernames | Low | Add clear-diagnostics action; document | S | 90 days |
| F16 — Mutable update endpoint | Low | Immutable storage / dedicated endpoint; key rotation | L | 90 days |

---

## Findings — explained by severity

### CRITICAL

A Critical finding is one where a realistic, currently-exploitable path exists to a severe outcome (code execution on users' machines) and no compensating control fully mitigates it.

#### F1 — No branch protection on `main` + zero-approval signed release publishing

**Files:** `.github/workflows/version-bump.yml`, `.github/workflows/release.yml`
**Status:** Open · **Effort:** M

**Explanation.** Three facts combine into one exploit chain:

1. `gh api repos/jaydenrussell/CallerFlash/branches/main/protection` returns **404** — `main` has no branch protection. There is no required PR, no required status check, no signature requirement, no push restriction.
2. `version-bump.yml` runs on every push to `main` with `permissions: contents: write` and pushes a `chore: bump` commit itself. Any actor who can push to `main` can also push a `v*` or `beta*` tag.
3. `release.yml` triggers on any `v*`/`beta*` tag and **auto-publishes** a public release with `draft: false`, no environment, no approval gate, generating the minisign signature and `update.json` that the updater trusts.

Because the update artifacts are signed with `TAURI_SIGNING_PRIVATE_KEY` (a repo secret), an attacker who compromises the GitHub account or a maintainer's PAT can: land malicious code → push a tag → auto-publish a **signed malicious installer** → all users auto-update to it. An attacker with write access can additionally edit `release.yml` itself to dump the signing key — full, silent supply-chain takeover.

**Recommendation (do these together):**
1. Enable branch protection on `main`:
   ```bash
   gh api -X PUT repos/jaydenrussell/CallerFlash/branches/main/protection \
     -f required_status_checks[strict]=true \
     -f required_status_checks[contexts][]=lint-build \
     -f required_status_checks[contexts][]=rust \
     -f required_pull_request_reviews[required_approving_review_count]=1 \
     -f enforce_admins=true \
     -f required_signatures=true \
     -f allow_force_pushes=false \
     -f allow_deletions=false
   ```
   Then restrict direct pushes so only `callerflash-bot` (via a fine-grained, least-privilege PAT scoped to this repo only) can push version-bump commits.
2. Move `TAURI_SIGNING_PRIVATE_KEY` + password into a **GitHub environment** named `release` with a `required_reviewers` rule, and reference it from the release job:
   ```yaml
   release:
     needs: build
     runs-on: ubuntu-latest
     environment: release          # requires manual approval
     permissions:
       contents: write
   ```
3. Publish as draft and promote manually, or keep auto-publish **behind** the approval environment.
4. Add `actions/attest-build-provenance` (pin by SHA) so artifacts are bound to the exact workflow run.
5. **Rotate the minisign signing key** once the new environment is in place (treat the current key as exposed to any past write-capable actor).
6. Prefer `gh release create` over `softprops/action-gh-release` to remove the third-party action:
   ```bash
   gh release create "$GITHUB_REF_NAME" artifacts/** \
     --generate-notes --verify-tag \
     --prerelease  # only when the tag contains -beta
   ```

---

### HIGH

High findings are significant gaps in the pipeline, packaging, or containment that materially weaken the product's security, but are not today directly exploitable from outside the repo.

#### F2 — release.yml: unpinned actions, broad permissions, non-reproducible build

**Files:** `.github/workflows/release.yml`
**Status:** Open · **Effort:** M

**Explanation.** ci.yml correctly pins `actions/checkout` and `actions/setup-node` by SHA, but release.yml uses floating tags (`actions/checkout@v3`, `actions/setup-node@v4`, `softprops/action-gh-release@v1`, `actions/upload-artifact@v4`, `actions/download-artifact@v4`). A floating tag can be silently repointed by the upstream owner, changing what the release build runs. Compounding this: the workflow grants **workflow-level** `contents: write` (the `build` job needs none), `choco install` pulls unpinned package versions, and PJSIP is built from `git clone https://github.com/pjsip/pjproject.git` — **the moving `HEAD` of the upstream repo** — making every release build non-reproducible and exposed to upstream compromise.

**Recommendation:**
1. Pin every action by SHA (reuse the pins already proven in ci.yml, resolve the rest via dependabot `update-types: [pin]` or `gh api repos/<owner>/<repo>/commits`):
   ```yaml
   - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4
   - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
   ```
2. Scope permissions to jobs: `build` → `permissions: contents: read`; only the `release` job gets `contents: write`.
3. Pin the PJSIP source to a released tag/commit:
   ```bash
   git clone --branch <pjsip-release-tag> --depth 1 https://github.com/pjsip/pjproject.git /tmp/pjproject
   ```
   and pin choco versions (`choco install msys2 --version=X.Y`), then cache the PJSIP build output (`actions/cache`) so builds are deterministic and fast.

#### F3 — Windows Authenticode signing configured but not wired into release.yml

**Files:** `src-tauri/tauri.conf.json`, `.github/workflows/release.yml`, repo secrets `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`
**Status:** Open · **Effort:** M

**Explanation.** `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` secrets exist, but the Tauri build step never uses them: `tauri.conf.json` has no `signCommand`, and release.yml sets only the updater-signing env. Consequence: the shipped `.exe` is **not Authenticode-signed** — Windows shows a SmartScreen "unknown publisher" warning, and the installer's only authenticity comes from the minisign signature the updater verifies. Enterprises cannot deploy it via MDM, and a tampered installer downloaded outside the updater is indistinguishable from a legit one.

**Recommendation:** sign the installer during bundling. In `tauri.conf.json`:
```json
"bundle": {
  "windows": {
    "nsis": { "installMode": "currentUser" },
    "signCommand": "signtool sign /fd SHA256 /f \"%WIN_CSC_LINK%\" /p \"%WIN_CSC_KEY_PASSWORD%\" /tr http://timestamp.digicert.com /td SHA256 \"%1\""
  }
}
```
Keep `TAURI_SIGNING_*` for updater signatures — the two layers are independent. Validate on a test release before cutting the next stable.

#### F4 — WebView CSP defense-in-depth gaps

**Files:** `src-tauri/tauri.conf.json:30`, `toast.html:6`
**Status:** Open · **Effort:** M

**Explanation.** The current CSP allows:
- `style-src 'self' https://fonts.googleapis.com 'unsafe-inline'` — inline styles can be abused for data-exfiltration via CSS attribute selectors + `background:url(...)` if any script injection ever occurs;
- `script-src 'self' 'wasm-unsafe-eval'` — permits wasm compilation, but the production bundle contains **no wasm**, so the allowance is pure risk;
- `connect-src 'self' https://api.github.com https://github.com https://objects.githubusercontent.com` — these hosts exist only for the beta-endpoint `fetch` in `tauri-bridge.ts`; the actual update check runs in Rust. If a renderer script ever runs, these hosts become an exfiltration sink.
- No `report-to` — injection attempts and policy violations are invisible.

The toast window (`toast.html`) keeps `'unsafe-inline'` for its inline `<style>` — it is an isolated webview with no user input, so this is acceptable but can also be closed by moving the styles to an external file.

**Recommendation:**
1. Move beta-endpoint resolution into a Rust command (it already has `cmd_check_update` with a validated endpoint — resolve the beta URL there instead of in the renderer).
2. Then tighten the CSP:
   ```
   default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com;
   font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data:;
   connect-src 'self'; form-action 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
   ```
   (Verify the Tailwind build emits only external CSS; the sidebar uses no inline `<style>`.)
3. Add CSP violation reporting routed to the diagnostics log (Tauri supports a custom CSP handler) — this converts silent CSP failures into detections.
4. Optional: move `toast.html`'s `<style>` block to an external CSS file and drop `'unsafe-inline'` there too.

#### F5 — Security documentation describes a different app than the one shipped

**Files:** `SECURITY.md`, `src-tauri/src/update.rs` (`cmd_verify_update`, `VERIFY_PUBLIC_KEY_B64`), repo secret `RELEASE_SIGNING_PRIVATE_KEY`
**Status:** Open · **Effort:** S

**Explanation.** `SECURITY.md` says credentials are AES-256-GCM under a keyring and that releases are signed with OpenSSL Ed25519 detached signatures. The shipped reality: credentials are **DPAPI**-encrypted (`storage.rs`/`secure.rs`) and releases are **minisign**-signed via `tauri-plugin-updater`. `cmd_verify_update` and its hard-coded Ed25519 key are **dead code** — no frontend caller exists — and `RELEASE_SIGNING_PRIVATE_KEY` is unused. Anyone (including a future auditor or security researcher) reading the docs will model the wrong trust root and may miss the real one (the minisign key).

**Recommendation:**
1. Rewrite `SECURITY.md` to match reality: DPAPI at rest (Windows-only, user-bound), minisign updater signing with the pinned pubkey in `tauri.conf.json`, version monotonicity.
2. Delete `cmd_verify_update`, `VERIFY_PUBLIC_KEY_B64`, the `pub use` in `lib.rs`, and the unused `RELEASE_SIGNING_PRIVATE_KEY` secret.
3. Document the minisign key as the **single** release trust root, plus its rotation/recovery procedure.

---

### MEDIUM

Medium findings are real weaknesses that should be fixed on a 30-day cadence; they are not individually exploitable to a severe outcome today.

#### F6 — Raw error tails still reach the renderer
**Files:** `src-tauri/src/sip.rs:172-182`
**Status:** In-progress · **Effort:** S

**Explanation.** `user_safe_sip_error` maps common OS/DNS errors to friendly text, but the fallback branch returns `SIP error: {raw up to 128 chars}`, so unmapped errors can expose host/IP/port/OS details in the UI and the on-disk diagnostics file.

**Recommendation:** make the fallback fully generic (e.g. `"SIP registration failed — check server and port"`), and keep the raw detail only in the Rust-side `log::error!`. Remove the `SIP error: {}` format entirely.

#### F7 — Legacy migration key derivation is not secret
**Files:** `src-tauri/src/migrate.rs:61-79`
**Status:** Open (inherited) · **Effort:** S

**Explanation.** Legacy Sip-Toast `enc:`/`fb:` formats derive the AES key from **non-secret** values (hostname + platform + arch + CPU model). Anyone with the ciphertext can recompute the key and decrypt old passwords. This only affects one-time migration of legacy data — new data is DPAPI-protected — but it should never be presented as secure.

**Recommendation:** document the limitation in SECURITY.md; after a successful migration, delete the legacy config file(s) (and note that `run_migration` is idempotent via the marker file); never log the plaintext (already enforced by the redaction chokepoint).

#### F8 — No coverage gate; thin bridge/IPC test coverage
**Files:** `ci.yml`, `src/security/secretRedactor.test.ts`, Rust `#[cfg(test)]` modules
**Status:** Open · **Effort:** M

**Explanation.** Unit tests exist for storage, SIP config validation, startup, `host_is_private`, and redaction, but there is no coverage threshold, and the IPC layer (`tauri-bridge.ts`: sanitizers, endpoint resolution, error mapping, `SecureStorage`) has no tests — the exact layer where the 1.9.5 regression lived.

**Recommendation:** add a coverage job with a threshold (e.g. `cargo llvm-cov` for Rust, `vitest --coverage` with a floor for TS) and add unit tests for `sanitizeSipServer`, `resolveUpdateEndpoint` (stable/beta), bridge error mapping, and `SecureStorage` write-queue behavior.

#### F9 — Panic hook writes raw panic payload to plaintext files
**Files:** `src-tauri/src/crash.rs`
**Status:** Open · **Effort:** S

**Explanation.** The global panic hook writes the raw panic message and process args to `%APPDATA%\CallerFlash\crashes\` **and** `%TEMP%`. If a future panic ever formats a secret (e.g. a debug `{:?}` of a config), it would persist to disk in plaintext. There is also no crash-collection path.

**Recommendation:** run the panic text through a redaction pass before writing; drop the `%TEMP%` copy (or restrict it to debug builds); consider optional, consent-based crash reporting later.

#### F10 — Rate limiter mutex poisoning + in-memory only
**Files:** `src-tauri/src/ratelimit.rs:24`
**Status:** Open · **Effort:** S

**Explanation.** `self.buckets.lock().unwrap()` will panic if a thread panics while holding the lock, turning a benign failure into a crash. The limiter is per-process and in-memory, which is fine for a single-user desktop app (its job is to stop a compromised renderer from spamming IPC) but should be documented as such.

**Recommendation:** use `self.buckets.lock().unwrap_or_else(|e| e.into_inner())`; add a comment that the limiter's scope is renderer-spam containment.

#### F11 — No integrity check on settings.json
**Files:** `src-tauri/src/storage.rs`, `src-tauri/src/startup.rs`
**Status:** Open · **Effort:** M

**Explanation.** `settings.json` has atomic writes, a backup file, and JSON-parse validation, but no integrity/HMAC over non-secret fields. A local actor could edit e.g. `toastConfig` or `appPreferences` undetected. Impact is limited to the same OS user (who can already operate as that user), and credentials stay DPAPI-protected, so this is an accepted-risk candidate.

**Recommendation:** either document as accepted (preferred) or add an HMAC over non-secret fields — with the explicit constraint that the HMAC key must not be weaker than DPAPI, otherwise it adds nothing.

#### F12 — `npm audit` gate only at high; current tree has a high dev vuln
**Files:** `ci.yml`, `package-lock.json`
**Status:** In-progress · **Effort:** S

**Explanation.** `npm audit --audit-level=high` ignores moderate/low advisories. A live audit of `main` reports **undici 7.28.0 high** (dev-only, pulled in by `jsdom`); a dependabot PR bumping to 7.29.0 is open and CI-green. Runtime impact is nil (dev-only), but the gate would currently pass despite a pending high advisory.

**Recommendation:** merge the dependabot PR; consider `--audit-level=moderate` once dev advisories are auto-managed; keep `npm audit` failing-fast so pending advisories surface.

#### F13 — Auto version bump does not sync Cargo.lock
**Files:** `.github/workflows/version-bump.yml`
**Status:** Open · **Effort:** S

**Explanation.** The auto-bump rewrites `Cargo.toml`, `package.json`, and `tauri.conf.json` but not the root-package `version` entry in `Cargo.lock`, so the committed lockfile drifts from the manifest after every bump (the release build rewrites it in-place on the runner, hiding the drift).

**Recommendation:** in the bump step, also replace the root package `version` in `Cargo.lock` (or run `cargo check --locked` on the runner and commit the result).

---

### LOW

Low findings are hygiene, documentation, or defense-in-depth items.

#### F14 — Stale governance artifacts contradict the real workflow
**Files:** `AGENTS.md`, `CRITICAL.md`
**Status:** Open · **Effort:** S

**Explanation.** Both describe a nonexistent model (`refactor/tauri` branch, gh-API-only edits, "NO LOCAL BUILDS", temp working dir). Actual operations use `main`, a direct local checkout, and local `tsc`/lint. Agents and contributors following the docs will take wrong actions.

**Recommendation:** rewrite both to the real operating model (main branch, local checkout, `tsc --noEmit`/`npm run lint`/`cargo test` allowed, builds validated by CI).

#### F15 — Diagnostics file persists server host/port and SIP usernames
**Files:** `src-tauri/src/sip.rs` (`sip:log`), `src-tauri/src/migrate.rs`
**Status:** Open (by design) · **Effort:** S

**Explanation.** The on-disk diagnostics log intentionally stores support-relevant detail (server:port, usernames) — but never passwords (redaction chokepoint). The exported log is therefore sensitive and may contain the account owner's PII.

**Recommendation:** add a "clear diagnostics" action that also deletes the on-disk `diagnostics.log`; document the file's contents in the UI.

#### F16 — Update endpoint is a mutable GitHub pointer
**Files:** `src-tauri/src/update.rs`, `src-tauri/tauri.conf.json`
**Status:** Note (not a defect) · **Effort:** L

**Explanation.** `releases/latest/download/update.json` is a mutable pointer: GitHub's "latest" can be re-pointed or a release replaced. Integrity is preserved because the updater verifies the minisign signature against the pinned pubkey — this is defense-in-depth, not a bypass. Worth hardening for a mature product.

**Recommendation:** serve `update.json` and installers from immutable storage or a dedicated endpoint (per the `releases.callerflash.app` intent in SECURITY.md), and publish a documented minisign key-rotation/recovery procedure.

---

## Resolved since last audit

| Prior ID | Issue | Status |
|---|---|---|
| C1 | SIP password plaintext under Tauri | Resolved — DPAPI at rest (`storage.rs`), live `hasNativeStorage` getter, localStorage password blanked |
| C2 | UDP bind `0.0.0.0:5060` | Resolved — ephemeral `0.0.0.0:0` (standard SIP client source port) |
| C3 | SIP header injection via `format!` | Resolved — `contains_sip_dangerous_chars` validation in `SipConfig::validate` |
| C4 | CSV formula injection | Resolved — `sanitizeCSV` (quote-escaping + `'` prefix) in `CallHistory.tsx` |
| C5 | Unsanitized caller name stored | Resolved — `sanitizeCallerName` + `sanitize_caller_id` at parser exit |
| C6 | `document.write` dead code XSS | Resolved — `simulateIncomingCall.ts` removed |
| C7 | `withGlobalTauri: true` | Resolved — `false` |
| C8 | CSP `'unsafe-inline'` in styles | Partially — remains (see F4) |
| C9 | CI `rm package-lock.json` + `npm install` | Resolved — `npm ci` |
| C10 | CI never ran tests | Resolved — `npm test` + `cargo test` in ci.yml |
| H1 | No password validation | Resolved — 1..512 chars, required |
| H2 | Shared window capabilities | Resolved — separate `toast.json` capability |
| H3 | `disconnect` lied about success | Resolved |
| H6 | CSP `ws:`/`http://localhost` | Resolved — `connect-src` pinned |
| H7 | Broad `shell:allow-open` | Resolved — HTTPS-only + Rust-side validation + private-host block |
| H8 | `cargo audit` `continue-on-error` | Resolved — fails CI with documented ignores (RUSTSEC-2024-0429 + 12 Linux-only gtk/proc-macro-error + 5 unic-* unmaintained warnings) |
| H10 | No SAST | Resolved — CodeQL active (rust), 25 rules, 0 findings |
| H11 | OS error details leaked | Partially — see F6 |
| M1 | No rate limiting | Resolved — 10/s general, 2/s SIP |
| M2 | Tray 0×0 icon fallback | Resolved |
| M5 | Toast payload unbounded | Resolved — 64KB cap + object check |
| M6 | `parseInt` without radix | Resolved |

---

## Threat model (current)

**Assets:** SIP credentials (SIP username/password/auth username), caller-ID records, SIP registration session, app config, update-channel trust, GitHub signing key.

| Attack path | Likelihood | Impact | Current mitigation | Gap |
|---|---|---|---|---|
| Remote XSS in WebView | Low | High | Strict CSP, `withGlobalTauri:false`, no remote content, `textContent` DOM, `sanitize_caller_id` | `'unsafe-inline'` styles, no CSP reporting |
| SIP provider sends crafted INVITE | Medium | Low-Med | Sanitize at parse exit, caller-ID-only (never answers), digest auth | No fuzzing of parser path |
| GitHub account/repo compromise | Low | **Critical** | Signing key in repo secret | **No branch protection, auto-publish, no approval gate** (F1/F2) |
| Local disk theft of settings.json | Medium | Medium | DPAPI (user-bound), password never in logs/localStorage | No HMAC on non-secret fields (F11) |
| Local attacker reads diagnostics | Low | Low | Redaction chokepoint | Host/usernames persisted (F15) |
| Malicious update endpoint | Low | High | HTTPS + host allow-list + minisign pubkey pin | Mutable `releases/latest` pointer (F16) |
| Compromised renderer spams IPC | Medium | Low | Per-command rate limits + validation | In-memory limiter only (F10) |

**Blue-team stance (DETECT/RESPOND):** CodeQL (CI), `npm audit`/`cargo audit` (CI), dependabot security updates + secret-scanning push protection (GitHub), on-disk diagnostics log, crash dumps, atomic-write backup file, migration marker. Missing: CSP violation reporting, coverage gate, incident runbook.

**Red-team highlights:** the single highest-value target is the **release pipeline** (F1–F3) — a compromised maintainer account or bot PAT yields signed installers. Application-level webview compromise is well-defended; the remaining webview surface is CSP defense-in-depth (F4) and the unchecked-inbound-SIP-parser surface (no fuzzing).

---

## Compliance mapping

### NIST Cybersecurity Framework 2.0
| Function | Evidence |
|---|---|
| **GOVERN** | Security policy (needs refresh — F5); no formal governance/ownership |
| **IDENTIFY** | Threat model (stale — F5); asset inventory via repo; no formal asset register |
| **PROTECT** | DPAPI at rest; IPC validation; rate limiting; least-privilege capabilities; strict CSP; minisign update verification; single-instance; per-user NSIS install |
| **DETECT** | CodeQL; dependabot; `npm audit`/`cargo audit`; secret-scanning + push protection; diagnostics log; crash dumps; (no CSP reporting — F4) |
| **RESPOND** | Crash recovery, backup file, version monotonicity; no incident runbook |
| **RECOVER** | Settings backup/atomic writes; migration marker; version monotonicity defeats rollback |

### ISO/IEC 27001:2022 (Annex A controls)
| Control | Status |
|---|---|
| A.8.24 Use of cryptography | Implemented — DPAPI; minisign/Ed25519 via updater |
| A.8.12 Data leakage prevention | Implemented — redaction chokepoint; local-only network exfil |
| A.8.25 Secure development lifecycle | Partial — CodeQL, dependabot, peer-via-PR (no enforced PRs — F1) |
| A.8.28 Secure coding | Implemented — validation, sanitization, safe DOM |
| A.8.29 Security testing in development | Partial — unit tests; no coverage gate, no fuzzing (F8) |
| A.8.31 Separation of dev/test/prod + secrets | Partial — signing secrets as repo secrets; no environment-gated release (F1/F2) |
| A.5.25/5.26 Supplier security (Actions supply chain) | Partial — ci.yml pinned; release.yml not (F2) |
| A.6.8 Cloud services (GitHub) | Partial — secret scanning, branch policies absent |
| A.8.34 Protection during audit testing | n/a |

### CIS Critical Security Controls v8
| Control | Status |
|---|---|
| 3.3 Secure configuration | Webview/capabilities least privilege |
| 4.x/5.x Access control | **Gap** — no branch protection/review on main (F1) |
| 5.2 Use of secure software | Strict CSP, signed updates |
| 7.4 Remediation of vulnerabilities | Dependabot, `npm audit`, `cargo audit`, CodeQL |
| 8.x Audit log management | Diagnostics + crash dumps; no CSP reporting |
| 13.2/13.3 Data protection | DPAPI, redaction, sanitizers |
| 16.x Application software security | Secure coding, security testing (partial), threat modeling (stale) |
| 18.1 Penetration testing | Recommended (external, before 90-day mark) |

---

## Roadmap

### 7 days — Release gate (block "production-grade" until done)
1. **F1** Enable branch protection on `main` (require PRs, required checks, signed commits, restrict direct pushes).
2. **F1** Move signing key to a protected environment with manual-approval gate; `draft:true` + promote or gated auto-publish; add `attest-build-provenance`.
3. **F2** Pin all release.yml actions by SHA; job-level `permissions`.
4. **F12** Merge dependabot undici 7.29.0 PR.
5. **F5/F14** Rewrite `SECURITY.md` to reality; delete `cmd_verify_update` + unused secret; fix `AGENTS.md`/`CRITICAL.md`.

### 30 days — Hardening
6. **F3** Wire Authenticode signing into release.yml (`signCommand`).
7. **F4** Tighten CSP: drop `wasm-unsafe-eval`, route beta-endpoint resolution through Rust, remove inline-style allowance or hash it, add CSP violation reporting.
8. **F6** Fully generic user-safe SIP errors.
9. **F8** Coverage gate (Rust + TS) + bridge/IPC unit tests.
10. **F2** Pin PJSIP to a release tag; pin choco versions; cache PJSIP build.
11. **F9** Redact panic payloads; stop writing to `%TEMP%`.
12. **F13** Sync `Cargo.lock` in the auto-bump workflow.
13. Add CodeQL JS/TS analysis (currently rust-only).

### 90 days — Enterprise readiness
14. **F16** Immutable update storage / dedicated endpoint; documented minisign key rotation & recovery; keep secret in a vault/HSM-backed store.
15. Attach SBOM (SPDX) to every release.
16. **F7** Post-migration cleanup of legacy config files.
17. External penetration test (webview + SIP parser fuzz).
18. Opt-in telemetry/crash reporting with explicit consent; on-disk diagnostics clear action (F15).
19. Formalize NIST/ISO mapping in a living security doc + incident runbook.

---

## Release-gate verdict

**Conditional GO.**

- **Why GO today:** No known exploitable application-level vulnerability; credentials encrypted at rest; updates signature-verified; the SIP-password regression is fixed, verified, and shipped in stable `1.9.6` and beta `v1.9.6-beta`; lint/typecheck/tests/CodeQL clean; `npm audit` and `cargo audit` gates active.
- **Conditions (must be met to claim "production-grade"):** complete the 7-day items (branch protection, approval-gated release publishing, SHA-pinned release actions, signing-key isolation, docs refresh). Without these, the update channel is one GitHub-account compromise away from serving attacker-signed installers.
- **Known accepted gaps for a personal/small-team rollout:** unsigned installer (SmartScreen), mutable GitHub update endpoint, no coverage gate, no external pentest.

---
*Reported by an automated audit run. Findings are advisory; remediation patches are described inline. Re-run after each release window.*
