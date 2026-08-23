/**
 * Single source of truth for the `window.callerflash` IPC bridge surface.
 *
 * The implementation lives in `src/tauri-bridge.ts`, which satisfies
 * `CallerFlashBridge` at compile time — adding a command there without
 * declaring it here (or vice versa) fails `tsc`. There is no second
 * declaration file to keep in sync.
 */

export interface CallerFlashWindowControls {
  minimize: () => void;
  maximize: () => void;
  close: () => void;
  hideToTray: () => void;
  show: () => void;
  /** Subscribe to tray→renderer "restored" event. Returns an unsubscribe fn. */
  onRestoredFromTray: (callback: () => void) => () => void;
  /** Subscribe to tray→renderer "hidden" event. Returns an unsubscribe fn. */
  onHiddenToTray: (callback: () => void) => () => void;
  /** Subscribe to tray "navigate to updates" click. Returns an unsubscribe fn. */
  onNavigateToUpdate: (callback: () => void) => () => void;
}

export interface CallerFlashTrayApi {
  /** Push the current SIP status label to main so the tray tooltip stays in sync. */
  setSipStatus: (status: string) => void;
  /** Notify the tray that an update is available (or null to clear). */
  setUpdateAvailable: (version: string | null) => void;
}

export interface CallerFlashShellApi {
  openExternal: (url: string) => void;
}

export interface CallerFlashClipboardApi {
  /** Write text to the system clipboard (works without window focus). */
  copy: (text: string) => void;
}

export interface CallerFlashNotifyApi {
  /** Show a native OS notification. No-op in web demo. */
  show(data: { title: string; body: string; urgency?: 'critical' | 'normal' | 'low'; timeoutType?: 'default' | 'never'; soundEnabled?: boolean }): void;
  /** Request notification permission from the OS. Returns 'granted' | 'denied'. */
  requestPermission?: () => Promise<string>;
  /** Check whether notification permission is already granted. */
  isPermissionGranted?: () => Promise<boolean>;
}

export interface CallerFlashToastEventData {
  id: string;
  callerNumber: string;
  callerName: string;
  timestamp: string; // ISO
  config: {
    duration: number;
    backgroundColor: string;
    accentColor: string;
    textColor: string;
    borderRadius: number;
    opacity: number;
    fontFamily: string;
    fontSize: number;
    autoCopyToClipboard: boolean;
    showCallerName: boolean;
    showTimestamp: boolean;
    maxWidth: number;
    soundEnabled: boolean;
    soundName: string;
  };
}

export interface CallerFlashToastApi {
  /** Push a new toast into the dedicated toast window. */
  show: (data: CallerFlashToastEventData) => void;
  /** Hide the toast window. */
  hide: () => void;
  /** Move the toast window to (x, y) in display coords. */
  setPosition: (x: number, y: number) => void;
  /** Get the current toast window position. */
  getPosition: () => Promise<{ x: number; y: number } | null>;
}

export type UpdateChannel = 'stable' | 'beta' | 'alpha' | 'tauri';

export interface CallerFlashUpdaterStatus {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error' | 'noop' | 'success';
  message?: string;
  progress?: number;
}

export interface CallerFlashUpdateArtifact {
  version: string;
  releaseDate: string;
  downloadUrl: string;
  sha256: string;
  sha256Manifest: string;
  signatureB64: string;
  prerelease: boolean;
}

export interface UpdaterResult {
  version?: string;
  downloadUrl?: string;
  publishedAt?: string;
  error?: string;
  upToDate?: boolean;
  friendlyName?: string;
  status?: string;
}

export interface CallerFlashUpdaterApi {
  check: (channel: string) => Promise<UpdaterResult>;
  download: (channel: string, version: string, downloadUrl: string) => Promise<{ status: string; version?: string; error?: string }>;
  install: (version: string) => Promise<{ status: string; error?: string }>;
  getDownloadState: () => Promise<{ status: string; version: string | null; path: string | null; error: string | null }>;
  /** Backend-fetched release history (no renderer network access needed). */
  listReleases?: () => Promise<Array<{
    tagName: string;
    name: string | null;
    publishedAt: string | null;
    prerelease: boolean;
    body: string | null;
    htmlUrl: string;
  }>>;
  onStatus: (callback: (data: { status: string; version?: string; progress?: number; downloadUrl?: string; message?: string }) => void) => () => void;
  onProgress: (callback: (data: { percent: number }) => void) => () => void;
  onDiagnostic: (callback: (data: { level: string; message: string; details?: string }) => void) => () => void;
}

export interface CallerFlashSipApi {
  connect: (config: Record<string, unknown>) => Promise<{ success: boolean; message?: string }>;
  disconnect: () => Promise<{ success: boolean }>;
  testConnection: (config: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onStatus: (callback: (data: { status: string; message?: string }) => void) => () => void;
  onLog: (callback: (data: { message: string }) => void) => () => void;
  onInvite: (callback: (data: { callerNumber: string; callerName: string }) => void) => () => void;
  onInviteEnded: (callback: (data: { reason: string }) => void) => () => void;
}

export interface CallerFlashPlatformInfo {
  isElectron: boolean;
  arch: string;
  version: string;
}

export interface StartupCheck {
  name: string;
  ok: boolean;
  message: string | null;
}

export interface StartupReport {
  checks: StartupCheck[];
  all_ok: boolean;
  os_name: string;
  os_version: string;
  is_windows_11: boolean;
  edition: string;
}

export interface CallerFlashBridge {
  window: CallerFlashWindowControls;
  tray: CallerFlashTrayApi;
  shell: CallerFlashShellApi;
  clipboard: CallerFlashClipboardApi;
  notify: CallerFlashNotifyApi;
  toast: CallerFlashToastApi;
  updater: CallerFlashUpdaterApi;
  sip: CallerFlashSipApi;
  platform: CallerFlashPlatformInfo;
  onToastDiagnostic: (callback: (data: { level: string; message: string; details?: string }) => void) => () => void;
  diagnostics: {
    append: (entry: { id: string; timestamp: Date | string; level: string; category: string; message: string; details?: string | null }) => void;
    load: () => Promise<Array<{ id: string; timestamp: Date; level: string; category: string; message: string; details?: string | null }>>;
    exportLogs: (text: string) => Promise<string | null>;
    /** Zero-overwrite + delete the on-disk diagnostics log. */
    clear: () => Promise<void>;
  };
  app: {
    setStartWithWindows: (enabled: boolean) => void;
    getStartWithWindows: () => Promise<boolean | null>;
    setStartMinimized: (enabled: boolean) => void;
  };
  storage: {
    load: () => Promise<Record<string, unknown>>;
    save: (data: Record<string, unknown>) => Promise<{ success: boolean }>;
  };
  startup: {
    runChecks: () => Promise<StartupReport>;
  };
}

declare global {
  interface Window {
    /**
     * The IPC bridge. Present only when running inside Tauri; in browser
     * dev mode this is `undefined`.
     */
    callerflash?: CallerFlashBridge;
  }
}

export {};
