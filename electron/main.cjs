// CallerFlash — Electron main process
//
// Responsibilities:
//   • Create the single browser window that hosts the renderer (React UI).
//   • Own the Windows system-tray icon and its context menu.

// Build timestamp — use executable mtime as proxy for when the app was built
// This is used by the updater to compare against GitHub release dates
try {
  global.__APP_BUILD_TIMESTAMP__ = require('fs').statSync(process.execPath).mtimeMs;
} catch {
  global.__APP_BUILD_TIMESTAMP__ = Date.now();
}
//   • Bridge IPC calls from the sandboxed renderer (via preload.cjs).
//   • Persist the app across window-close events — only the tray "Quit"
//     entry actually terminates the process.

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, safeStorage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const sipClient = require('./sipClient.cjs');
const updater = require('./updater.cjs');

// Initialize secure file-based storage (registers IPC handlers)
require('./secureStorage.cjs');

// ── Single-instance lock ───────────────────────────────────────────────
// If a second copy is launched (double-click on the .exe again, etc.),
// focus the existing window instead of starting a duplicate.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
}

// Detect launch flags
const isStartMinimized = process.argv.includes('--start-minimized');

// Disable hardware acceleration for better compatibility in background apps
app.disableHardwareAcceleration();

// App user model ID — required on Windows so the tray icon, taskbar pin,
// and toast notifications all group under the same identity.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.callerflash.app');
}

// ── Module-level state ─────────────────────────────────────────────────
let mainWindow = null;
let tray = null;

// Cached SIP status from the renderer. Refreshed via the
// `tray:set-sip-status` IPC so the tray tooltip + menu label stay current.
let lastSipStatus = 'Offline';

// Pre-generated colored tray icons for each SIP state.
// Created at startup from the main cflogo icon with a colored overlay.
let trayIconDefault = null;
let trayIconGreen = null;
let trayIconYellow = null;
let trayIconRed = null;
let updateAvailableVersion = null;

// Set to true ONLY when the user explicitly chose Quit from the tray menu.
// Prevents the window `close` interceptor from trapping a real shutdown.
let isQuitting = false;

// ── Window State Management ────────────────────────────────────────────
const MAIN_WINDOW_DEFAULT = { x: null, y: null, width: 1000, height: 700 };

function mainWindowStatePath() {
  return path.join(app.getPath('userData'), 'main-window-state.json');
}

function loadMainWindowState() {
  try {
    const p = mainWindowStatePath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    // Corrupt or unreadable — fall through to defaults.
  }
  return null;
}

function saveMainWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const [x, y] = mainWindow.getPosition();
    const [w, h] = mainWindow.getSize();
    fs.writeFileSync(
      mainWindowStatePath(),
      JSON.stringify({ x, y, width: w, height: h }),
      'utf8'
    );
  } catch {
    // Don't crash the app over a state-write failure.
  }
}

// ── Window creation ────────────────────────────────────────────────────
function createWindow() {
  const state = { ...MAIN_WINDOW_DEFAULT, ...(loadMainWindowState() || {}) };
  
  const opts = {
    width: state.width,
    height: state.height,
    minWidth: 360,
    minHeight: 400,
    title: 'CallerFlash',
    icon: loadWindowIcon(),
    autoHideMenuBar: true,
    // Native Windows 11 styling hints
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#202020',
      symbolColor: '#ffffff',
      height: 36
    },
    // If the renderer opted in to "Start minimized", it will hide the window
    // itself a moment after load. We default to visible here so the
    // first-paint UI shows during boot.
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    }
  };

  // Only pass x/y when we actually have a saved position; otherwise
  // let Electron choose (center-ish on the primary display).
  if (Number.isFinite(state.x) && Number.isFinite(state.y)) {
    opts.x = state.x;
    opts.y = state.y;
  }

  mainWindow = new BrowserWindow(opts);

  // Load the single-file output from Vite
  mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));

  // Open external links in the default browser instead of inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (typeof url === 'string' && url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Intercept window-close events. The user can still trigger close via:
  //   • The renderer X button (calls `window:close` IPC → hideWindow())
  //   • Alt+F4 / real OS chrome → fires this `close` event
  //   • Right-click taskbar → Close → fires this `close` event
  // In every case we hide to the tray. The tray "Quit" menu sets
  // `isQuitting = true` so this interceptor lets the close through.
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      saveMainWindowState();
      mainWindow.hide();
      notifyRenderer('window:hidden-to-tray');
    } else {
      saveMainWindowState();
    }
  });

  // Persist position + size on move / resize so the window restores exactly
  // where the user left it, even if they never "close" the app gracefully.
  mainWindow.on('resize', saveMainWindowState);
  mainWindow.on('move', saveMainWindowState);
}

// ── Window icon (taskbar, titlebar, Alt+Tab) ────────────────────────
function loadWindowIcon() {
  // Use the CallerFlash ICO for consistency across taskbar, titlebar, Alt+Tab.
  // In a packaged build, extraResources copies icons directly into process.resourcesPath.
  // In asarUnpack mode they may also appear under resourcesPath/buildResources/.
  // In dev mode, they live in the source buildResources/ directory.
  const resPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  const candidates = [
    // Packaged: extraResources places app.ico / cflogo.ico at the resources root
    path.join(resPath, 'app.ico'),
    path.join(resPath, 'cflogo.ico'),
    // Packaged: asarUnpack may place them under buildResources/
    path.join(resPath, 'buildResources', 'app.ico'),
    path.join(resPath, 'buildResources', 'cflogo.ico'),
    // Dev mode: relative to the electron/ source directory
    path.join(__dirname, '..', 'buildResources', 'app.ico'),
    path.join(__dirname, '..', 'buildResources', 'cflogo.ico'),
  ];
  for (const iconPath of candidates) {
    try {
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) {
        console.log('[icon] Loaded window icon from:', iconPath);
        return img;
      }
    } catch { /* continue */ }
  }
  console.warn('[icon] No window icon found, using empty image');
  return nativeImage.createEmpty();
}

// ── Tray icon + menu ───────────────────────────────────────────────────
function loadTrayIcon() {
  // Tray-specific icon (transparent background). In a packaged build the
  // buildResources/ directory is NOT inside app.asar — extraResources copies the
  // files into process.resourcesPath. Try the packaged location first,
  // then fall back to the source-tree location (dev mode).
  const resPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  const candidates = [
    // Packaged: extraResources places icons at the resources root
    path.join(resPath, 'cflogo.ico'),
    path.join(resPath, 'cflogo.png'),
    // Packaged: asarUnpack may place them under buildResources/
    path.join(resPath, 'buildResources', 'cflogo.ico'),
    path.join(resPath, 'buildResources', 'cflogo.png'),
    path.join(resPath, 'buildResources', 'tray-icon.png'),
    // Dev mode: relative to the electron/ source directory
    path.join(__dirname, '..', 'buildResources', 'cflogo.ico'),
    path.join(__dirname, '..', 'buildResources', 'cflogo.png'),
    path.join(__dirname, '..', 'buildResources', 'tray-icon.png'),
  ];
  for (const iconPath of candidates) {
    try {
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) {
        console.log('[icon] Loaded tray icon from:', iconPath);
        return img;
      }
    } catch {
      // Continue to next candidate
    }
  }
  console.warn('[icon] No tray icon found, using empty image');
  // Last-resort: empty image. The tray will still appear but without art.
  return nativeImage.createEmpty();
}

function refreshTrayMenu() {
  if (!tray) return;
  const items = [
    {
      label: 'Show CallerFlash',
      click: () => showWindow(),
    },
    {
      label: 'Hide to Tray',
      click: () => hideWindow(),
    },
    { type: 'separator' },
    {
      label: `SIP: ${lastSipStatus}`,
      enabled: false, // Status indicator only — not interactive
    },
  ];

  if (updateAvailableVersion) {
    const cleanVer = updateAvailableVersion.replace(/^v/, '').replace(/^0\.0\.0-/, '');
    items.push({ type: 'separator' });
    items.push({
      label: `⬆ Update available: ${cleanVer}`,
      click: () => {
        showWindow();
        // Tell the renderer to navigate to the Updates tab.
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('navigate-to-update');
        }
      },
    });
  }

  items.push({ type: 'separator' });
  items.push({
    label: 'Quit CallerFlash',
    click: () => {
      isQuitting = true;
      app.quit();
    },
  });

  const menu = Menu.buildFromTemplate(items);
  tray.setContextMenu(menu);
  const tip = updateAvailableVersion
    ? `CallerFlash — SIP ${lastSipStatus} · Update ${updateAvailableVersion.replace(/^v/, '').replace(/^0\.0\.0-/, '')} available`
    : `CallerFlash — SIP ${lastSipStatus}`;
  tray.setToolTip(tip);
}

function createTray() {
  trayIconDefault = loadTrayIcon();
  tray = new Tray(trayIconDefault);

  // Pre-generate icon variants with a status dot in the top-right corner.
  // The base icon is kept exactly as-is (transparent background preserved).
  // A small solid circle is drawn in the top-right corner for SIP status.
  const size = 32;
  const baseBuf = trayIconDefault.resize({ width: size, height: size }).toBitmap();

  function makeStatusIcon(cr, cg, cb) {
    // nativeImage.createFromBuffer expects BGRA pixel format.
    // Start with a copy of the base icon.
    const buf = Buffer.from(baseBuf);

    // Draw a solid colored circle in the top-right corner.
    const dotCx = size - 6; // 6px from right edge
    const dotCy = 6;        // 6px from top edge
    const dotR = 5;         // radius

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - dotCx;
        const dy = y - dotCy;
        if (dx * dx + dy * dy <= dotR * dotR) {
          const i = (y * size + x) * 4;
          buf[i]     = cb; // B
          buf[i + 1] = cg; // G
          buf[i + 2] = cr; // R
          buf[i + 3] = 255; // A (fully opaque)
        }
      }
    }

    return nativeImage.createFromBuffer(buf, { width: size, height: size });
  }

  // Green = registered, Yellow = connecting, Red = offline
  trayIconGreen  = makeStatusIcon(0x6c, 0xcb, 0x5f); // #6ccb5f
  trayIconYellow = makeStatusIcon(0xfc, 0xb8, 0x27); // #fcb827
  trayIconRed    = makeStatusIcon(0xff, 0x6b, 0x6b); // #ff6b6b

  // Windows convention: single left-click toggles window visibility.
  // Double-click is also accepted as a convenience for users who expect it.
  tray.on('click', () => toggleWindow());
  tray.on('double-click', () => showWindow());

  refreshTrayMenu();
}

// ── Window visibility helpers ──────────────────────────────────────────
function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  notifyRenderer('window:restored-from-tray');
}

function hideWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
    notifyRenderer('window:hidden-to-tray');
  }
}

function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const visible = mainWindow.isVisible() && !mainWindow.isMinimized();
  if (visible) hideWindow();
  else showWindow();
}

// ── IPC: SIP Engine (Real network backend) ─────────────────────────────
ipcMain.handle('sip:connect', async (_event, config) => {
  return new Promise((resolve) => {
    sipClient.connect(config, {
      onConnected: () => {
        // TCP/UDP socket bound
      },
      onRegistered: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('sip:status', { status: 'registered' });
        }
        resolve({ success: true });
      },
      onError: (message) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('sip:status', { status: 'error', message });
        }
        resolve({ success: false, message });
      },
      onLog: (message) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('sip:log', { message });
        }
      },
      onInvite: (callerData) => {
        // Incoming call hit the wire! Trigger toast.
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('sip:invite', callerData);
        }
      }
    });
  });
});

ipcMain.handle('sip:disconnect', async () => {
  sipClient.disconnect();
  return { success: true };
});

// Send an event to the renderer so it can keep its UI in sync
// (e.g., swap MinimizedShell for the full UI when restored from tray).
function notifyRenderer(channel) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel);
  }
}

// ── IPC: window controls ───────────────────────────────────────────────
ipcMain.on('window:minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.minimize();
  }
});

ipcMain.on('window:maximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});

ipcMain.on('window:close', () => hideWindow());
ipcMain.on('window:hide-to-tray', () => hideWindow());
ipcMain.on('window:show', () => showWindow());
// ── Toast window (separate frameless BrowserWindow) ─────────────
// A dedicated always-on-top, transparent, frameless window that
// renders incoming-call alerts. Lives independently of the main
// window so toasts still appear when the main app is hidden to the
// tray.
//
// Design: data is passed via URL hash to a standalone HTML file.
// This avoids IPC entirely — no nodeIntegration, no contextBridge,
// no race conditions with renderer readiness. The HTML file reads
// its own URL hash and renders immediately.
let toastWindow = null;

const TOAST_DEFAULT = { x: null, y: null, width: 380, height: 150 };

function toastStatePath() {
  return path.join(app.getPath('userData'), 'toast-window-state.json');
}

function loadToastState() {
  try {
    const p = toastStatePath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    // Corrupt or unreadable — fall through to defaults.
  }
  return null;
}

function saveToastState() {
  if (!toastWindow || toastWindow.isDestroyed()) return;
  try {
    const [x, y] = toastWindow.getPosition();
    const [w, h] = toastWindow.getSize();
    fs.writeFileSync(
      toastStatePath(),
      JSON.stringify({ x, y, width: w, height: h }),
      'utf8'
    );
  } catch {
    // Don't crash the app over a state-write failure.
  }
}

/**
 * Build the toast URL with data encoded in the hash fragment.
 * The toast.html file reads window.location.hash to get its data.
 */
function buildToastUrl(data) {
  const c = data.config || {};
  const params = new URLSearchParams();
  if (data.callerNumber) params.set('callerNumber', data.callerNumber);
  if (data.callerName) params.set('callerName', data.callerName);
  if (data.timestamp) params.set('timestamp', data.timestamp);
  if (c.duration) params.set('duration', String(c.duration));
  if (c.backgroundColor) params.set('bgColor', c.backgroundColor);
  if (c.accentColor) params.set('accentColor', c.accentColor);
  if (c.textColor) params.set('textColor', c.textColor);
  if (c.borderRadius != null) params.set('borderRadius', String(c.borderRadius));
  if (c.opacity != null) params.set('opacity', String(c.opacity));

  const htmlPath = path.join(__dirname, 'toast.html');
  const hash = '#' + params.toString();
  // Use file:// URL with hash — the HTML file reads the hash on load
  return 'file:///' + htmlPath.replace(/\\/g, '/') + hash;
}

function createToastWindow(data) {
  // Always create a fresh window for each toast so the URL (with new data) loads cleanly.
  // Destroy any existing toast window first.
  if (toastWindow && !toastWindow.isDestroyed()) {
    try { toastWindow.destroy(); } catch { /* noop */ }
    toastWindow = null;
  }

  const state = { ...TOAST_DEFAULT, ...(loadToastState() || {}) };
  const opts = {
    width: state.width,
    height: state.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    // No preload, no nodeIntegration — pure static HTML
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  };

  // Position at top-right corner of the primary display (or saved position).
  if (Number.isFinite(state.x) && Number.isFinite(state.y)) {
    opts.x = state.x;
    opts.y = state.y;
  } else {
    const { screen } = require('electron');
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenW } = primaryDisplay.workArea;
    opts.x = screenW - opts.width - 16;
    opts.y = 16;
  }

  toastWindow = new BrowserWindow(opts);

  // Load the standalone HTML file with data in URL hash
  const url = buildToastUrl(data || {});
  toastWindow.loadURL(url);

  toastWindow.setMenuBarVisibility(false);

  // Use 'screen-saver' level — the highest always-on-top level in Electron.
  // This ensures the toast stays above ALL other windows including other
  // always-on-top windows, task manager, etc.
  toastWindow.setAlwaysOnTop(true, 'screen-saver');
  // Make visible on ALL workspaces/virtual desktops including full-screen apps
  toastWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Show the window once the content is loaded
  toastWindow.webContents.on('did-finish-load', () => {
    log('[toast] did-finish-load fired');
    // Bring the window to front — critical on Windows where alwaysOnTop
    // alone may not be enough to make a hidden window visible.
    if (toastWindow && !toastWindow.isDestroyed()) {
      toastWindow.show();
      toastWindow.moveTop();
      log('[toast] window shown at', toastWindow.getPosition());
    }
  });

  // Safety: show after a short timeout even if did-finish-load races
  setTimeout(() => {
    if (toastWindow && !toastWindow.isDestroyed() && !toastWindow.isVisible()) {
      log('[toast] safety timeout: forcing show');
      toastWindow.show();
      toastWindow.moveTop();
    }
  }, 200);

  // Debug: log if load fails
  toastWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription) => {
    log('[toast] LOAD FAILED:', errorCode, errorDescription);
  });

  // Persist position + size on every move / resize
  toastWindow.on('move', saveToastState);
  toastWindow.on('resize', saveToastState);

  return toastWindow;
}

ipcMain.on('toast:show', (_event, data) => {
  log('[toast] toast:show received, data:', JSON.stringify(data || {}).substring(0, 100));
  createToastWindow(data);
});

ipcMain.on('toast:hide', () => {
  if (toastWindow && !toastWindow.isDestroyed() && toastWindow.isVisible()) {
    toastWindow.hide();
  }
});

ipcMain.on('toast:set-position', (_event, x, y) => {
  if (!toastWindow || toastWindow.isDestroyed()) return;
  if (typeof x !== 'number' || typeof y !== 'number') return;
  toastWindow.setPosition(Math.round(x), Math.round(y));
  saveToastState();
});

ipcMain.handle('toast:get-position', () => {
  if (!toastWindow || toastWindow.isDestroyed()) return null;
  return toastWindow.getPosition();
});

// ── IPC: shell link opening (mirror of preload bridge) ─────────────────
ipcMain.on('shell:open-external', (_event, url) => {
  if (typeof url === 'string' && url.startsWith('https:')) {
    shell.openExternal(url);
  }
});

// ── IPC: system notifications (triggers a native OS toast) ─────────────
// Used by the renderer when an update is verified + downloaded to let
// the user know via the OS notification surface, in addition to the
// tray menu.
ipcMain.on('notify:show', (_event, title, body) => {
  console.log('[notify] received:', title, body?.substring(0, 50));
  if (!app.isReady()) return;

  const safeTitle = typeof title === 'string' ? title.slice(0, 120) : 'CallerFlash';
  const safeBody = typeof body === 'string' ? body.slice(0, 240) : '';

  // Check if native notifications are supported
  if (Notification?.isSupported?.()) {
    try {
      const n = new Notification({
        title: safeTitle,
        body: safeBody,
        silent: false,
      });
      n.show();
      console.log('[notify] native notification shown');
      n.on('click', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          if (!mainWindow.isVisible()) mainWindow.show();
          mainWindow.focus();
        }
      });
      return;
    } catch (err) {
      console.error('[notify] native notification failed:', err.message);
    }
  }

  // Fallback: use the tray balloon if available (Windows)
  if (tray && !tray.isDestroyed()) {
    try {
      tray.displayBalloon({
        title: safeTitle,
        content: safeBody,
        iconType: 'info',
      });
      console.log('[notify] tray balloon shown');
    } catch (err) {
      console.error('[notify] tray balloon failed:', err.message);
    }
  }
});

// ── IPC: safeStorage (DPAPI on Windows) ────────────────────────────────
// Wraps the main-process safeStorage API for the sandboxed renderer.
ipcMain.handle('safe-storage:encrypt', async (_event, plaintext) => {
  if (typeof plaintext !== 'string' || plaintext.length === 0) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const buf = safeStorage.encryptString(plaintext);
    return buf.toString('base64');
  } catch {
    return null;
  }
});

ipcMain.handle('safe-storage:decrypt', async (_event, base64Cipher) => {
  if (typeof base64Cipher !== 'string' || base64Cipher.length === 0) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const buf = Buffer.from(base64Cipher, 'base64');
    return safeStorage.decryptString(buf);
  } catch {
    return null;
  }
});

// ── IPC: updater (electron-updater) ─────────────────────────────────
// All update logic is delegated to updater.cjs which uses electron-updater
// for download → verify → install → relaunch lifecycle.
// NOTE: initUpdaterIPC is called inside app.whenReady() AFTER createWindow()
// so that mainWindowRef is set correctly. See line ~860.

// ── IPC: "Start with Windows" ────────────────────────────────────────
// Wire the renderer's toggle to Electron's login-item API so the OS
// actually launches CallerFlash at sign-in. Uses the user's choice of
// start-minimized so the app can boot straight to the tray.
ipcMain.on('app:set-start-with-windows', (_event, enabled) => {
  if (process.platform !== 'win32') return;
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      args: enabled && appPreferencesStartMinimized ? ['--start-minimized'] : [],
    });
  } catch (err) {
    console.error('[app] setLoginItemSettings failed:', err.message);
  }
});

// Track the current start-minimized preference so the login-item args
// stay in sync when the user toggles "Start minimized" independently.
let appPreferencesStartMinimized = false;

ipcMain.on('app:set-start-minimized', (_event, enabled) => {
  appPreferencesStartMinimized = !!enabled;
  // If "Start with Windows" is already enabled, update the login-item
  // args so the next boot honors the new minimized setting.
  try {
    app.setLoginItemSettings({
      openAtLogin: app.getLoginItemSettings().openAtLogin,
      args: app.getLoginItemSettings().openAtLogin && enabled ? ['--start-minimized'] : [],
    });
  } catch (err) {
    console.error('[app] setLoginItemSettings failed:', err.message);
  }
});

// ── IPC: tray status sync ──────────────────────────────────────────────
// Renderer pushes the current SIP status string so the tray tooltip
// and "SIP: …" menu label reflect reality.
ipcMain.on('tray:set-sip-status', (_event, status) => {
  if (typeof status === 'string' && status.length > 0 && status.length < 64) {
    lastSipStatus = status;
    refreshTrayMenu();
    // Swap tray icon color to reflect SIP state.
    if (tray && !tray.isDestroyed()) {
      const icon = status === 'Registered' ? trayIconGreen
        : status === 'Connecting' ? trayIconYellow
        : trayIconRed;
      if (icon && !icon.isEmpty()) tray.setImage(icon);
    }
  }
});

// Renderer pushes update availability so the tray can show it.
ipcMain.on('tray:set-update-available', (_event, version) => {
  updateAvailableVersion = (typeof version === 'string' && version.length > 0) ? version : null;
  refreshTrayMenu();
});

// ── Second-instance handler ────────────────────────────────────────────
app.on('second-instance', () => showWindow());

// ── Startup update check ─────────────────────────────────────────────
// Runs an automatic update check on every app launch, respecting the
// user's frequency preference (daily/weekly/monthly/off). The renderer
// persists the last-checked timestamp + frequency to localStorage;
// we read it here and decide whether to fire a check now.
const UI_STORAGE_KEY = 'callerflash-ui-settings';

function readPersistedSettings() {
  try {
    const p = path.join(app.getPath('userData'), 'callerflash-ui-settings.json');
    // Primary location: userData (survives in-app updates).
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { /* ignore */ }
  // Fallback: localStorage is mirrored to a file by the renderer, but
  // if we can't read it we just let the renderer handle the check.
  return {};
}

function shouldAutoCheck(lastCheckedAt, frequency) {
  if (!frequency || frequency === 'off') return false;
  const intervalDays = { daily: 1, weekly: 7, monthly: 30 }[frequency] ?? 1;
  if (!lastCheckedAt) return true;
  const ageDays = (Date.now() - new Date(lastCheckedAt).getTime()) / 86_400_000;
  return ageDays >= intervalDays;
}

async function scheduleStartupUpdateCheck() {
  // Defer until the renderer has mounted and the IPC bridge is live.
  setTimeout(async () => {
    try {
      const settings = readPersistedSettings();
      const lastChecked = settings.lastCheckedAt ? new Date(settings.lastCheckedAt) : null;
      const frequency = settings.updateCheckFrequency || 'daily';
      if (!shouldAutoCheck(lastChecked, frequency)) return;

      const channel = settings.updateChannel || 'stable';
      const autoDownloadEnabled = settings.autoDownload !== false; // default true

      // Do the check + auto-download in the main process (no UI)
      console.log('[updater] startup check: channel=' + channel + ' autoDownload=' + autoDownloadEnabled);
      const result = await updater.checkForUpdates(channel);

      if (result?.version && result.downloadUrl) {
        console.log('[updater] startup: update found:', result.version);
        // Notify renderer about available update
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('updater:status', {
            status: 'update-available',
            version: result.version,
            friendlyName: result.friendlyName,
            downloadUrl: result.downloadUrl,
          });
        }

        // Auto-download in background if enabled
        if (autoDownloadEnabled) {
          console.log('[updater] startup: auto-downloading update...');
          await updater.downloadUpdate(channel, result.version, result.downloadUrl);
          // Notify renderer that download is complete
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('updater:status', {
              status: 'ready',
              version: result.version,
            });
          }
        }
      } else {
        console.log('[updater] startup: up to date');
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('updater:status', { status: 'up-to-date' });
        }
      }
    } catch (err) {
      console.error('[updater] startup check failed:', err.message);
    }
  }, 3000); // 3s delay lets the renderer fully hydrate SIP + store
}

// ── App lifecycle ──────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  createTray();

  // Initialize updater IPC handlers AFTER mainWindow exists so that
  // sendStatus/sendProgress can deliver events to the renderer.
  updater.initUpdaterIPC(mainWindow);

  // Schedule an automatic update check on every app launch
  // the user's frequency preference stored in localStorage). This runs
  // regardless of which tab the renderer lands on — the user doesn't
  // need to open the Updates tab to stay current.
  scheduleStartupUpdateCheck();

  // If launched with --start-minimized (from the Windows login item),
  // hide the window immediately so the user sees only the tray icon.
  if (isStartMinimized) {
    appPreferencesStartMinimized = true;
    // Defer one tick so the renderer can mount before we hide.
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.hide();
        notifyRenderer('window:hidden-to-tray');
      }
    }, 200);
  }

  app.on('activate', () => {
    // macOS: re-create the window when the dock icon is clicked.
    // On Windows this is a no-op unless both window and tray were lost.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      createTray();
    }
  });
});

// IMPORTANT: do NOT quit on window-all-closed. The tray keeps the app
// alive in the background so SIP registration and call detection
// continue running. The tray "Quit CallerFlash" menu is the only
// legitimate exit path.
app.on('window-all-closed', () => {
  // Intentionally empty — see comment above.
});

app.on('before-quit', () => {
  isQuitting = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
});
