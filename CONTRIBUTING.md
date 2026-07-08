# Contributing to CallerFlash

Thanks for contributing! Please read this before opening a PR.

## Development

```bash
# Clone
git clone https://github.com/jaydenrussell/CallerFlash.git
cd CallerFlash

# Install frontend dependencies
npm install

# Dev server (hot reload)
npm run dev

# Build frontend for production
npm run build

# Build Windows installer (requires Windows + Rust toolchain)
npm run tauri:build

# Run Rust tests
cd src-tauri && cargo test

# Run all Rust checks
cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test
```

## Branch Workflow

| Branch | Purpose |
|--------|---------|
| `main` / `nightly` | Bleeding-edge dev — PRs land here first |
| `beta` | Feature-freeze — bug fixes only |
| `stable` | Production — tagged releases |

## PR Checklist

- [ ] `npm run build` passes locally
- [ ] All diagnostic log calls use the sanitized output (no raw credential logging)
- [ ] Any new Rust dependency is pinned to an exact version in `src-tauri/Cargo.toml`
- [ ] Any new JS dependency is pinned to an exact version in `package.json`
- [ ] The PR targets the `refactor/tauri` branch (not `stable` or `beta`)

## Security

If you discover a vulnerability, **do not open a public issue.** Email `security@callerflash.app` or use GitHub's [private vulnerability reporting](../../security/advisories/new).

See [`SECURITY.md`](SECURITY.md) for the full threat model and cryptographic verification procedures.
