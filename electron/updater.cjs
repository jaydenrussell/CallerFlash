const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');

// ── State ─────────────────────────────────────────────────────────────
let mainWindowRef = null;
let updaterCanClose = false;

const downloadStatePath = () => path.join(app.getPath('temp'), 'callerflash-updates', 'download-state.json');

function loadDownloadState() {
  try {
    const p = downloadStatePath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (data && typeof data === 'object' && typeof data.version === 'string' && typeof data.status === 'string') {
        if (data.status === 'downloading') data.status = 'idle';
        return data;
      }
    }
  } catch { /* corrupt or missing */ }
  return { version: null, path: null, status: 'idle', error: null };
}

let downloadState = loadDownloadState();

function saveDownloadState() {
  try {
    const p = downloadStatePath();
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(downloadState), 'utf8');
  } catch { /* don't crash */ }
}

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
async function findLatestRelease(channel) {
  const releases = await fetchJson('https://api.github.com/repos/jaydenrussell/CallerFlash/releases');
  if (!Array.isArray(releases) || !releases.length) return null;

  let filtered;
  if (channel === 'stable') {
    filtered = releases.filter(r => !r.prerelease && !r.draft && !/beta|alpha/i.test(r.tag_name));
  } else if (channel === 'beta') {
    filtered = releases.filter(r => /beta/i.test(r.tag_name) && !r.draft);
  } else if (channel === 'alpha') {
    filtered = releases.filter(r => /alpha/i.test(r.tag_name) && !r.draft);
  }
  if (!filtered.length) return null;

  filtered.sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0));

  const latest = filtered[0];
  const exe = (latest.assets || []).find(a => /\.exe$/i.test(a.name));
  if (!exe) return null;

  return {
    version: latest.tag_name,
    downloadUrl: exe.browser_download_url,
    publishedAt: latest.published_at,
  };
}

// ── Normalise version strings ─────────────────────────────────────────
function normaliseVersion(v) {
  if (!v) return v;
  return String(v)
    .replace(/^v/, '')
    .replace(/^0\.0\.0-nightly[.\-]/i, 'nightly-')
    .replace(/^nightly\.(\d{8})(?:\.(\d+))?$/i, (_, d, n) => `nightly-${d}${n ? `-${n}` : ''}`);
}

// ── Version comparison ────────────────────────────────────────────────
function isUpdateAvailable(currentVersion, remoteVersion) {
  const normRemote = normaliseVersion(remoteVersion);
  const normLocal = normaliseVersion(currentVersion);

  if (normRemote === normLocal) return false;

  const nightlyRe = /^nightly[.\-](\d{8})(?:[.\-](\d+))?$/i;
  const nightlyR = normRemote.match(nightlyRe);
  const nightlyL = normLocal.match(nightlyRe);
  if (nightlyR && nightlyL) {
    const dateDiff = parseInt(nightlyR[1]) - parseInt(nightlyL[1]);
    if (dateDiff !== 0) return dateDiff > 0;
    const incR = parseInt(nightlyR[2] || '0');
    const incL = parseInt(nightlyL[2] || '0');
    return incR > incL;
  }
  if (nightlyR && !nightlyL) return true;
  if (!nightlyR && nightlyL) return false;

  const parseSemver = (v) => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:[-.](\w+)[.](\d+))?$/);
    if (!m) return null;
    return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null, preN: m[5] ? +m[5] : 0 };
  };

  const r = parseSemver(normRemote);
  const l = parseSemver(normLocal);

  if (r && l) {
    if (r.major !== l.major) return r.major > l.major;
    if (r.minor !== l.minor) return r.minor > l.minor;
    if (r.patch !== l.patch) return r.patch > l.patch;
    if (!r.pre && l.pre) return true;
    if (r.pre && !l.pre) return false;
    if (r.pre && l.pre) {
      if (r.pre !== l.pre) return false;
      return r.preN > l.preN;
    }
    return false;
  }

  return normRemote > normLocal;
}

// ── Friendly version display ──────────────────────────────────────────
function friendlyVersion(version) {
  const v = normaliseVersion(version);
  if (!v) return version;

  const alphaMatch = v.match(/^(\d+\.\d+\.\d+)-alpha\.(\d+)$/);
  if (alphaMatch) return `Alpha ${alphaMatch[1]} (#${alphaMatch[2]})`;

  const betaMatch = v.match(/^(.+?)-beta\.(\d+)$/);
  if (betaMatch) return `Beta ${betaMatch[1]} (#${betaMatch[2]})`;

  return v;
}

// ── Check for updates ─────────────────────────────────────────────────
async function checkForUpdates(channel) {
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
  if (downloadState.status === 'downloading') return { status: 'busy' };

  const destPath = exePathFor(version);
  if (fs.existsSync(destPath)) {
    log('already downloaded:', destPath);
    downloadState.version = version;
    downloadState.path = destPath;
    downloadState.status = 'ready';
    downloadState.error = null;
    saveDownloadState();
    return { status: 'ready', path: destPath };
  }

  if (!downloadUrl) {
    downloadState.status = 'error';
    downloadState.error = 'No download URL';
    saveDownloadState();
    return { status: 'error', error: 'No URL' };
  }

  log('downloading:', downloadUrl);
  downloadState.status = 'downloading';
  downloadState.version = version;
  downloadState.error = null;
  saveDownloadState();
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

    try {
      for (const f of fs.readdirSync(downloadsDir())) {
        if (f.endsWith('.exe') && !f.includes(version)) fs.unlinkSync(path.join(downloadsDir(), f));
      }
    } catch {}

    downloadState.version = version;
    downloadState.path = destPath;
    downloadState.status = 'ready';
    downloadState.error = null;
    saveDownloadState();
    log('download complete:', destPath);
    sendStatus({ status: 'ready', version });
    return { status: 'ready', path: destPath };
  } catch (err) {
    downloadState.status = 'error';
    downloadState.error = err.message;
    saveDownloadState();
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
    if (downloadState.version && downloadState.status === 'idle') {
      const p = exePathFor(downloadState.version);
      if (fs.existsSync(p)) {
        downloadState.status = 'ready';
        downloadState.path = p;
        saveDownloadState();
      }
    }
    return { ...downloadState };
  });
}

module.exports = { initUpdaterIPC, checkForUpdates, downloadUpdate, installUpdate, normaliseVersion, friendlyVersion };
