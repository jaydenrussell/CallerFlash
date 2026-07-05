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
  return path.join(downloadsDir(), `CallerFlash-${String(version).replace(/^v/, '')}.exe`);
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

  // Filter by channel: use tag_name matching (not GitHub's prerelease flag,
  // which can be inconsistent). Tag conventions:
  //   stable  → v1.5.0 (no prerelease suffix)
  //   beta    → v1.5.0-beta.28
  //   alpha   → v1.5.0-alpha.3
  let filtered;
  if (channel === 'stable') {
    filtered = releases.filter(r => !r.draft && !/-beta|alpha/i.test(r.tag_name));
  } else if (channel === 'beta') {
    filtered = releases.filter(r => !r.draft && /-beta(\.|$)/i.test(r.tag_name));
  } else if (channel === 'alpha') {
    filtered = releases.filter(r => !r.draft && /-alpha(\.|$)/i.test(r.tag_name));
  } else {
    return null;
  }
  if (!filtered.length) return null;

  // Sort by semver descending (highest version first).
  filtered.sort((a, b) => {
    const va = normaliseVersion(a.tag_name);
    const vb = normaliseVersion(b.tag_name);
    return isUpdateAvailable(vb, va) ? -1 : isUpdateAvailable(va, vb) ? 1 : 0;
  });

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

  // Parse semver with prerelease tag (e.g. "1.5.0-beta.28" → { major:1, minor:5, patch:0, pre:"beta", preN:28 })
  const parseSemver = (v) => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:[-.]([\w]+)(?:[.\-](\d+))?)?$/);
    if (!m) return null;
    return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null, preN: m[5] ? +m[5] : 0 };
  };

  const r = parseSemver(normRemote);
  const l = parseSemver(normLocal);

  if (r && l) {
    // Compare major.minor.patch first
    if (r.major !== l.major) return r.major > l.major;
    if (r.minor !== l.minor) return r.minor > l.minor;
    if (r.patch !== l.patch) return r.patch > l.patch;

    // Same base version — compare prerelease tags.
    // No prerelease (stable) is NEWER than any prerelease (beta/alpha).
    // e.g. 1.5.0 > 1.5.0-beta.28 (stable is newer than beta)
    if (!r.pre && l.pre) return true;   // remote is stable, local is beta → update available
    if (r.pre && !l.pre) return false;  // remote is beta, local is stable → no update
    if (r.pre && l.pre) {
      // Both have prerelease — compare type first (alpha < beta), then number.
      const typeOrder = { alpha: 0, beta: 1 };
      const tR = typeOrder[r.pre] ?? 2;
      const tL = typeOrder[l.pre] ?? 2;
      if (tR !== tL) return tR > tL;
      return r.preN > l.preN;
    }
    return false; // both stable, same version
  }

  // Fallback: lexicographic comparison
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
    return { upToDate: true };
  }

  const currentVersion = app.getVersion();
  log(`checking channel=${channel} current=${currentVersion}`);

  try {
    const release = await findLatestRelease(channel);
    if (!release) {
      log('no release found for channel:', channel);
      return { upToDate: true };
    }

    log(`found release: ${release.version} (${release.publishedAt})`);

    if (!isUpdateAvailable(currentVersion, release.version)) {
      log('up to date');
      return { upToDate: true };
    }

    return {
      version: release.version,
      downloadUrl: release.downloadUrl,
      publishedAt: release.publishedAt,
      friendlyName: friendlyVersion(release.version),
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

  sendUpdateDiag('info', 'Download starting', 'url=' + downloadUrl.substring(0, 80));
  downloadState.status = 'downloading';
  downloadState.version = version;
  downloadState.error = null;
  saveDownloadState();
  sendStatus({ status: 'downloading', version });

  try {
    let receivedBytes = 0;
    let contentLength = 0;
    await new Promise((resolve, reject) => {
      let redirectsLeft = 5;
      function fetchUrl(url) {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, { headers: { 'User-Agent': 'CallerFlash' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
            redirectsLeft--;
            res.resume();
            sendUpdateDiag('info', 'Following redirect', '→ ' + res.headers.location.substring(0, 80) + ' (' + redirectsLeft + ' redirects left)');
            return fetchUrl(res.headers.location);
          }
          if (res.statusCode !== 200) { return reject(new Error(`HTTP ${res.statusCode}`)); }
          contentLength = parseInt(res.headers['content-length'] || '0', 10);
          sendUpdateDiag('info', 'Download connected', 'HTTP 200, size=' + (contentLength / 1048576).toFixed(2) + ' MB');
          const file = fs.createWriteStream(destPath);
          file.on('error', reject);
          res.on('data', (chunk) => {
            receivedBytes += chunk.length;
            if (contentLength > 0) sendProgress({ percent: Math.round((receivedBytes / contentLength) * 100), receivedBytes, total: contentLength });
          });
          res.on('end', () => {
            file.end();
          });
          file.on('finish', () => {
            file.close();
            resolve();
          });
          res.pipe(file);
        });
        req.on('error', reject);
        req.setTimeout(120000, () => { req.destroy(new Error('Download timeout')); reject(new Error('Download timeout')); });
      }
      fetchUrl(downloadUrl);
    });

    // Verify file was actually written
    if (!fs.existsSync(destPath)) {
      const dir = downloadsDir();
      let listing = 'empty';
      try { listing = fs.readdirSync(dir).join(', '); } catch {}
      sendUpdateDiag('error', 'Download: file missing after promise resolved', 'checked=' + destPath + ' dir=' + listing);
      throw new Error('File not written to disk after download completed. Dir contents: ' + listing);
    }

    try {
      let cleaned = 0;
      for (const f of fs.readdirSync(downloadsDir())) {
        if (f.endsWith('.exe') && !f.includes(version.replace(/^v/, ''))) { fs.unlinkSync(path.join(downloadsDir(), f)); cleaned++; }
      }
      if (cleaned > 0) sendUpdateDiag('info', 'Cleaned old EXEs', '' + cleaned + ' files removed');
    } catch {}

    const stats = fs.statSync(destPath);
    if (stats.size === 0) {
      sendUpdateDiag('error', 'Download: file is zero bytes', destPath);
      try { fs.unlinkSync(destPath); } catch {}
      throw new Error('Downloaded file is 0 bytes');
    }

    downloadState.version = version;
    downloadState.path = destPath;
    downloadState.status = 'ready';
    downloadState.error = null;
    saveDownloadState();
    log('download complete:', destPath);
    sendUpdateDiag('success', 'Download complete', (stats.size / 1048576).toFixed(2) + ' MB → ' + destPath);
    sendStatus({ status: 'ready', version });
    return { status: 'ready', path: destPath, size: stats.size };
  } catch (err) {
    downloadState.status = 'error';
    downloadState.error = err.message;
    saveDownloadState();
    logErr('download failed:', err.message);
    sendUpdateDiag('error', 'Download failed', err.message);
    try { fs.unlinkSync(destPath); } catch {}
    sendStatus({ status: 'error', message: err.message });
    return { status: 'error', error: err.message };
  }
}

// ── Install update ────────────────────────────────────────────────────
function installUpdate(version) {
  const exePath = exePathFor(version);
  sendUpdateDiag('info', 'Install: checking file', exePath);

  if (!fs.existsSync(exePath)) {
    sendUpdateDiag('error', 'Install: file not found', exePath);
    sendStatus({ status: 'error', message: 'File not found. Download again.' });
    return { status: 'error' };
  }

  const stats = fs.statSync(exePath);
  sendUpdateDiag('info', 'Install: file OK', (stats.size / 1048576).toFixed(2) + ' MB');

  sendStatus({ status: 'installing', version });

  const appPath = process.execPath;
  const installDir = path.dirname(appPath);
  const helperPath = path.join(__dirname, 'updater-helper.cjs');
  const helperExists = fs.existsSync(helperPath);
  const isPacked = !!(process.resourcesPath && process.resourcesPath.includes('app.asar'));

  sendUpdateDiag('info', 'Install: preparing to help', 'helper=' + helperPath + ' exists=' + helperExists + ' packed=' + isPacked + ' execPath=' + appPath);
  log('spawning helper:', helperPath, 'exists:', helperExists);

  if (!helperExists) {
    sendUpdateDiag('error', 'Install: helper script not found on disk', 'Checked: ' + helperPath + ' (asarUnpack may be missing)');
    sendStatus({ status: 'error', message: 'Helper not found. Reinstall the app.' });
    return { status: 'error' };
  }

  try {
    const helper = spawn(process.execPath, [
      helperPath,
      '--installer', exePath,
      '--app', appPath,
      '--dir', installDir,
      '--pid', String(process.pid),
    ], { detached: true, stdio: 'ignore', windowsHide: true });
    helper.unref();
    sendUpdateDiag('info', 'Install: helper spawned (pid=' + (helper.pid || 'unknown') + ')', 'detached=true');
  } catch (err) {
    logErr('failed to spawn helper:', err.message);
    sendUpdateDiag('error', 'Install: failed to spawn helper', err.message);
    sendStatus({ status: 'error', message: 'Failed to start installer' });
    return { status: 'error' };
  }

  sendUpdateDiag('info', 'Install: helper spawned, quitting in 1.5s');

  setTimeout(() => {
    updaterCanClose = true;
    app.quit();
  }, 1500);

  return { status: 'installing' };
}

// ── Diagnostic logging (sent to renderer's Diagnostics panel) ────────
function sendUpdateDiag(level, message, details) {
  const payload = { level, message, details };
  log('[' + level + ']', message, details || '');
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send('updater:diagnostic', payload);
  }
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
    sendUpdateDiag('info', 'Update check requested', 'channel=' + channel);
    const result = await checkForUpdates(channel || 'stable') || { upToDate: true };
    sendUpdateDiag(result.version ? 'info' : 'success', result.version ? 'Update found: ' + result.version : 'Up to date', result.error || '');
    return result;
  });

  ipcMain.handle('updater:download', async (_e, { channel, version, downloadUrl }) => {
    sendUpdateDiag('info', 'Download requested', 'channel=' + channel + ' version=' + version);
    const result = await downloadUpdate(channel, version, downloadUrl);
    sendUpdateDiag(result.status === 'ready' ? 'success' : 'error', 'Download result: ' + result.status, result.path || result.error || '');
    return result;
  });

  ipcMain.handle('updater:install', (_e, { version }) => {
    sendUpdateDiag('info', 'Install requested', 'version=' + version);
    const result = installUpdate(version);
    sendUpdateDiag(result.status === 'installing' ? 'info' : 'error', 'Install result: ' + result.status, result.error || '');
    return result;
  });

  ipcMain.handle('updater:getDownloadState', () => {
    // Verify the exe actually exists on disk (it may have been deleted)
    if (downloadState.version && downloadState.status === 'ready') {
      const p = exePathFor(downloadState.version);
      if (fs.existsSync(p)) {
        downloadState.path = p;
        saveDownloadState();
      } else {
        // File was deleted — reset to idle
        sendUpdateDiag('warning', 'Download state was ready but file missing, resetting to idle', p);
        downloadState.status = 'idle';
        downloadState.path = null;
        downloadState.error = null;
        saveDownloadState();
      }
    } else if (downloadState.version && downloadState.status === 'idle') {
      const p = exePathFor(downloadState.version);
      if (fs.existsSync(p)) {
        sendUpdateDiag('info', 'Download state was idle but file exists, upgrading to ready', p);
        downloadState.status = 'ready';
        downloadState.path = p;
        saveDownloadState();
      }
    }
    return { ...downloadState };
  });
}

module.exports = { initUpdaterIPC, checkForUpdates, downloadUpdate, installUpdate, normaliseVersion, friendlyVersion };
