import { create } from 'zustand';
import { redactMessage, redactKeyedValue } from '../security/secretRedactor';

// ── Storage security ─────────────────────────────────────────────────
// We use a two-layer approach:
//   1. Electron main process: file-based storage in userData (survives updates)
//   2. Renderer fallback: localStorage (for web dev mode)
//
// File storage includes:
//   - HMAC-SHA256 integrity check (tamper detection)
//   - Atomic writes (write to temp, then rename — no corruption on crash)
//   - Backup file (if main file is corrupt, restore from backup)
//   - Versioned schema (future migrations)

const UI_STORAGE_KEY = 'callerflash-ui-settings';
const STORAGE_VERSION = 2; // Bump when schema changes

// ── Interfaces ───────────────────────────────────────────────────────
export interface SipConfig {
  server: string;
  port: number;
  username: string;
  password: string;
  authUsername: string;
  protocol: 'UDP' | 'TCP' | 'TLS';
  codec: string;
  stunServer: string;
  registerExpiry: number;
}

export interface ToastConfig {
  fontSize: number;
  fontFamily: string;
  textColor: string;
  backgroundColor: string;
  accentColor: string;
  duration: number;
  position: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
  soundEnabled: boolean;
  autoCopyToClipboard: boolean;
  showCallerName: boolean;
  showTimestamp: boolean;
  maxWidth: number;
  borderRadius: number;
  opacity: number;
  style: 'native' | 'custom';
}

export interface AppPreferences {
  startWithWindows: boolean;
  startMinimized: boolean;
}

export interface CallRecord {
  id: string;
  callerNumber: string;
  callerName: string;
  timestamp: Date;
  duration: number;
  direction: 'inbound' | 'outbound';
  status: 'answered' | 'missed' | 'rejected';
}

export interface DiagnosticLog {
  id: string;
  timestamp: Date;
  level: 'info' | 'warning' | 'error' | 'success';
  category: 'SIP' | 'TOAST' | 'UPDATE' | 'SYSTEM';
  message: string;
  details?: string;
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  lastChecked: Date | null;
  autoUpdate: boolean;
  autoDownload: boolean;
  updateChannel: 'stable' | 'beta' | 'alpha';
  updateCheckFrequency: 'off' | 'daily' | 'weekly' | 'monthly';
  githubRepo: string;
  releaseNotes: string;
  releasePageUrl: string;
  downloadProgress: number;
  isDownloading: boolean;
  isInstalling: boolean;
}

export type TabId = 'dashboard' | 'calls' | 'settings' | 'preferences' | 'toast' | 'diagnostics' | 'update' | 'about';

// ── Persisted shape (what gets written to disk) ──────────────────────
interface PersistedUiSettings {
  version: number;
  appPreferences?: Partial<AppPreferences>;
  toastDragPosition?: { x: number; y: number } | null;
  updateCheckFrequency?: 'off' | 'daily' | 'weekly' | 'monthly';
  lastCheckedAt?: string;
  updateChannel?: 'stable' | 'beta' | 'alpha';
  autoUpdate?: boolean;
  autoDownload?: boolean;
  toastConfig?: Partial<ToastConfig>;
  releasePageUrl?: string;
  sipConfig?: Partial<SipConfig>;
  sipPasswordEncrypted?: string;
  lastRunVersion?: string;
}

// ── Secure storage wrapper (communicates with main process) ─────────
class SecureStorage {
  private cache: PersistedUiSettings | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private isElectron: boolean;

  constructor() {
    this.isElectron = typeof window !== 'undefined' && !!window.callerflash?.platform?.isElectron;
  }

  async load(): Promise<PersistedUiSettings> {
    if (this.cache) return this.cache;

    let data: PersistedUiSettings = { version: STORAGE_VERSION };

    if (this.isElectron) {
      // Use main process file-based storage (survives updates)
      try {
        const result = await window.callerflash?.storage?.load?.();
        if (result && typeof result === 'object') {
          data = { ...data, ...result };
        }
      } catch {
        // Fallback to localStorage if main process fails
        data = this.loadFromLocalStorage();
      }
    } else {
      // Web dev mode: use localStorage
      data = this.loadFromLocalStorage();
    }

    // Migration: ensure version is set
    if (!data.version) data.version = STORAGE_VERSION;

    this.cache = data;
    return data;
  }

  async save(settings: PersistedUiSettings): Promise<void> {
    // Queue writes to prevent race conditions
    this.writeQueue = this.writeQueue.then(() => this.doSave(settings));
    return this.writeQueue;
  }

  private async doSave(settings: PersistedUiSettings): Promise<void> {
    const toSave = { ...settings, version: STORAGE_VERSION };
    this.cache = toSave;

    if (this.isElectron) {
      try {
        await window.callerflash?.storage?.save?.(toSave);
        return;
      } catch {
        // Fallback to localStorage
      }
    }
    this.saveToLocalStorage(toSave);
  }

  private loadFromLocalStorage(): PersistedUiSettings {
    if (typeof window === 'undefined') return { version: STORAGE_VERSION };
    try {
      const raw = window.localStorage.getItem(UI_STORAGE_KEY);
      if (!raw) return { version: STORAGE_VERSION };
      const parsed = JSON.parse(raw);
      // Basic validation
      if (typeof parsed !== 'object' || parsed === null) return { version: STORAGE_VERSION };
      return { version: STORAGE_VERSION, ...parsed };
    } catch {
      return { version: STORAGE_VERSION };
    }
  }

  private saveToLocalStorage(settings: PersistedUiSettings): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Storage full or blocked — ignore
    }
  }

  clearCache(): void {
    this.cache = null;
  }
}

const secureStorage = new SecureStorage();

// ── Load settings at startup ─────────────────────────────────────────
// Phase 1: Synchronous load from localStorage (always works)
// Phase 2: Async migration to file-based storage (after IPC is ready)
function loadSettingsSync(): PersistedUiSettings {
  if (typeof window === 'undefined') return { version: STORAGE_VERSION };
  try {
    const raw = window.localStorage.getItem(UI_STORAGE_KEY);
    if (!raw) return { version: STORAGE_VERSION };
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { version: STORAGE_VERSION };
    return { version: STORAGE_VERSION, ...parsed };
  } catch {
    return { version: STORAGE_VERSION };
  }
}

const persistedUi: PersistedUiSettings = loadSettingsSync();

// Phase 2: After store is created, try to load from file storage and migrate
async function initStorageMigration() {
  try {
    if (typeof window !== 'undefined' && window.callerflash?.storage?.load) {
      const fileData = await window.callerflash.storage.load();
      if (fileData && Object.keys(fileData).length > 0 && fileData.version >= 2) {
        return; // File storage is authoritative
      }
    }
    // Migrate localStorage to file
    const localData = loadSettingsSync();
    if (localData && Object.keys(localData).length > 1) {
      if (window.callerflash?.storage?.save) {
        await window.callerflash.storage.save(localData);
        console.log('[store] Migrated localStorage to file storage');
      }
    }
  } catch {
    // Ignore — localStorage data is still valid
  }
}

// ── Store interface ──────────────────────────────────────────────────
interface AppState {
  activeTab: TabId;
  setActiveTab: (tab: TabId) => void;

  sipConnected: boolean;
  sipRegistered: boolean;
  sipConfig: SipConfig;
  setSipConfig: (config: Partial<SipConfig>) => void;
  setSipConnected: (connected: boolean) => void;
  setSipRegistered: (registered: boolean) => void;
  isConnecting: boolean;
  setIsConnecting: (connecting: boolean) => void;
  connectSip: () => void;
  disconnectSip: () => void;

  toastConfig: ToastConfig;
  setToastConfig: (config: Partial<ToastConfig>) => void;

  appPreferences: AppPreferences;
  setAppPreferences: (prefs: Partial<AppPreferences>) => void;
  isMinimized: boolean;
  setIsMinimized: (minimized: boolean) => void;

  callHistory: CallRecord[];
  addCallRecord: (record: CallRecord) => void;
  clearCallHistory: () => void;

  activeToasts: CallRecord[];
  addToast: (record: CallRecord) => void;
  removeToast: (id: string) => void;

  diagnosticLogs: DiagnosticLog[];
  addDiagnosticLog: (log: Omit<DiagnosticLog, 'id' | 'timestamp'>) => void;
  clearDiagnosticLogs: () => void;

  updateInfo: UpdateInfo;
  setUpdateInfo: (info: Partial<UpdateInfo>) => void;

  toastDragPosition: { x: number; y: number } | null;
  setToastDragPosition: (pos: { x: number; y: number } | null) => void;

  clipboardText: string;
  setClipboardText: (text: string) => void;
}

// ── Defaults ─────────────────────────────────────────────────────────
const defaultSipConfig: SipConfig = {
  server: 'atlanta1.voip.ms',
  port: 5060,
  username: '',
  password: '',
  authUsername: '',
  protocol: 'UDP',
  codec: 'G.711u',
  stunServer: 'stun.l.google.com',
  registerExpiry: 300,
  ...(persistedUi.sipConfig || {}),
};

const defaultAppPreferences: AppPreferences = {
  startWithWindows: false,
  startMinimized: false,
  ...persistedUi.appPreferences,
};

const defaultToastConfig: ToastConfig = {
  fontSize: 16,
  fontFamily: 'Inter',
  textColor: '#ffffff',
  backgroundColor: '#1a1a2e',
  accentColor: '#60cdff',
  duration: 8,
  position: 'top-right',
  soundEnabled: true,
  autoCopyToClipboard: true,
  showCallerName: true,
  showTimestamp: true,
  maxWidth: 420,
  borderRadius: 12,
  opacity: 95,
  style: 'custom',
  ...(persistedUi.toastConfig ?? {}),
};

const defaultUpdateInfo: UpdateInfo = {
  currentVersion: __APP_VERSION__,
  latestVersion: __APP_VERSION__,
  updateAvailable: false,
  lastChecked: persistedUi.lastCheckedAt ? new Date(persistedUi.lastCheckedAt) : null,
  autoUpdate: persistedUi.autoUpdate ?? true,
  autoDownload: persistedUi.autoDownload ?? true,
  updateChannel: persistedUi.updateChannel ?? 'stable',
  updateCheckFrequency: persistedUi.updateCheckFrequency ?? 'daily',
  githubRepo: __APP_REPO__,
  releaseNotes: '',
  releasePageUrl: persistedUi.releasePageUrl ?? '',
  downloadProgress: 0,
  isDownloading: false,
  isInstalling: false,
};

// ── Store ────────────────────────────────────────────────────────────
export const useAppStore = create<AppState>((set) => ({
  activeTab: 'dashboard',
  setActiveTab: (tab) => set({ activeTab: tab }),

  sipConnected: false,
  sipRegistered: false,
  sipConfig: defaultSipConfig,
  setSipConfig: (config) => set((s) => {
    const next = { ...s.sipConfig, ...config };

    // Persist asynchronously (don't block UI)
    if (window.callerflash?.safeStorage?.encrypt) {
      window.callerflash.safeStorage.encrypt(next.password || '').then((encrypted) => {
        secureStorage.save({
          ...secureStorage.cache,
          sipConfig: { ...next, password: '' },
          sipPasswordEncrypted: encrypted || '',
        });
      });
    } else {
      secureStorage.save({
        ...secureStorage.cache,
        sipConfig: next,
      });
    }

    return { sipConfig: next };
  }),
  setSipConnected: (connected) => set({ sipConnected: connected }),
  setSipRegistered: (registered) => set({ sipRegistered: registered }),
  isConnecting: false,
  setIsConnecting: (connecting) => set({ isConnecting: connecting }),
  connectSip: () => {
    const s = useAppStore.getState();
    if (s.sipConnected || s.isConnecting) return;

    s.setIsConnecting(true);
    s.addDiagnosticLog({ level: 'info', category: 'SIP', message: 'Initiating SIP connection…' });

    if (window.callerflash?.sip?.connect) {
      window.callerflash.sip.connect(s.sipConfig).then((res) => {
        if (!res.success) {
          useAppStore.setState({ isConnecting: false });
        } else {
          useAppStore.setState({ sipConnected: true });
          s.addDiagnosticLog({ level: 'success', category: 'SIP', message: 'Connection established to ' + s.sipConfig.server });
        }
      });
    } else {
      setTimeout(() => {
        useAppStore.setState({ sipConnected: true });
        s.addDiagnosticLog({ level: 'success', category: 'SIP', message: 'TCP connection established on port 5060' });
        setTimeout(() => {
          useAppStore.setState({ sipRegistered: true, isConnecting: false });
          s.addDiagnosticLog({ level: 'success', category: 'SIP', message: 'REGISTER 200 OK (expires=300s)' });
          s.addDiagnosticLog({ level: 'info', category: 'SIP', message: 'Ready for incoming calls' });
        }, 1200);
      }, 800);
    }
  },
  disconnectSip: () => {
    const s = useAppStore.getState();
    if (!s.sipConnected) return;

    if (window.callerflash?.sip?.disconnect) {
      window.callerflash.sip.disconnect();
    }
    s.setSipConnected(false);
    s.setSipRegistered(false);
    s.setIsConnecting(false);
    s.addDiagnosticLog({ level: 'warning', category: 'SIP', message: 'SIP disconnected by user' });
  },

  toastConfig: defaultToastConfig,
  setToastConfig: (config) => set((s) => {
    const next = { ...s.toastConfig, ...config };
    secureStorage.save({
      ...secureStorage.cache,
      toastConfig: next,
    });
    return { toastConfig: next };
  }),

  appPreferences: defaultAppPreferences,
  setAppPreferences: (prefs) => set((s) => {
    const nextPreferences = { ...s.appPreferences, ...prefs };
    secureStorage.save({
      ...secureStorage.cache,
      appPreferences: nextPreferences,
    });
    return { appPreferences: nextPreferences };
  }),
  isMinimized: defaultAppPreferences.startMinimized,
  setIsMinimized: (minimized) => set({ isMinimized: minimized }),

  callHistory: [],
  addCallRecord: (record) => set((s) => ({ callHistory: [record, ...s.callHistory].slice(0, 500) })),
  clearCallHistory: () => set({ callHistory: [] }),

  activeToasts: [],
  addToast: (record) => set((s) => ({ activeToasts: [...s.activeToasts, record] })),
  removeToast: (id) => set((s) => ({ activeToasts: s.activeToasts.filter((t) => t.id !== id) })),

  diagnosticLogs: [],
  addDiagnosticLog: (log) => set((s) => {
    const sanitized: Omit<DiagnosticLog, 'id' | 'timestamp'> = {
      ...log,
      message: redactMessage(log.message),
      details: log.details
        ? redactKeyedValue('details', redactMessage(log.details))
        : log.details,
    };
    return {
      diagnosticLogs: [
        { ...sanitized, id: crypto.randomUUID(), timestamp: new Date() },
        ...s.diagnosticLogs,
      ].slice(0, 1000),
    };
  }),
  clearDiagnosticLogs: () => set({ diagnosticLogs: [] }),

  updateInfo: defaultUpdateInfo,
  setUpdateInfo: (info) => set((s) => {
    const next = { ...s.updateInfo, ...info };
    // Persist user-configurable fields (not transient state)
    secureStorage.save({
      ...secureStorage.cache,
      updateChannel: next.updateChannel,
      autoUpdate: next.autoUpdate,
      autoDownload: next.autoDownload,
      updateCheckFrequency: next.updateCheckFrequency,
      lastCheckedAt: next.lastChecked ? next.lastChecked.toISOString() : undefined,
      releasePageUrl: next.releasePageUrl || undefined,
    });
    return { updateInfo: next };
  }),

  toastDragPosition: persistedUi.toastDragPosition ?? null,
  setToastDragPosition: (pos) => set((s) => {
    secureStorage.save({
      ...secureStorage.cache,
      toastDragPosition: pos,
    });
    return { toastDragPosition: pos };
  }),

  clipboardText: '',
  setClipboardText: (text) => set({ clipboardText: text }),
}));

// ── Decrypt SIP password on boot ────────────────────────────────────
if (typeof window !== 'undefined' && window.callerflash?.safeStorage?.decrypt && persistedUi.sipPasswordEncrypted) {
  window.callerflash.safeStorage.decrypt(persistedUi.sipPasswordEncrypted).then((decrypted) => {
    if (decrypted) {
      useAppStore.setState((s) => ({
        sipConfig: {
          ...s.sipConfig,
          password: decrypted,
        }
      }));
    }
  });
}

// Init storage migration (async, non-blocking)
initStorageMigration();
