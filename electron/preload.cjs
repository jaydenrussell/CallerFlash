// CallerFlash — Preload (runs in isolated context, bridges main ↔ renderer)
// Only exposes the MINIMUM surface to the renderer via contextBridge.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('callerflash', {
  // ── Window controls ─────────────────────────────────────────────
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    hideToTray: () => ipcRenderer.send('window:hide-to-tray'),
    show: () => ipcRenderer.send('window:show'),
    // Subscribe to events pushed from main when the tray restores or
    // re-hides the window. Returns an unsubscribe function.
    onRestoredFromTray: (callback) => {
      const handler = () => callback();
      ipcRenderer.on('window:restored-from-tray', handler);
      return () => ipcRenderer.removeListener('window:restored-from-tray', handler);
    },
    onHiddenToTray: (callback) => {
      const handler = () => callback();
      ipcRenderer.on('window:hidden-to-tray', handler);
      return () => ipcRenderer.removeListener('window:hidden-to-tray', handler);
    },
    /** Subscribe to tray "navigate to updates" click. Returns an unsubscribe fn. */
    onNavigateToUpdate: (callback) => {
      const handler = () => callback();
      ipcRenderer.on('navigate-to-update', handler);
      return () => ipcRenderer.removeListener('navigate-to-update', handler);
    },
  },

  // ── Tray sync ───────────────────────────────────────────────────
  // Push the current SIP status label to main so the tray tooltip
  // and "SIP: …" menu item reflect reality (Connected / Registered / Offline).
  tray: {
    setSipStatus: (status) => ipcRenderer.send('tray:set-sip-status', status),
    setUpdateAvailable: (version) => ipcRenderer.send('tray:set-update-available', version),
  },

  // ── Secure credential storage (DPAPI) ───────────────────────────
  safeStorage: {
    encrypt: (plaintext) => ipcRenderer.invoke('safe-storage:encrypt', plaintext),
    decrypt: (base64Cipher) => ipcRenderer.invoke('safe-storage:decrypt', base64Cipher),
  },

  // ── External links (gated by allow-list in main) ────────────────
  shell: {
    openExternal: (url) => ipcRenderer.send('shell:open-external', url),
  },

  // ── System notifications (Electron-only) ──────────────────────
  // In the production build, shows a native OS notification. In the
  // web demo, this is a no-op (the renderer swallows the call).
  notify: {
    show: (title, body) => ipcRenderer.send('notify:show', title, body),
  },

  // ── Toast window (separate frameless BrowserWindow) ───────────
  // Used by the main renderer to display incoming-call alerts in a
  // dedicated always-on-top window that survives the main window
  // being hidden to the tray. Only meaningful in the Electron build;
  // every method is a no-op in the web demo.
  toast: {
    show: (data) => ipcRenderer.send('toast:show', data),
    hide: () => ipcRenderer.send('toast:hide'),
    setPosition: (x, y) => ipcRenderer.send('toast:set-position', x, y),
    getPosition: () => ipcRenderer.invoke('toast:get-position'),
    onShow: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('toast:show:event', handler);
      return () => ipcRenderer.removeListener('toast:show:event', handler);
    },
  },

  // ── Auto-updater (custom) ────────────────────────────────────────
  updater: {
    check: (channel) => ipcRenderer.invoke('updater:check', channel),
    download: (channel, version, downloadUrl) => ipcRenderer.send('updater:download', { channel, version, downloadUrl }),
    install: (version) => ipcRenderer.send('updater:install', { version }),
    show: () => ipcRenderer.send('updater:show'),
    setChannel: (channel) => ipcRenderer.send('updater:set-channel', channel),
    getDownloadState: () => ipcRenderer.invoke('updater:getDownloadState'),
    onStatus: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('updater:status', handler);
      return () => ipcRenderer.removeListener('updater:status', handler);
    },
    onProgress: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('updater:progress', handler);
      return () => ipcRenderer.removeListener('updater:progress', handler);
    },
    onBackgroundCheck: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('updater:background-check', handler);
      return () => ipcRenderer.removeListener('updater:background-check', handler);
    },
  },

  // ── SIP Engine ──────────────────────────────────────────────────
  sip: {
    connect: (config) => ipcRenderer.invoke('sip:connect', config),
    disconnect: () => ipcRenderer.invoke('sip:disconnect'),
    onStatus: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('sip:status', handler);
      return () => ipcRenderer.removeListener('sip:status', handler);
    },
    onLog: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('sip:log', handler);
      return () => ipcRenderer.removeListener('sip:log', handler);
    },
    onInvite: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('sip:invite', handler);
      return () => ipcRenderer.removeListener('sip:invite', handler);
    },
  },

  // ── Platform info ───────────────────────────────────────────────
  platform: {
    isElectron: true,
    arch: process.arch,
    version: process.env.npm_package_version || '0.0.0',
  },

  // ── Secure storage (file-based, survives app updates) ───────────
  storage: {
    load: () => ipcRenderer.invoke('storage:load'),
    save: (data) => ipcRenderer.invoke('storage:save', data),
  },

  // ── App lifecycle controls ──────────────────────────────────────
  app: {
    setStartWithWindows: (enabled) => ipcRenderer.send('app:set-start-with-windows', enabled),
    setStartMinimized: (enabled) => ipcRenderer.send('app:set-start-minimized', enabled),
  },
});
