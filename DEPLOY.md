# CallerFlash — Deployment Guide

Complete instructions for publishing CallerFlash as a signed Windows x64
desktop app on GitHub with stable, beta, and nightly release channels.

---

## Prerequisites

| Requirement | Purpose |
|---|---|
| GitHub account | Hosting, releases, Actions CI/CD |
| Node.js 20+ | Build toolchain |
| Windows code-signing certificate (.pfx) | Authenticode — clears SmartScreen |
| OpenSSL 3+ | Ed25519 release signature generation |

> **No certificate?** The build still works unsigned, but Windows will show
> SmartScreen warnings to users. For public distribution, get an
> [OV or EV code-signing cert](https://docs.microsoft.com/en-us/windows/security/threat-protection/windows-defender-application-control/signing-policies-with-signtool).

---

## Step 1 — Create the GitHub Repository

```bash
# Clone this project
cd callerflash-sip-client

# Init git (if not already)
git init
git add -A
git commit -m "Initial commit"

# Create repo on GitHub (via CLI or web UI)
gh repo create callerflash/callerflash-sip-client --public --source=. --push
```

---

## Step 2 — Generate the Ed25519 Signing Keypair

```bash
chmod +x scripts/generate-signing-keys.sh
./scripts/generate-signing-keys.sh
```

This outputs:
- **Private key** → upload as a GitHub Secret
- **Public key (base64)** → paste into `src/security/updateVerifier.ts`

---

## Step 3 — Configure GitHub Secrets

Go to **Settings → Secrets and variables → Actions** and add:

| Secret Name | Value |
|---|---|
| `WIN_CSC_LINK` | Base64 of your `.pfx` code-signing certificate |
| `WIN_CSC_KEY_PASSWORD` | Password for the `.pfx` |
| `RELEASE_SIGNING_PRIVATE_KEY` | Base64 of the Ed25519 private key (from Step 2) |

> `GITHUB_TOKEN` is automatically available — no need to add it.

### How to base64-encode your .pfx:

```powershell
# PowerShell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("certificate.pfx")) | Set-Clipboard
```

```bash
# Bash
base64 -w0 < certificate.pfx | pbcopy   # macOS
```

---

## Step 4 — Pin the Public Key

Open `src/security/updateVerifier.ts` and replace:

```ts
export const RELEASE_SIGNING_PUBLIC_KEY_B64 =
  'PLACEHOLDER_REPLACE_WITH_REAL_ED25519_PUBLIC_KEY_BASE64';
```

with the base64 string from Step 2. Commit this.

---

## Step 5 — Update the Repo URL

In `src/store/useAppStore.ts`, update:

```ts
githubRepo: 'https://github.com/YOUR_USERNAME/callerflash-sip-client',
```

In `electron-builder.yml`, update:

```yaml
publish:
  provider: github
  owner: YOUR_USERNAME
  repo: callerflash-sip-client
```

---

## Step 6 — Release Channels

### Stable Release

Push a semver tag — the CI builds, signs, checksums, and publishes:

```bash
# Bump version in package.json
npm version 1.5.0 -m "Release v%s"

# Push tag
git push origin main --tags
```

The `promote-stable.yml` workflow fires (or run it manually from the
Actions tab → "Promote → Stable" → "Run workflow"). It creates a GitHub
Release at `v1.5.0` with:
- `CallerFlash-Setup-1.5.0-x64.exe` (Authenticode-signed)
- `SHA256SUMS` (sha256 of the .exe)
- `CallerFlash-Setup-1.5.0-x64.exe.sig` (Ed25519 detached signature)
- `latest.yml` (electron-updater auto-update manifest)
- `beta.yml`, `nightly.yml` are NOT attached for stable; they are
  generated and attached for their respective channels.

The version is auto-incremented by `scripts/next-version.cjs` (patch
bump from the latest `vX.Y.Z` tag) unless you override it via the
workflow's `version_override` input.

### Beta Release

Run from the Actions tab: **"Promote → Beta" → "Run workflow"**. The
`promote-beta.yml` workflow calls the reusable `release.yml` engine with
`channel=beta`.

The version is auto-incremented by `scripts/next-version.cjs` — it bumps
`-beta.N` for the current X.Y.Z, or advances to the next minor
(`X.(Y+1).0-beta.1`) if X.Y.Z is already on stable. Override via the
workflow's `version_override` input.

Published as a GitHub **pre-release**. Only users who opt into the
"beta" channel in CallerFlash receive it. Assets: signed `.exe`,
`SHA256SUMS`, `*.sig`, and `beta.yml` (electron-updater manifest).

### Nightly Release

Runs automatically at 03:00 UTC every night via `release-nightly.yml`,
and also fires on every push to `main` or `nightly` (per SETUP.md's
auto-sync). Calls the reusable `release.yml` engine with
`channel=nightly`.

Nightlies are tagged `v<X.Y.Z>-nightly.<short-sha>`, published as
pre-releases, and auto-cleaned (only the last 7 are kept).

To trigger a nightly manually:
```bash
gh workflow run "Release — Nightly"
```

---

## Step 7 — How Updates Reach Users

1. **User opens CallerFlash** → the Electron main process calls
   `autoUpdater.checkForUpdates()` against the GitHub Releases API.

2. **electron-updater** reads `latest.yml` (stable) or
   `beta.yml` / the release list (beta/nightly).

3. **CallerFlash's verification pipeline** runs in the main process:
   - URL host allow-list ✓
   - HTTPS only ✓
   - Channel pre-release policy ✓
   - Release age gate (stable: 7 days, beta: 1 day) ✓
   - Version monotonicity (no roll-back) ✓
   - SHA-256 checksum ✓
   - Ed25519 signature against pinned public key ✓

4. If **all checks pass**, the update is downloaded and installed on
   next restart. If any check fails, the update is **refused** and the
   failure is logged to the Diagnostics panel.

---

## Build Architecture

```
┌─────────────────────────────────────────────────────┐
│  GitHub Actions (windows-latest)                    │
│                                                     │
│  npm ci → npm run build (Vite) → electron-builder   │
│     │                               │               │
│     ▼                               ▼               │
│  dist/index.html              release/              │
│  (React SPA)                  ├ CallerFlash-Setup-   │
│                               │   1.5.0-x64.exe     │
│                               ├ SHA256SUMS           │
│                               ├ *.exe.sig            │
│                               └ latest.yml           │
│                                                     │
│  Authenticode sign (CSC_LINK) ───────┘              │
│  Ed25519 sign (RELEASE_SIGNING_PRIVATE_KEY) ────┘   │
└─────────────────────────────────────────────────────┘
                      │
                      ▼
         GitHub Release (published)
                      │
                      ▼
         electron-updater (in user's app)
                      │
                      ▼
         Verification pipeline → install or refuse
```

---

## File Layout

```
callerflash-sip-client/
├── .github/workflows/
│   ├── ci.yml                  # Lint + build on every PR
│   ├── release.yml             # Reusable engine (workflow_call) — build + sign + publish
│   ├── release-nightly.yml     # Nightly (cron + push-to-main/nightly) → release.yml
│   ├── promote-beta.yml        # Beta (manual dispatch) → release.yml
│   └── promote-stable.yml      # Stable (manual dispatch) → release.yml
├── build/
│   ├── icon.ico                # App icon (256x256 minimum)
│   ├── icon.png                # Tray icon
│   └── installer.nsh           # NSIS customization (64-bit check)
├── electron/
│   ├── main.cjs                # Electron main process (hardened)
│   └── preload.cjs             # Context-bridged IPC
├── scripts/
│   ├── generate-signing-keys.sh  # Ed25519 keypair generator
│   └── next-version.cjs         # Auto-increment version resolver
├── src/                        # React + Tailwind renderer
│   ├── security/
│   │   ├── updateVerifier.ts   # Ed25519 / SHA-256 / policy checks
│   │   └── secretRedactor.ts   # Credential scrubbing for logs
│   └── ...
├── electron-builder.yml        # Windows x64 build config
├── SECURITY.md                 # Threat model + signing procedure
├── DEPLOY.md                   # This file
└── package.json
```

---

## Troubleshooting

### SmartScreen blocks the installer
You need a code-signing certificate. An EV cert clears SmartScreen
immediately; an OV cert builds reputation over ~2 weeks.

### "Update REJECTED by verification"
Check the Diagnostics panel for the specific step that failed. Common
causes:
- New release is **less than 7 days old** (stable channel)
- Signature or checksum assets missing from the GitHub Release
- Version tag is lower than current (roll-back)

### Nightly build didn't run
The schedule job skips if `main` has no new commits. Use the manual
dispatch button to force a build.

### Build fails on `npm ci`
Run `npm audit fix` locally and commit the updated `package-lock.json`.
The CI runs with `--ignore-scripts` so postinstall hooks are blocked.

---

## Security Contacts

See [SECURITY.md](./SECURITY.md) for reporting vulnerabilities.
