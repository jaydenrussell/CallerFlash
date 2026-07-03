const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');

// ── State ─────────────────────────────────────────────────────────────
let mainWindowRef = null;
let updaterCanClose = false;

const downloadState = {
  version: null, path: null, status: 'idle', error: null,
};

const log = (...a) => console.log('[updater]', ...a);
const logErr = (...a) => console.error('[updater]', ...a);

// ── Downloads ─────────────────────────────────────────────────────────
function downloadsDir() {
  const d = path.join(app.getPath('temp'), 'callerflash-updates');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

function exePathFor(version) {
  return path.join(downloadsDir(), `CallerFlash-${version}.exe`);
}

// ── Fetch GitHub releases ────────────────────────────────────────────
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'CallerFlash' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Bad JSON')); } });
    }).on('error', reject);
  });
}

// ── Find latest release for channel ───────────────────────────────────
// Returns { version, downloadUrl, publishedAt } or null
async function findLatestRelease(channel) {
  const releases = await fetchJson('https://api.github.com/repos/jaydenrussell/CallerFlash/releases');
  if (!Array.isArray(releases) || !releases.length) return null;

  // Filter by channel
  let filtered;
  if (channel === 'stable') {
    filtered = releases.filter(r => !r.prerelease && !r.draft && !/beta|alpha/i.test(r.tag_name));
  } else if (channel === 'beta') {
    filtered = releases.filter(r => /beta/i.test(r.tag_name) && !r.draft);
  } else if (channel === 'alpha') {
    filtered = releases.filter(r => /alpha/i.test(r.tag_name) && !r.draft);
  }
  if (!filtered.length) return null;

  // Sort by published date descending (newest first)
  filtered.sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0));

  const latest = filtered[0];
  const exe = (latest.assets || []).find(a => /\.exe$/i.test(a.name));
  if (!exe) return null;

  return {
    version: latest.tag_name,           // e.g. "v0.1.0-alpha.1"
    downloadUrl: exe.browser_download_url,
    publishedAt: latest.published_at,
  };
}

// ── Normalise version strings ─────────────────────────────────────────
function normaliseVersion(v) {
  if (!v) return v;
  return String(v)
    .replace(/^v/, '')
    // Legacy: strip "0.0.0-nightly." prefix from old CI builds
    .replace(/^0\.0\.0-nightly[.\-]/i, 'nightly-')
    // Legacy: normalise "nightly.YYYYMMDD.N" dots to dashes
    .replace(/^nightly\.(\d{8})(?:\.(\d+))?$/i, (_, d, n) => `nightly-${d}${n ? `-${n}` : ''}`);
}

// ── Version comparison ────────────────────────────────────────────────
// Returns true if remoteVersion is newer than currentVersion
// Uses standard semver comparison with prerelease support.
// alpha: 0.1.0-alpha.1 < 0.1.0-alpha.2 (higher alpha = newer)
// beta: 1.5.0-beta.1 < 1.5.0-beta.2 (higher beta = newer)
// stable: 1.4.2 < 1.5.0 (standard semver)
function isUpdateAvailable(currentVersion, remoteVersion) {
  const normRemote = normaliseVersion(remoteVersion);
  const normLocal = normaliseVersion(currentVersion);

  // Exact match = same version = not an update
  if (normRemote === normLocal) return false;

  // Parse semver with optional prerelease
  const parseSemver = (v) => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:[-.](\w+)[.](\d+))?$/);
    if (!m) return null;
    return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null, preN: m[5] ? +m[5] : 0 };
  };

  const r = parseSemver(normRemote);
  const l = parseSemver(normLocal);

  if (r && l) {
    // Compare major.minor.patch
    if (r.major !== l.major) return r.major > l.major;
    if (r.minor !== l.minor) return r.minor > l.minor;
    if (r.patch !== l.patch) return r.patch > l.patch;

    // Same base version: compare prerelease
    // No prerelease > prerelease (stable > alpha/beta)
    if (!r.pre && l.pre) return true;   // remote stable, local pre
    if (r.pre && !l.pre) return false;   // remote pre, local stable

    // Both have prerelease: compare type then number
    if (r.pre && l.pre) {
      if (r.pre !== l.pre) return false; // different pre types don't compare
      return r.preN > l.preN;
    }

    return false; // equal
  }

  // Fallback: strings differ but can't parse — offer update
  return true;
}

// ── Friendly version display ──────────────────────────────────────────
// Returns a human-readable version name for UI display.
//   0.1.0-alpha.1       → "Alpha 0.1.0 (#1)"
//   1.5.0-beta.28       → "Beta 1.5.0 (#28)"
//   1.4.2               → "1.4.2"
function friendlyVersion(version) {
  const v = normaliseVersion(version);
  if (!v) return version;

  // Alpha: 0.1.0-alpha.N → "0.1.0-alpha.N"
  const alphaMatch = v.match(/^(\d+\.\d+\.\d+)-alpha\.(\d+)$/);
  if (alphaMatch) {
    return `Alpha ${alphaMatch[1]} (#${alphaMatch[2]})`;
  }

  // Beta
  const betaMatch = v.match(/^(.+?)-beta\.(\d+)$/);
  if (betaMatch) {
    return `Beta ${betaMatch[1]} (#${betaMatch[2]})`;
  }

  return v;
}

// ── Check for updates ─────────────────────────────────────────────────
async function checkForUpdates(channel) {
  // In dev mode, skip entirely — package.json version is meaningless
  if (!app.isPackaged) {
    log('dev mode: skipping update check');
    return { upToDate: true, version: app.getVersion() };
  }

  const currentVersion = app.getVersion();
  log(`checking channel=${channel} current=${currentVersion}`);

  try {
    const release = await findLatestRelease(channel);
    if (!release) {
      log('no release found for channel:', channel);
      return { upToDate: true, version: currentVersion };
    }

    log(`found release: ${release.version} (${release.publishedAt})`);

    if (!isUpdateAvailable(currentVersion, release.version)) {
      log('up to date');
      return { upToDate: true, version: currentVersion };
    }

    return {
      version: release.version,
      downloadUrl: release.downloadUrl,
      publishedAt: release.publishedAt,
    };
  } catch (err) {
    logErr('check failed:', err.message);
    return { error: err.message };
  }
}

// ── Download update ───────────────────────────────────────────────────
async function downloadUpdate(channel, version, downloadUrl) {
  if (activeDownload) return { status: 'busy' };

  const destPath = exePathFor(version);
  if (fs.existsSync(destPath)) {
    log('already downloaded:', destPath);
    downloadState.version = version;
    downloadState.path = destPath;
    downloadState.status = 'ready';
    return { status: 'ready', path: destPath };
  }

  if (!downloadUrl) {
    downloadState.status = 'error';
    downloadState.error = 'No download URL';
    return { status: 'error', error: 'No URL' };
  }

  log('downloading:', downloadUrl);
  downloadState.status = 'downloading';
  sendStatus({ status: 'downloading', version });

  try {
    await new Promise((resolve, reject) => {
      const mod = downloadUrl.startsWith('https') ? https : http;
      const file = fs.createWriteStream(destPath);
      const req = mod.get(downloadUrl, { headers: { 'User-Agent': 'CallerFlash' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          downloadUpdate(channel, version, res.headers.location).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) { file.close(); return reject(new Error(`HTTP ${res.statusCode}`)); }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total > 0) sendProgress({ percent: Math.round((received / total) * 100), received, total });
        });
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      });
      req.on('error', reject);
      req.setTimeout(120000, () => { req.destroy(new Error('Download timeout')); });
    });

    // Clean old downloads
    try {
      for (const f of fs.readdirSync(downloadsDir())) {
        if (f.endsWith('.exe') && !f.includes(version)) fs.unlinkSync(path.join(downloadsDir(), f));
      }
    } catch {}

    downloadState.version = version;
    downloadState.path = destPath;
    downloadState.status = 'ready';
    downloadState.error = null;
    log('download complete:', destPath);
    sendStatus({ status: 'ready', version });
    return { status: 'ready', path: destPath };
  } catch (err) {
    downloadState.status = 'error';
    downloadState.error = err.message;
    logErr('download failed:', err.message);
    try { fs.unlinkSync(destPath); } catch {}
    sendStatus({ status: 'error', message: err.message });
    return { status: 'error', error: err.message };
  }
}

// ── Install update ────────────────────────────────────────────────────
function installUpdate(version) {
  const exePath = exePathFor(version);
  if (!fs.existsSync(exePath)) {
    sendStatus({ status: 'error', message: 'File not found. Download again.' });
    return { status: 'error' };
  }

  sendStatus({ status: 'installing', version });

  // Spawn updater helper — separate Electron process that:
  // 1. Waits for this app to exit
  // 2. Runs NSIS installer silently
  // 3. Relaunches the app
  const helperPath = path.join(__dirname, 'updater-helper.cjs');
  const appPath = process.execPath;
  const installDir = path.dirname(appPath);

  log('spawning helper:', helperPath);
  try {
    const helper = spawn(process.execPath, [
      helperPath,
      '--installer', exePath,
      '--app', appPath,
      '--dir', installDir,
      '--pid', String(process.pid),
    ], { detached: true, stdio: 'ignore', windowsHide: true });
    helper.unref();
  } catch (err) {
    logErr('failed to spawn helper:', err.message);
    sendStatus({ status: 'error', message: 'Failed to start installer' });
    return { status: 'error' };
  }

  // Quit after a delay — helper takes over
  setTimeout(() => {
    updaterCanClose = true;
    app.quit();
  }, 1500);

  return { status: 'installing' };
}

// ── Send to renderer ──────────────────────────────────────────────────
function sendStatus(payload) {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send('updater:status', payload);
  }
}

function sendProgress(payload) {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send('updater:progress', payload);
  }
}

// ── IPC handlers ──────────────────────────────────────────────────────
function initUpdaterIPC(mainWindow) {
  mainWindowRef = mainWindow;

  ipcMain.handle('updater:check', async (_e, channel) => {
    return await checkForUpdates(channel || 'stable') || { upToDate: true };
  });

  ipcMain.on('updater:download', async (_e, { channel, version, downloadUrl }) => {
    log('download requested:', channel, version);
    await downloadUpdate(channel, version, downloadUrl);
  });

  ipcMain.on('updater:install', (_e, { version }) => {
    log('install requested:', version);
    installUpdate(version);
  });

  ipcMain.handle('updater:getDownloadState', () => {
    return { ...downloadState };
  });
}

module.exports = { initUpdaterIPC, checkForUpdates, downloadUpdate, installUpdate, normaliseVersion, friendlyVersion };
