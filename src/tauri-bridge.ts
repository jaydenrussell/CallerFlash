/**
 * Tauri backend bridge — wraps Tauri invoke/listen/emit into the
 * `window.callerflash` interface so the existing React UI works
 * unchanged on both Tauri and Electron.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { Update } from '@tauri-apps/plugin-updater';
import { sanitizeSipServer } from './security/secretRedactor';
import type { CallerFlashBridge } from './bridge-types';

// Bridge logs only in dev mode — production builds tree-shake these.
const log = (...args: unknown[]) => { if (import.meta.env.DEV) console.log('[tauri-bridge]', ...args); };
const logError = (...args: unknown[]) => { if (import.meta.env.DEV) console.error('[tauri-bridge]', ...args); };

/** Mirror of the plugin's `UpdateMetadata` payload returned by cmd_check_update. */
interface UpdateMetadata {
  rid: number;
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
  rawJson: Record<string, unknown>;
}

/**
 * Release history is fetched backend-side (cmd_list_releases) so the
 * renderer needs no direct api.github.com access — CSP has no external
 * connect-src.
 */
interface ReleaseInfo {
  tagName: string;
  name: string | null;
  publishedAt: string | null;
  prerelease: boolean;
  body: string | null;
  htmlUrl: string;
}

function safeJsonResponse(data: unknown): Record<string, unknown> {
  if (data === null || data === undefined || typeof data !== 'object') {
    return {};
  }
  return data as Record<string, unknown>;
}

function setup(): void {
  if (window.callerflash) {
    log('bridge already set up, skipping');
    return;
  }

  log('setting up Tauri bridge');

  let currentUpdate: Update | null = null;
  let totalContentLength = 0;
  let downloadedBytes = 0;

  const bridge = {
    window: {
      minimize: () => { emit('window:minimize').catch((e) => logError('minimize', e)); },
      maximize: () => { emit('window:maximize').catch((e) => logError('maximize', e)); },
      close: () => { emit('window:close').catch((e) => logError('close', e)); },
      hideToTray: () => { emit('window:hide-to-tray').catch((e) => logError('hideToTray', e)); },
      show: () => { emit('window:show').catch((e) => logError('show', e)); },
      onRestoredFromTray: (callback: () => void) => {
        const unlisten: Promise<() => void> = listen('window:restored-from-tray', () => callback()).catch((e) => { logError('onRestoredFromTray', e); return () => {}; });
        return () => { unlisten.then((fn) => fn()).catch((e) => logError('onRestoredFromTray cleanup', e)); };
      },
      onHiddenToTray: (callback: () => void) => {
        const unlisten: Promise<() => void> = listen('window:hidden-to-tray', () => callback()).catch((e) => { logError('onHiddenToTray', e); return () => {}; });
        return () => { unlisten.then((fn) => fn()).catch((e) => logError('onHiddenToTray cleanup', e)); };
      },
      onNavigateToUpdate: (callback: () => void) => {
        const unlisten: Promise<() => void> = listen('navigate-to-update', () => callback()).catch((e) => { logError('onNavigateToUpdate', e); return () => {}; });
        return () => { unlisten.then((fn) => fn()).catch((e) => logError('onNavigateToUpdate cleanup', e)); };
      },
    },

    tray: {
      setSipStatus: (status: string) => {
        invoke('tray_set_sip_status', { status }).catch((e) => logError('tray.setSipStatus', e));
      },
      setUpdateAvailable: (version: string | null) => {
        invoke('tray_set_update_available', { version }).catch((e) => logError('tray.setUpdateAvailable', e));
      },
    },

    shell: {
      openExternal: (url: string) => {
        invoke('shell_open_external', { url }).catch((e) => logError('shell.openExternal', e));
      },
    },

    clipboard: {
      copy: (text: string) => {
        invoke('copy_to_clipboard', { text }).catch((e) => logError('clipboard.copy', e));
      },
    },

    notify: {
      show: (data: { title: string; body: string; urgency?: 'critical' | 'normal' | 'low'; timeoutType?: 'default' | 'never'; soundEnabled?: boolean }) => {
        // Forward the advisory fields too - the backend validates them and
        // documents which are inert on the Windows toast backend.
        invoke('notify_show', {
          title: data.title,
          body: data.body,
          urgency: data.urgency ?? null,
          timeoutType: data.timeoutType ?? null,
          soundEnabled: data.soundEnabled ?? null,
        }).catch((e) => logError('notify.show', e));
      },
    },

    toast: {
      show: (data: unknown) => {
        invoke('toast_show', { data }).catch((e) => logError('toast.show', e));
      },
      hide: () => {
        invoke('toast_hide').catch((e) => logError('toast.hide', e));
      },
      setPosition: (x: number, y: number) => {
        invoke('toast_set_position', { x, y }).catch((e) => logError('toast.setPosition', e));
      },
      getPosition: async (): Promise<{ x: number; y: number } | null> => {
        return (await invoke('toast_get_position').catch((e) => { logError('toast.getPosition', e); return null; })) as { x: number; y: number } | null;
      },
    },

    updater: {
      check: async (channel: string) => {
        try {
          // Endpoint resolution happens in the backend from the channel —
          // the renderer never supplies a URL.
          const metadata = await invoke<UpdateMetadata | null>('cmd_check_update', { channel });
          currentUpdate = metadata ? new Update(metadata) : null;
          totalContentLength = 0;
          downloadedBytes = 0;
          if (!currentUpdate) {
            return { upToDate: true };
          }
          const rawPlatforms: unknown = currentUpdate.rawJson?.platforms;
          const platforms = (typeof rawPlatforms === 'object' && rawPlatforms !== null ? rawPlatforms : {}) as Record<string, { url?: string }>;
          const win = platforms?.['windows-x86_64'];
          let downloadUrl = typeof win?.url === 'string' ? win.url : '';
          if (downloadUrl && !/^https:\/\//.test(downloadUrl)) {
            downloadUrl = '';
          }
          return {
            version: typeof currentUpdate.version === 'string' ? currentUpdate.version : '',
            downloadUrl,
            publishedAt: typeof currentUpdate.date === 'string' ? currentUpdate.date : '',
            friendlyName: currentUpdate.version,
          };
        } catch (e) {
          currentUpdate = null;
          return { error: String(e) };
        }
      },
      download: async (_channel: string, _version: string, _downloadUrl: string) => {
        if (!currentUpdate) {
          return { status: 'error', error: 'No update pending. Check first.' };
        }
        try {
          await currentUpdate.download(function (progress) {
            switch (progress.event) {
              case 'Started':
                totalContentLength = progress.data.contentLength || 0;
                downloadedBytes = 0;
                break;
              case 'Progress':
                downloadedBytes += progress.data.chunkLength;
                if (totalContentLength > 0) {
                  const pct = Math.round((downloadedBytes / totalContentLength) * 100);
                  emit('updater:progress', { percent: pct }).catch((e) => logError('updater progress', e));
                  emit('updater:status', { status: 'downloading', progress: pct }).catch((e) => logError('updater status', e));
                }
                break;
              case 'Finished':
                emit('updater:progress', { percent: 100 }).catch((e) => logError('updater progress finished', e));
                emit('updater:status', { status: 'ready', version: currentUpdate?.version }).catch((e) => logError('updater status ready', e));
                break;
            }
          });
          return { status: 'ready', version: currentUpdate.version };
        } catch (e) {
          return { status: 'error', error: String(e) };
        }
      },
      install: async (_version: string) => {
        if (!currentUpdate) {
          return { status: 'error', error: 'No downloaded update. Download first.' };
        }
        try {
          emit('updater:status', { status: 'installing', version: currentUpdate.version }).catch((e) => logError('updater install status', e));
          await currentUpdate.install();
          return { status: 'success' };
        } catch (e) {
          return { status: 'error', error: String(e) };
        }
      },
      getDownloadState: async function () {
        return { status: currentUpdate ? 'available' : 'idle', version: currentUpdate?.version || null, path: null, error: null };
      },
      listReleases: async function (): Promise<ReleaseInfo[]> {
        return invoke<ReleaseInfo[]>('cmd_list_releases');
      },
      onStatus: function (callback: (data: { status: string; version?: string; progress?: number; downloadUrl?: string; message?: string }) => void) {
        const unlisten: Promise<() => void> = listen('updater:status', function (event) {
          callback(event.payload as { status: string; version?: string; progress?: number; downloadUrl?: string; message?: string });
        }).catch(function (e) { logError('updater.onStatus', e); return function () {}; });
        return function () { void unlisten.then(function (fn) { return fn(); }).catch(function (e) { logError('updater.onStatus cleanup', e); }); };
      },
      onProgress: function (callback: (data: { percent: number }) => void) {
        const unlisten: Promise<() => void> = listen('updater:progress', function (event) {
          callback(event.payload as { percent: number });
        }).catch(function (e) { logError('updater.onProgress', e); return function () {}; });
        return function () { void unlisten.then(function (fn) { return fn(); }).catch(function (e) { logError('updater.onProgress cleanup', e); }); };
      },
      onDiagnostic: function (callback: (data: { level: string; message: string; details?: string }) => void) {
        const unlisten: Promise<() => void> = listen('updater:diagnostic', function (event) {
          callback(event.payload as { level: string; message: string; details?: string });
        }).catch(function (e) { logError('updater.onDiagnostic', e); return function () {}; });
        return function () { void unlisten.then(function (fn) { return fn(); }).catch(function (e) { logError('updater.onDiagnostic cleanup', e); }); };
      },
    },

    sip: {
      connect: async (config: unknown) => {
        const cfg = config as Record<string, unknown>;
        if (typeof cfg.server === 'string') {
          cfg.server = sanitizeSipServer(cfg.server);
        }
        try {
          const result = safeJsonResponse(await invoke('sip_connect', { config }));
          return { success: result.success === true, message: typeof result.message === 'string' ? result.message : undefined };
        } catch (e) {
          const msg = (e && typeof e === 'object' && 'message' in e) ? String((e as Record<string, unknown>).message) : String(e);
          logError('sip.connect invoke failed:', e);
          return { success: false, message: msg || 'Unknown error' };
        }
      },
      disconnect: async () => {
        try {
          const result = safeJsonResponse(await invoke('sip_disconnect'));
          return { success: result.success === true };
        } catch (e) {
          logError('sip.disconnect', e);
          return { success: false };
        }
      },
      testConnection: async (config: unknown) => {
        try {
          const result = safeJsonResponse(await invoke('sip_test_connection', { config }));
          return result;
        } catch (e) {
          logError('sip.testConnection', e);
          return { success: false, error: String(e) };
        }
      },
      onStatus: (callback: (data: { status: string; message?: string }) => void) => {
        const unlisten: Promise<() => void> = listen('sip:status', (event) => {
          callback(event.payload as { status: string; message?: string });
        }).catch((e) => { logError('sip.onStatus', e); return () => {}; });
        return () => { unlisten.then((fn) => fn()).catch((e) => logError('sip.onStatus cleanup', e)); };
      },
      onLog: (callback: (data: { message: string }) => void) => {
        const unlisten: Promise<() => void> = listen('sip:log', (event) => {
          callback(event.payload as { message: string });
        }).catch((e) => { logError('sip.onLog', e); return () => {}; });
        return () => { unlisten.then((fn) => fn()).catch((e) => logError('sip.onLog cleanup', e)); };
      },
      onInvite: (callback: (data: { callerNumber: string; callerName: string }) => void) => {
        const unlisten: Promise<() => void> = listen('sip:invite', (event) => {
          callback(event.payload as { callerNumber: string; callerName: string });
        }).catch((e) => { logError('sip.onInvite', e); return () => {}; });
        return () => { unlisten.then((fn) => fn()).catch((e) => logError('sip.onInvite cleanup', e)); };
      },
      onInviteEnded: (callback: (data: { reason: string }) => void) => {
        const unlisten: Promise<() => void> = listen('sip:invite:ended', (event) => {
          callback(event.payload as { reason: string });
        }).catch((e) => { logError('sip.onInviteEnded', e); return () => {}; });
        return () => { unlisten.then((fn) => fn()).catch((e) => logError('sip.onInviteEnded cleanup', e)); };
      },
    },

    onToastDiagnostic: (callback: (data: { level: string; message: string; details?: string }) => void) => {
      const unlisten: Promise<() => void> = listen('toast:diagnostic', (event) => {
        callback(event.payload as { level: string; message: string; details?: string });
      }).catch((e) => { logError('onToastDiagnostic', e); return () => {}; });
      return () => { unlisten.then((fn) => fn()).catch((e) => logError('onToastDiagnostic cleanup', e)); };
    },

    diagnostics: {
      append: (entry: { id: string; timestamp: Date | string; level: string; category: string; message: string; details?: string | null }) => {
        invoke('diagnostics_append', { entry }).catch((e) => logError('diagnostics.append', e));
      },
      load: async () => {
        return (await invoke('diagnostics_load').catch((e) => { logError('diagnostics.load', e); return []; })) as Array<{
          id: string;
          timestamp: Date;
          level: string;
          category: string;
          message: string;
          details?: string | null;
        }>;
      },
      exportLogs: async (text: string) => {
        try {
          return await invoke<string>('diagnostics_export', { text });
        } catch (e) {
          logError('diagnostics.exportLogs', e);
          return null;
        }
      },
      clear: async () => {
        try {
          await invoke('diagnostics_clear');
        } catch (e) {
          logError('diagnostics.clear', e);
        }
      },
    },

    app: {
      setStartWithWindows: (enabled: boolean) => {
        invoke('app_set_start_with_windows', { enabled }).catch((e) => logError('app.setStartWithWindows', e));
      },
      getStartWithWindows: async () => {
        try {
          return await invoke<boolean>('app_get_start_with_windows');
        } catch (e) {
          logError('app.getStartWithWindows', e);
          return null;
        }
      },
      setStartMinimized: (_enabled: boolean) => {
        // Handled by frontend
      },
    },

    storage: {
      load: async () => {
        return (await invoke('storage_load').catch((e) => { logError('storage.load', e); return {}; })) as Record<string, unknown>;
      },
      save: async (data: Record<string, unknown>) => {
        return (await invoke('storage_save', { data }).catch((e) => { logError('storage.save', e); return { success: false }; })) as { success: boolean };
      },
    },

    startup: {
      runChecks: async () => {
        return await invoke('run_startup_checks');
      },
    },

    platform: {
      isElectron: false,
      arch: 'x64',
      version: __APP_VERSION__,
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
