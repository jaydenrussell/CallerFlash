// Type declarations for the `window.callerflash` IPC bridge.
// The surface is implemented by `src/tauri-bridge.ts`, which wraps the
// Tauri invoke/listen APIs. Keeping this in sync with that file gives
// the renderer full type safety on `window.callerflash`.

export {};

declare global {
  interface CallerFlashWindowControls {
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

  interface CallerFlashTrayApi {
    /** Push the current SIP status label to main so the tray tooltip stays in sync. */
    setSipStatus: (status: string) => void;
    /** Notify the tray that an update is available (or null to clear). */
    setUpdateAvailable: (version: string | null) => void;
  }

  interface CallerFlashShellApi {
    openExternal: (url: string) => void;
  }

  interface CallerFlashClipboardApi {
    /** Write text to the system clipboard (works without window focus). */
    copy: (text: string) => void;
  }

  interface CallerFlashNotifyApi {
    /** Show a native OS notification. No-op in web demo. */
    show(data: { title: string; body: string; urgency?: 'critical' | 'normal' | 'low'; timeoutType?: 'default' | 'never'; soundEnabled?: boolean }): void;
    /** Request notification permission from the OS. Returns 'granted' | 'denied'. */
    requestPermission?: () => Promise<string>;
    /** Check whether notification permission is already granted. */
    isPermissionGranted?: () => Promise<boolean>;
  }

  interface CallerFlashToastEventData {
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

  interface CallerFlashToastApi {
    /** Push a new toast into the dedicated toast window. */
    show: (data: CallerFlashToastEventData) => void;
    /** Hide the toast window. */
    hide: () => void;
    /** Move the toast window to (x, y) in display coords. */
    setPosition: (x: number, y: number) => void;
    /** Get the current toast window position. */
    getPosition: () => Promise<{ x: number; y: number } | null>;
  }

  type UpdateChannel = 'stable' | 'beta' | 'alpha' | 'tauri';

  interface CallerFlashUpdaterStatus {
    status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error' | 'noop' | 'success';
    message?: string;
    progress?: number;
  }

  interface CallerFlashUpdateArtifact {
    version: string;
    releaseDate: string;
    downloadUrl: string;
    sha256: string;
    sha256Manifest: string;
    signatureB64: string;
    prerelease: boolean;
  }

  interface UpdaterResult {
    version?: string;
    downloadUrl?: string;
    publishedAt?: string;
    error?: string;
    upToDate?: boolean;
    friendlyName?: string;
    status?: string;
  }

  interface CallerFlashUpdaterApi {
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
    /** Notify the backend that update settings changed so any periodic check reschedules. */
    notifySettingsChanged?: () => void;
    onStatus: (callback: (data: { status: string; version?: string; progress?: number; downloadUrl?: string; message?: string }) => void) => () => void;
    onProgress: (callback: (data: { percent: number }) => void) => () => void;
    onDiagnostic: (callback: (data: { level: string; message: string; details?: string }) => void) => () => void;
  }

  interface CallerFlashSipApi {
    connect: (config: Record<string, unknown>) => Promise<{ success: boolean; message?: string }>;
    disconnect: () => Promise<{ success: boolean }>;
    testConnection: (config: Record<string, unknown>) => Promise<Record<string, unknown>>;
    onStatus: (callback: (data: { status: string; message?: string }) => void) => () => void;
    onLog: (callback: (data: { message: string }) => void) => () => void;
    onInvite: (callback: (data: { callerNumber: string; callerName: string }) => void) => () => void;
    onInviteEnded: (callback: (data: { reason: string }) => void) => () => void;
  }

  interface CallerFlashPlatformInfo {
    isElectron: boolean;
    arch: string;
    version: string;
  }

  interface CallerFlashBridge {
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
      runChecks: () => Promise<{
        checks: Array<{ name: string; ok: boolean; message: string | null }>;
        all_ok: boolean;
        os_name: string;
        os_version: string;
        is_windows_11: boolean;
        edition: string;
      }>;
    };
  }

  interface Window {
    /**
     * The Electron preload bridge. Present only when running inside the
     * Electron renderer; in browser dev mode this is `undefined`.
     */
    callerflash?: CallerFlashBridge;
  }
}
