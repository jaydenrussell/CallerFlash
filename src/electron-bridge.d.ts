// Type declarations for the Electron preload bridge exposed via contextBridge.
// Mirrors the surface defined in `electron/preload.cjs`. Keeping this in sync
// with that file gives the renderer full type safety on `window.callerflash`.

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

  interface CallerFlashSafeStorageApi {
    encrypt: (plaintext: string) => Promise<string | null>;
    decrypt: (base64Cipher: string) => Promise<string | null>;
  }

  interface CallerFlashShellApi {
    openExternal: (url: string) => void;
  }

  interface CallerFlashNotifyApi {
    /** Show a native OS notification. No-op in web demo. */
    show(title: string, body: string): void;
    show(data: { title: string; body: string; urgency?: 'critical' | 'normal' | 'low'; timeoutType?: 'default' | 'never'; soundEnabled?: boolean }): void;
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
    /** Get the initial call data for this toast window (called once on mount). */
    getInitial: () => Promise<CallerFlashToastEventData | null>;
    /** Subscribe to incoming toast events (renderer side of the bridge). */
    onShow: (callback: (data: CallerFlashToastEventData) => void) => () => void;
    /** Auto-resize the toast window to fit rendered content. */
    resizeContent: () => void;
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

  /* eslint-disable @typescript-eslint/no-explicit-any */
  interface CallerFlashUpdaterApi {
    check: (channel: string) => Promise<any>;
    download: (channel: string, version: string, downloadUrl: string) => Promise<any>;
    install: (version: string) => Promise<any>;
    show: () => void;
    setChannel: (channel: string) => void;
    getDownloadState: () => Promise<any>;
    onStatus: (callback: (data: any) => void) => () => void;
    onProgress: (callback: (data: any) => void) => () => void;
    onDiagnostic: (callback: (data: { level: string; message: string; details?: string }) => void) => () => void;
    onBackgroundCheck: (callback: (data: any) => void) => () => void;
  }

  interface CallerFlashSipApi {
    connect: (config: any) => Promise<{ success: boolean; message?: string }>;
    disconnect: () => Promise<{ success: boolean }>;
    testConnection: (config: any) => Promise<any>;
    onStatus: (callback: (data: { status: string; message?: string }) => void) => () => void;
    onLog: (callback: (data: { message: string }) => void) => () => void;
    onInvite: (callback: (data: { callerNumber: string; callerName: string }) => void) => () => void;
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  interface CallerFlashPlatformInfo {
    isElectron: true;
    arch: string;
    version: string;
  }

  interface CallerFlashBridge {
    window: CallerFlashWindowControls;
    tray: CallerFlashTrayApi;
    safeStorage: CallerFlashSafeStorageApi;
    shell: CallerFlashShellApi;
    notify: CallerFlashNotifyApi;
    toast: CallerFlashToastApi;
    updater: CallerFlashUpdaterApi;
    sip: CallerFlashSipApi;
    platform: CallerFlashPlatformInfo;
    onToastDiagnostic: (callback: (data: { level: string; message: string; details?: string }) => void) => () => void;
    diagnostics: {
      append: (entry: { id: string; timestamp: Date | string; level: string; category: string; message: string; details?: string | null }) => void;
      load: () => Promise<Array<{ id: string; timestamp: Date; level: string; category: string; message: string; details?: string | null }>>;
      export: (content: string) => Promise<{ success: boolean; error?: string }>;
    };
    app: {
      setStartWithWindows: (enabled: boolean) => void;
      getStartWithWindows: () => Promise<boolean | null>;
      setStartMinimized: (enabled: boolean) => void;
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
