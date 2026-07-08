# Branch Strategy & Release Channels

## Branches

| Branch | Purpose | Auto-builds? | Release channel |
|--------|---------|-------------|-----------------|
| `refactor/tauri` | Tauri 2.0 migration — active development | No | — |
| `main` | Latest stable Tauri release | Yes | `stable` |
| `beta` | Feature-complete, stabilization phase | Yes | `beta` |

## Creating a Release

### Stable
```bash
git checkout main
git merge refactor/tauri
# Tag the release commit:
git tag v1.5.0
git push origin v1.5.0
```

The CI workflow in `.github/workflows/tauri.yml` builds the NSIS installer via `cargo tauri build` and publishes to GitHub Releases.

### Beta
```bash
git checkout beta
git merge refactor/tauri
git tag v1.5.0-beta.1
git push origin v1.5.0-beta.1
```

## What happens when you push to main

1. GitHub Actions picks up the push event.
2. `tauri.yml` workflow runs:
   - `cargo fmt --check`
   - `cargo clippy -- -D warnings`
   - `cargo test`
   - `cargo audit`
   - `npm test`
   - `npm run build` (TypeScript + Vite)
   - `cargo tauri build` → NSIS `.exe` installer
3. Release is published to GitHub Releases with the installer attached.
