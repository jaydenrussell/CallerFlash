# Branch Strategy & Release Channels

## Branches

| Branch | Purpose | Auto-builds? | Release channel ||--------|---------|-------------|-----------------|| `main` | Latest development (alias for alpha) | Yes | `alpha` || `alpha` | Bleeding-edge, every commit to this branch builds a dev build | Yes | `alpha` || `beta` | Feature-complete, stabilization phase | Yes | `beta` || `stable` | Production releases, tagged with `v*` | Yes | `stable` |
## How to set up the branches (one-time)

Run these commands in your local repository, then push:

```bash
# Create alpha (synced from main)
git checkout main
git checkout -b alpha
git push origin alpha

# Create beta
git checkout -b beta
git push origin beta

# Create stable
git checkout -b stable
git push origin stable
```

## Creating a Release

### Alpha (automatic)
Every time you push to `main` or `alpha`, a build is queued automatically. The `.exe` is uploaded as a **pre-release** artifact in your Releases tab.

### Beta
```bash
git checkout beta
git merge alpha
# Or tag a specific commit:
git tag v1.5.0-beta.1
git push origin v1.5.0-beta.1
```

### Stable
```bash
git checkout stable
git merge beta
# Tag the release commit:
git tag v1.5.0
git push origin v1.5.0
```

### Manual (from GitHub UI)
1. Go to your repository on GitHub.
2. Click the **Actions** tab.
3. Select **"Build & Release (Stable / Beta / Alpha)"** in the left sidebar.
4. Click **Run workflow**.
5. Choose `stable`, `beta`, or `alpha` from the dropdown.
6. Click **Run workflow**.

## What happens when you push

1. GitHub Actions picks up the push event.
2. `route` job reads the branch name or git tag and determines:
   - **Channel** (`stable` / `beta` / `alpha`)
   - **Pre-release flag** (stable = no, beta/alpha = yes)
   - **Version string** (e.g. `1.4.2-alpha.abc1234`)
3. `build` job:
   - Bumps `package.json` version to the generated version string.
   - Runs `npm ci && npm run build` (TypeScript + Vite).
   - Packages the app with `electron-builder` → 64-bit NSIS `.exe`.
   - Publishes to GitHub Releases automatically.
4. `release` job:
   - Creates a GitHub Release with the `.exe` attached.
   - Includes verification instructions in the release notes.
