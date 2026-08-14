# CallerFlash

[![Version](https://img.shields.io/github/v/release/jaydenrussell/CallerFlash?label=stable&color=2ea44f)](https://github.com/jaydenrussell/CallerFlash/releases)
[![Beta](https://img.shields.io/github/v/release/jaydenrussell/CallerFlash?include_prereleases&label=beta&sort=semver&color=fbca04)](https://github.com/jaydenrussell/CallerFlash/releases)
[![Downloads](https://img.shields.io/github/downloads/jaydenrussell/CallerFlash/total?label=downloads&color=blue)](https://github.com/jaydenrussell/CallerFlash/releases)
[![License](https://img.shields.io/github/license/jaydenrussell/CallerFlash?color=blue)](https://github.com/jaydenrussell/CallerFlash/blob/main/LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows-0078D6?logo=windows&logoColor=white)](https://github.com/jaydenrussell/CallerFlash/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/jaydenrussell/CallerFlash/ci.yml?label=CI&logo=github)](https://github.com/jaydenrussell/CallerFlash/actions)

A lightweight SIP caller-ID app for Windows. Registers to your SIP provider, shows a toast notification for every incoming call, and auto-copies the caller's number to your clipboard. Built with Tauri 2 (Rust backend) + React. Optimized for VoIP.ms; works with any RFC-compliant SIP provider.

## Features

- **Universal SIP** — UDP, TCP, or TLS; tested with VoIP.ms, Twilio, Telnyx, Bandwidth, and more
- **Toast notifications** — fully customizable font, colors, position, duration, border radius, opacity
- **Auto clipboard copy** — caller number is copied automatically so a paste finds the caller
- **Draggable toasts** — reposition any notification; position persists for future calls
- **Persistent call history** — grouped by Today / Yesterday / Last 7 days / Last 30 days / Older
- **Start with Windows** — optionally launch minimized; calls still detected in the background
- **Auto-update** — signed releases with SHA-256 + Ed25519 verification
- **Security hardened** — CSP, least-privilege permissions, DPAPI-encrypted credentials, SIP input sanitization

## Install

1. Go to the [Releases](https://github.com/jaydenrussell/CallerFlash/releases) page
2. Download the latest installer — e.g. `CallerFlash_2.1.0-beta_x64-setup.exe` (Windows x64)
3. Run the installer — no dependencies required; WebView2 is auto-installed if missing
4. Open CallerFlash and configure your SIP provider credentials in **Settings**
5. Click **Connect** on the Dashboard

When calls come in, a toast appears with the caller's number (auto-copied to your clipboard) and the call is added to Call History.

## Development

Requires Windows, Node.js, and the Rust toolchain.

```bash
# Clone
git clone https://github.com/jaydenrussell/CallerFlash.git
cd CallerFlash

# Install frontend dependencies
npm install

# Dev server (frontend only)
npm run dev

# Run checks
npm run typecheck
npm run lint
npm test
npm run build

# Build Windows installer
npm run tauri:build
```

## License

MIT
