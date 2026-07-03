// CallerFlash Updater Helper
// ===========================
// This script is spawned by the main app during install.
// It shows a minimal progress window, waits for the main app to exit,
// runs the NSIS installer (showing its progress), then relaunches the app.
//
// The window ONLY shows NSIS installation progress — never download progress.
// Download happens in the main app before this helper is spawned.
//
// Usage: node updater-helper.cjs --installer <path> --app <path> --dir <install-dir> --pid <parent-pid>

const { app, BrowserWindow, nativeImage } = require('electron');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : null;
}

const installerPath = getArg('--installer');
const appPath = getArg('--app');
const installDir = getArg('--dir');
const parentPid = getArg('--pid');

if (!installerPath || !appPath) {
  console.error('Usage: updater-helper --installer <path> --app <path> [--dir <dir>] [--pid <pid>]');
  process.exit(1);
}

console.log('[updater-helper] Starting...');
console.log('[updater-helper] Installer:', installerPath);
console.log('[updater-helper] App:', appPath);
console.log('[updater-helper] Install dir:', installDir || path.dirname(appPath));
console.log('[updater-helper] Parent PID:', parentPid);

// ── Progress window (shown after app exits) ────────────────────────────
let progressWindow = null;

function createProgressWindow() {
  const iconPath = (() => {
    const resPath = process.resourcesPath || '';
    for (const p of [
      // Packaged: extraResources places icons at resources root
      path.join(resPath, 'cflogo.ico'),
      path.join(resPath, 'cflogo.png'),
      path.join(resPath, 'app.ico'),
      // asarUnpack: may be under buildResources/
      path.join(resPath, 'buildResources', 'cflogo.ico'),
      path.join(resPath, 'buildResources', 'cflogo.png'),
      path.join(resPath, 'buildResources', 'app.ico'),
      // Dev mode
      path.join(__dirname, '..', 'buildResources', 'cflogo.ico'),
      path.join(__dirname, '..', 'buildResources', 'cflogo.png'),
      path.join(__dirname, '..', 'buildResources', 'app.ico'),
    ]) {
      try {
        if (fs.existsSync(p)) return p;
      } catch {}
    }
    return null;
  })();

  progressWindow = new BrowserWindow({
    width: 360,
    height: 200,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    center: true,
    backgroundColor: '#1a1a1a',
    icon: iconPath ? nativeImage.createFromPath(iconPath) : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  progressWindow.setMenuBarVisibility(false);

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; background: #1a1a1a; font-family: 'Segoe UI', system-ui, sans-serif; color: #f0f0f0; overflow: hidden; -webkit-app-region: drag; }
  .container { width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; }
  .title { font-size: 13px; font-weight: 600; margin-bottom: 16px; color: rgba(255,255,255,0.8); }
  .progress-bar { width: 100%; height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; margin-bottom: 12px; }
  .progress-fill { height: 100%; width: 0%; background: linear-gradient(90deg, #60cdff, #4facfe); border-radius: 3px; transition: width 0.3s ease; }
  .status { font-size: 11px; color: rgba(255,255,255,0.5); text-align: center; }
  .pct { font-size: 20px; font-weight: 700; color: #60cdff; margin-bottom: 4px; }
</style>
</head>
<body>
<div class="container">
  <div class="title">Installing CallerFlash Update</div>
  <div class="pct" id="pct">0%</div>
  <div class="progress-bar"><div class="progress-fill" id="fill"></div></div>
  <div class="status" id="status">Waiting for application to close...</div>
</div>
<script>
  const { ipcRenderer } = require('electron');
  const fill = document.getElementById('fill');
  const pct = document.getElementById('pct');
  const status = document.getElementById('status');
  ipcRenderer.on('helper:progress', (_e, data) => {
    if (data.percent != null) {
      fill.style.width = data.percent + '%';
      pct.textContent = Math.round(data.percent) + '%';
    }
    if (data.message) {
      status.textContent = data.message;
    }
  });
</script>
</body>
</html>`;

  progressWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  progressWindow.once('ready-to-show', () => {
    progressWindow.show();
    progressWindow.focus();
  });
}

function sendProgress(percent, message) {
  if (progressWindow && !progressWindow.isDestroyed()) {
    progressWindow.webContents.send('helper:progress', { percent, message });
  }
}

// ── Process monitoring ─────────────────────────────────────────────────
function isProcessRunning(pid) {
  try {
    const output = execSync(`tasklist /FI "PID eq ${pid}" /NH 2>nul`, { stdio: 'pipe' }).toString();
    return output.includes(String(pid));
  } catch {
    return false;
  }
}

async function waitForExit(pid, timeoutMs = 30000) {
  if (!pid) return;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessRunning(parseInt(pid, 10))) {
      console.log('[updater-helper] Parent process exited');
      return;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  console.log('[updater-helper] Timeout waiting for parent exit, proceeding anyway');
}

// ── Run NSIS installer ─────────────────────────────────────────────────
async function runInstaller() {
  const targetDir = installDir || path.dirname(appPath);
  const nsisArgs = ['/S'];
  if (targetDir && !targetDir.toLowerCase().includes('temp')) {
    nsisArgs.push('/D=' + targetDir);
  }

  console.log('[updater-helper] Running NSIS installer with args:', nsisArgs.join(' '));
  sendProgress(10, 'Starting installer...');

  return new Promise((resolve, reject) => {
    const proc = spawn(installerPath, nsisArgs, {
      detached: false,
      stdio: 'ignore',
      windowsHide: false,
    });

    proc.on('error', reject);

    // Simulate progress while NSIS runs (NSIS /S is silent, no progress feedback)
    let progress = 10;
    const progressInterval = setInterval(() => {
      progress += Math.random() * 8 + 2;
      if (progress > 90) progress = 90;
      sendProgress(progress, 'Installing...');
    }, 800);

    proc.on('exit', (code) => {
      clearInterval(progressInterval);
      console.log('[updater-helper] Installer exited with code:', code);
      sendProgress(100, 'Installation complete');
      resolve(code);
    });

    // Safety timeout — if NSIS hangs, proceed anyway
    setTimeout(() => {
      clearInterval(progressInterval);
      resolve(0);
    }, 120000);
  });
}

// ── Relaunch app ───────────────────────────────────────────────────────
async function relaunchApp() {
  await new Promise(r => setTimeout(r, 1500));
  sendProgress(100, 'Launching application...');

  if (fs.existsSync(appPath)) {
    console.log('[updater-helper] Relaunching app...');
    spawn(appPath, [], { detached: true, stdio: 'ignore' }).unref();
  } else {
    console.error('[updater-helper] App not found at:', appPath);
  }
}

// ── Main flow ──────────────────────────────────────────────────────────
async function main() {
  try {
    // Wait for parent to exit first
    if (parentPid) {
      console.log('[updater-helper] Waiting for main app to exit...');
      await waitForExit(parentPid);
      // Extra delay for file handles to release
      await new Promise(r => setTimeout(r, 2000));
    }

    // NOW show the progress window — only for NSIS installation
    createProgressWindow();

    // Run installer
    await runInstaller();

    // Relaunch
    await relaunchApp();

    console.log('[updater-helper] Done.');
    await new Promise(r => setTimeout(r, 1000));
    app.quit();
  } catch (err) {
    console.error('[updater-helper] Error:', err.message);
    sendProgress(0, 'Error: ' + err.message);
    await new Promise(r => setTimeout(r, 3000));
    app.quit();
  }
}

// Electron app lifecycle
app.whenReady().then(() => {
  // Don't show dock icon on macOS
  if (app.dock) app.dock.hide();
  main();
});

app.on('window-all-closed', () => {
  // Keep running until we're done
});
