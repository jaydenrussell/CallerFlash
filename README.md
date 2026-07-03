# CallerFlash

A SIP-compliant Windows desktop client with toast notifications. Optimized for VoIP.ms, works with any standard SIP provider.

![GitHub release (latest by date)](https://img.shields.io/github/v/release/jaydenrussell/CallerFlash?label=stable)
![GitHub release (latest by date including pre-releases)](https://img.shields.io/github/v/release/jaydenrussell/CallerFlash?include_prereleases&label=beta)
![Platform](https://img.shields.io/badge/platform-Windows%20x64-blue)
![License](https://img.shields.io/github/license/jaydenrussell/callerflash)

## Features

- **Universal SIP** — UDP, TCP, or TLS; works with VoIP.ms, Twilio, Telnyx, Bandwidth, and any RFC-compliant SIP provider
- **Toast notifications** — fully customizable font, colors, position, duration, border radius, and opacity
- **Auto clipboard copy** — caller number automatically copied for instant paste into Acuity Scheduler
- **Draggable toasts** — reposition any notification; position persists for future calls
- **Start with Windows** — optionally launch minimized, calls still detected in background
- **Auto-update** — three channels (stable, beta, nightly); signed releases with SHA-256 + Ed25519 verification
- **Full diagnostics** — SIP, toast, and system logs with export
- **Security hardened** — CSP, credential redaction, SIP input sanitization, clipboard injection protection

## Releases

| Channel | Description | How to get it |
|---------|-------------|---------------|
| **Stable** | Production-ready, tested for 7+ days | `git tag v1.4.2 && git push origin v1.4.2` |
| **Beta** | Latest features, 1+ day soak | `git tag v1.5.0-beta.1 && git push origin v1.5.0-beta.1` |
| **Nightly** | Automated builds from latest `main` | Push to `nightly` branch triggers auto-build |

All builds are **Windows 64-bit only** (NSIS installer `.exe`).

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

# Install
npm install

# Dev server
npm run dev

# Build for production
npm run build

# Build Windows installer (requires Windows)
npm run electron:build
```

## Security

See [SECURITY.md](SECURITY.md) for the full threat model, update verification pipeline, and vulnerability disclosure process.

Every release is protected by three independent verification layers:
1. **Authenticode code signing** (Windows publisher identity)
2. **SHA-256 checksum** (transport integrity)
3. **Ed25519 detached signature** (pinned public key — never fetched from network)

## License

MIT
