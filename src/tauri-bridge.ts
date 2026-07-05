/// <reference types="./electron-bridge.d.ts" />

/**
 * Tauri backend bridge — wraps Tauri invoke/listen/emit into the
 * `window.callerflash` interface so the existing React UI works
 * unchanged on both Tauri and Electron.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';

let invocations = 0;

const log = (...args: unknown[]) => console.log('[tauri-bridge]', ...args);

function setup(): void {
  if (window.callerflash) {
    log('bridge already set up, skipping');
    return;
  }

  log('setting up Tauri bridge');

  const bridge = {
    window: {
      minimize: () => { emit('window:minimize').catch(() => {}); },
      maximize: () => { emit('window:maximize').catch(() => {}); },
      close: () => { emit('window:close').catch(() => {}); },
      hideToTray: () => { emit('window:hide-to-tray').catch(() => {}); },
      show: () => { emit('window:show').catch(() => {}); },
      onRestoredFromTray: (callback: () => void) => {
        const unlisten: Promise<() => void> = listen('window:restored-from-tray', () => callback()).catch(() => () => {});
        return () => { unlisten.then((fn) => fn()).catch(() => {}); };
      },
      onHiddenToTray: (callback: () => void) => {
        const unlisten: Promise<() => void> = listen('window:hidden-to-tray', () => callback()).catch(() => () => {});
        return () => { unlisten.then((fn) => fn()).catch(() => {}); };
      },
      onNavigateToUpdate: (callback: () => void) => {
        const unlisten: Promise<() => void> = listen('navigate-to-update', () => callback()).catch(() => () => {});
        return () => { unlisten.then((fn) => fn()).catch(() => {}); };
      },
    },

    tray: {
      setSipStatus: (status: string) => {
        invoke('tray_set_sip_status', { status }).catch(() => {});
      },
      setUpdateAvailable: (version: string | null) => {
        invoke('tray_set_update_available', { version }).catch(() => {});
      },
    },

    safeStorage: {
      encrypt: async (plaintext: string): Promise<string | null> => {
        return (await invoke('safe_storage_encrypt', { plaintext }).catch(() => null)) as string | null;
      },
      decrypt: async (base64Cipher: string): Promise<string | null> => {
        return (await invoke('safe_storage_decrypt', { base64Cipher }).catch(() => null)) as string | null;
      },
    },

    shell: {
      openExternal: (url: string) => {
        invoke('shell_open_external', { url }).catch(() => {});
      },
    },

    notify: {
      show: (data: { title: string; body: string; urgency?: string; timeoutType?: string; soundEnabled?: boolean }) => {
        invoke('notify_show', { title: data.title, body: data.body }).catch(() => {});
      },
    },

    toast: {
      show: (data: unknown) => {
        invoke('toast_show', { data }).catch(() => {});
      },
      hide: () => {
        invoke('toast_hide').catch(() => {});
      },
      setPosition: (x: number, y: number) => {
        invoke('toast_set_position', { x, y }).catch(() => {});
      },
      getPosition: async (): Promise<{ x: number; y: number } | null> => {
        return (await invoke('toast_get_position').catch(() => null)) as { x: number; y: number } | null;
      },
      getInitial: async (): Promise<unknown> => {
        return (await invoke('toast_get_initial').catch(() => null)) as unknown;
      },
      onShow: (callback: (data: unknown) => void) => {
        const unlisten: Promise<() => void> = listen('toast:show:event', (event) => {
          callback(event.payload);
        }).catch(() => () => {});
        return () => { unlisten.then((fn) => fn()).catch(() => {}); };
      },
      resizeContent: () => {
        // In Tauri, we use the webview's content size detection
        // This is a no-op for now
      },
    },

    updater: {
      check: async (channel: string) => {
        return await invoke('updater_check', { channel });
      },
      download: async (channel: string, version: string, downloadUrl: string) => {
        return await invoke('updater_download', { channel, version, downloadUrl });
      },
      install: async (version: string) => {
        return await invoke('updater_install', { version });
      },
      show: () => {
        // Navigate to updates tab - handled by event
      },
      setChannel: (_channel: string) => {
        // Handled by frontend
      },
      getDownloadState: async () => {
        return { status: 'idle', version: null, path: null, error: null };
      },
      onStatus: (callback: (data: unknown) => void) => {
        const unlisten: Promise<() => void> = listen('updater:status', (event) => {
          callback(event.payload);
        }).catch(() => () => {});
        return () => { unlisten.then((fn) => fn()).catch(() => {}); };
      },
      onProgress: (callback: (data: unknown) => void) => {
        const unlisten: Promise<() => void> = listen('updater:progress', (event) => {
          callback(event.payload);
        }).catch(() => () => {});
        return () => { unlisten.then((fn) => fn()).catch(() => {}); };
      },
      onDiagnostic: (callback: (data: unknown) => void) => {
        const unlisten: Promise<() => void> = listen('updater:diagnostic', (event) => {
          callback(event.payload);
        }).catch(() => () => {});
        return () => { unlisten.then((fn) => fn()).catch(() => {}); };
      },
      onBackgroundCheck: (_callback: (data: unknown) => void) => {
        return () => {};
      },
    },

    sip: {
      connect: async (config: unknown) => {
        return (await invoke('sip_connect', { config }).catch((e) => ({ success: false, message: e }))) as { success: boolean; message?: string };
      },
      disconnect: async () => {
        return (await invoke('sip_disconnect').catch(() => ({ success: true }))) as { success: boolean };
      },
      onStatus: (callback: (data: { status: string; message?: string }) => void) => {
        const unlisten: Promise<() => void> = listen('sip:status', (event) => {
          callback(event.payload as { status: string; message?: string });
        }).catch(() => () => {});
        return () => { unlisten.then((fn) => fn()).catch(() => {}); };
      },
      onLog: (callback: (data: { message: string }) => void) => {
        const unlisten: Promise<() => void> = listen('sip:log', (event) => {
          callback(event.payload as { message: string });
        }).catch(() => () => {});
        return () => { unlisten.then((fn) => fn()).catch(() => {}); };
      },
      onInvite: (callback: (data: { callerNumber: string; callerName: string }) => void) => {
        const unlisten: Promise<() => void> = listen('sip:invite', (event) => {
          callback(event.payload as { callerNumber: string; callerName: string });
        }).catch(() => () => {});
        return () => { unlisten.then((fn) => fn()).catch(() => {}); };
      },
    },

    onToastDiagnostic: (callback: (data: { level: string; message: string; details?: string }) => void) => {
      const unlisten: Promise<() => void> = listen('toast:diagnostic', (event) => {
        callback(event.payload as { level: string; message: string; details?: string });
      }).catch(() => () => {});
      return () => { unlisten.then((fn) => fn()).catch(() => {}); };
    },

    diagnostics: {
      append: (entry: { id: string; timestamp: Date | string; level: string; category: string; message: string; details?: string | null }) => {
        invoke('diagnostics_append', { entry }).catch(() => {});
      },
      load: async () => {
        return (await invoke('diagnostics_load').catch(() => [])) as Array<{
          id: string;
          timestamp: Date;
          level: string;
          category: string;
          message: string;
          details?: string | null;
        }>;
      },
    },

    app: {
      setStartWithWindows: (enabled: boolean) => {
        invoke('app_set_start_with_windows', { enabled }).catch(() => {});
      },
      setStartMinimized: (_enabled: boolean) => {
        // Handled by frontend
      },
    },

    storage: {
      load: async () => {
        return (await invoke('storage_load').catch(() => ({}))) as Record<string, unknown>;
      },
      save: async (data: Record<string, unknown>) => {
        return (await invoke('storage_save', { data }).catch(() => ({ success: false }))) as { success: boolean };
      },
    },

    platform: {
      isElectron: true,
      arch: 'x64',
      version: '__APP_VERSION__',
    },
  } satisfies CallerFlashBridge;

  Object.defineProperty(window, 'callerflash', {
    value: bridge,
    writable: false,
    configurable: false,
  });

  log('Tauri bridge installed on window.callerflash');
}

// Auto-setup on DOMContentLoaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setup);
} else {
  setup();
}
