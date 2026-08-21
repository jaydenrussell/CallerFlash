/**
 * Tests for the Tauri bridge layer — the security-relevant glue between
 * the renderer and the Rust backend. Mocks @tauri-apps APIs and asserts:
 *   - renderer-supplied URLs are filtered to https before display
 *   - SIP server input is sanitized before it reaches the backend
 *   - non-object backend responses cannot produce truthy success fields
 *   - failures degrade to safe defaults instead of throwing
 */
import { beforeEach, describe, expect, it, vi, beforeAll } from 'vitest';

const { invokeMock, listenMock, emitMock, updateBehavior } = vi.hoisted(() => ({
  invokeMock: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(),
  listenMock: vi.fn<(event: string, handler: unknown) => Promise<() => void>>(),
  emitMock: vi.fn<(event: string, payload?: unknown) => Promise<void>>(),
  updateBehavior: {
    downloadImpl: vi.fn<(cb: unknown) => Promise<void>>(),
    installImpl: vi.fn<() => Promise<void>>(),
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (event: string, handler: unknown) => {
    listenMock(event, handler);
    return Promise.resolve(() => {});
  },
  emit: (event: string, payload?: unknown) => emitMock(event, payload),
}));

vi.mock('@tauri-apps/plugin-updater', () => ({
  Update: class {
    version: string;
    date?: string;
    rawJson: Record<string, unknown>;
    constructor(metadata: { version?: string; date?: string; rawJson?: Record<string, unknown> }) {
      this.version = metadata.version ?? '';
      this.date = metadata.date;
      this.rawJson = metadata.rawJson ?? {};
    }
    download(cb: (progress: unknown) => void) {
      return updateBehavior.downloadImpl(cb);
    }
    install() {
      return updateBehavior.installImpl();
    }
  },
}));

type Bridge = NonNullable<typeof window.callerflash>;

let bridge!: Bridge;

beforeAll(async () => {
  // test-setup.ts installs a partial window.callerflash stub for component
  // tests; remove it so tauri-bridge's setup() runs against our mocks.
  Reflect.deleteProperty(window, 'callerflash');
  await import('./tauri-bridge');
  // Module defers setup to DOMContentLoaded when readyState is 'loading'.
  if (!window.callerflash) {
    document.dispatchEvent(new Event('DOMContentLoaded'));
  }
  if (!window.callerflash) throw new Error('tauri-bridge did not install');
  bridge = window.callerflash;
});

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  emitMock.mockReset();
  emitMock.mockResolvedValue(undefined);
  updateBehavior.downloadImpl.mockReset().mockResolvedValue(undefined);
  updateBehavior.installImpl.mockReset().mockResolvedValue(undefined);
});

describe('sip.connect', () => {
  it('sanitizes the server field before invoking the backend', async () => {
    invokeMock.mockResolvedValueOnce({ success: true });
    await bridge.sip.connect({ server: '  SIP.Example.COM:5060 ', username: 'u' });
    expect(invokeMock).toHaveBeenCalledWith(
      'sip_connect',
      expect.objectContaining({
        config: expect.objectContaining({ server: 'sip.example.com' }),
      }),
    );
  });

  it('returns failure for non-object backend responses', async () => {
    invokeMock.mockResolvedValueOnce(null);
    expect(await bridge.sip.connect({ server: 'pbx.example.com' })).toEqual({
      success: false,
    });
  });

  it('maps primitive responses to failure without throwing', async () => {
    invokeMock.mockResolvedValueOnce('garbage');
    const res = await bridge.sip.connect({ server: 'pbx.example.com' });
    expect(res.success).toBe(false);
  });

  it('returns a safe failure object when the invoke rejects', async () => {
    invokeMock.mockRejectedValueOnce(new Error('backend exploded'));
    const res = await bridge.sip.connect({ server: 'pbx.example.com' });
    expect(res).toEqual({ success: false, message: 'backend exploded' });
  });

  it('passes through successful responses untouched', async () => {
    invokeMock.mockResolvedValueOnce({ success: true, message: 'registered' });
    const res = await bridge.sip.connect({ server: 'pbx.example.com' });
    expect(res.success).toBe(true);
    expect(res.message).toBe('registered');
  });
});

describe('updater.check', () => {
  it('reports upToDate when the backend finds nothing', async () => {
    invokeMock.mockResolvedValueOnce(null);
    expect(await bridge.updater.check('stable')).toEqual({ upToDate: true });
  });

  it('keeps https download URLs from the manifest', async () => {
    invokeMock.mockResolvedValueOnce({
      rid: 1,
      currentVersion: '2.1.0',
      version: '2.1.1',
      date: '2026-08-01',
      rawJson: { platforms: { 'windows-x86_64': { url: 'https://github.com/x/y.zip' } } },
    });
    const res = await bridge.updater.check('stable');
    expect(res).toMatchObject({ version: '2.1.1', downloadUrl: 'https://github.com/x/y.zip' });
  });

  it('blanks non-https download URLs', async () => {
    invokeMock.mockResolvedValueOnce({
      rid: 1,
      currentVersion: '2.1.0',
      version: '2.1.1',
      rawJson: { platforms: { 'windows-x86_64': { url: 'http://attacker.example/payload.exe' } } },
    });
    const res = await bridge.updater.check('stable');
    expect(res.downloadUrl).toBe('');
  });

  it('handles malformed platform payloads safely', async () => {
    invokeMock.mockResolvedValueOnce({
      rid: 1,
      currentVersion: '2.1.0',
      version: '2.1.1',
      rawJson: { platforms: null },
    });
    const res = await bridge.updater.check('stable');
    expect(res.downloadUrl).toBe('');
    expect(res.version).toBe('2.1.1');
  });

  it('surfaces backend errors without throwing', async () => {
    invokeMock.mockRejectedValueOnce('network down');
    const res = await bridge.updater.check('beta');
    expect(res.error).toContain('network down');
  });
});

describe('updater.download/install state machine', () => {
  it('refuses to download with no pending update', async () => {
    const res = await bridge.updater.download('stable', '2.1.1', 'https://x');
    expect(res.status).toBe('error');
    expect(String(res.error)).toMatch(/no update pending/i);
  });

  it('refuses to install with no downloaded update', async () => {
    const res = await bridge.updater.install('2.1.1');
    expect(res.status).toBe('error');
    expect(String(res.error)).toMatch(/no downloaded update/i);
  });

  it('emits progress events during download', async () => {
    invokeMock.mockResolvedValueOnce({
      rid: 1,
      currentVersion: '2.1.0',
      version: '2.1.1',
      rawJson: {},
    });
    await bridge.updater.check('stable');

    updateBehavior.downloadImpl.mockImplementation(async (cb) => {
      const emit = cb as (p: unknown) => void;
      emit({ event: 'Started', data: { contentLength: 100 } });
      emit({ event: 'Progress', data: { chunkLength: 50 } });
      emit({ event: 'Finished' });
    });
    const res = await bridge.updater.download('stable', '2.1.1', '');
    expect(res.status).toBe('ready');

    const emitted = emitMock.mock.calls.map((c) => [c[0], c[1]]);
    expect(emitted).toContainEqual(['updater:progress', { percent: 50 }]);
    expect(emitted).toContainEqual(['updater:progress', { percent: 100 }]);
    expect(emitted).toContainEqual(['updater:status', { status: 'ready', version: '2.1.1' }]);
  });

  it('reports download errors instead of throwing', async () => {
    invokeMock.mockResolvedValueOnce({
      rid: 1,
      currentVersion: '2.1.0',
      version: '2.1.1',
      rawJson: {},
    });
    await bridge.updater.check('stable');
    updateBehavior.downloadImpl.mockRejectedValue(new Error('disk full'));
    const res = await bridge.updater.download('stable', '2.1.1', '');
    expect(res.status).toBe('error');
    expect(String(res.error)).toMatch(/disk full/);
  });

  it('installs a downloaded update successfully', async () => {
    invokeMock.mockResolvedValueOnce({
      rid: 1,
      currentVersion: '2.1.0',
      version: '2.1.1',
      rawJson: {},
    });
    await bridge.updater.check('stable');
    updateBehavior.installImpl.mockResolvedValue(undefined);
    const res = await bridge.updater.install('2.1.1');
    expect(res.status).toBe('success');
  });
});

describe('failure-tolerant wrappers', () => {
  it('diagnostics.load degrades to empty array on error', async () => {
    invokeMock.mockRejectedValueOnce(new Error('io'));
    expect(await bridge.diagnostics.load()).toEqual([]);
  });

  it('storage.save reports failure instead of throwing', async () => {
    invokeMock.mockRejectedValueOnce(new Error('disk'));
    expect(await bridge.storage.save({ a: 1 })).toEqual({ success: false });
  });

  it('storage.load degrades to empty object on error', async () => {
    invokeMock.mockRejectedValueOnce(new Error('corrupt'));
    expect(await bridge.storage.load()).toEqual({});
  });

  it('getStartWithWindows returns null on error', async () => {
    invokeMock.mockRejectedValueOnce(new Error('registry'));
    expect(await bridge.app.getStartWithWindows()).toBeNull();
  });

  it('exportLogs returns null on error', async () => {
    invokeMock.mockRejectedValueOnce(new Error('io'));
    expect(await bridge.diagnostics.exportLogs('logs')).toBeNull();
  });

  it('toast.getPosition returns null on error', async () => {
    invokeMock.mockRejectedValueOnce(new Error('gone'));
    expect(await bridge.toast.getPosition()).toBeNull();
  });

  it('listReleases passes through backend release history', async () => {
    invokeMock.mockResolvedValueOnce([
      { tagName: 'v2.1.0', name: 'v2.1.0', publishedAt: null, prerelease: false, body: 'x', htmlUrl: 'https://github.com/r/t/v2.1.0' },
    ]);
    const releases = (await bridge.updater.listReleases?.()) ?? [];
    expect(invokeMock).toHaveBeenCalledWith('cmd_list_releases', undefined);
    expect(releases).toHaveLength(1);
    expect(releases[0].tagName).toBe('v2.1.0');
  });
});

describe('fire-and-forget invocations', () => {
  it('clipboard.copy forwards text to the backend', () => {
    invokeMock.mockResolvedValueOnce(undefined);
    bridge.clipboard.copy('15551234567');
    expect(invokeMock).toHaveBeenCalledWith('copy_to_clipboard', { text: '15551234567' });
  });

  it('shell.openExternal delegates URL opening to the backend', () => {
    invokeMock.mockResolvedValueOnce(undefined);
    bridge.shell.openExternal('https://github.com/jaydenrussell/CallerFlash/releases');
    expect(invokeMock).toHaveBeenCalledWith('shell_open_external', {
      url: 'https://github.com/jaydenrussell/CallerFlash/releases',
    });
  });

  it('tray.setSipStatus reaches the backend', () => {
    invokeMock.mockResolvedValueOnce(undefined);
    bridge.tray.setSipStatus('registered');
    expect(invokeMock).toHaveBeenCalledWith('tray_set_sip_status', { status: 'registered' });
  });

  it('window.close emits the window control event', () => {
    bridge.window.close();
    expect(emitMock).toHaveBeenCalledWith('window:close', undefined);
  });
});

describe('event subscriptions', () => {
  it('delivers sip status payloads to the callback', async () => {
    let handler: ((e: unknown) => void) | undefined;
    listenMock.mockImplementationOnce((_event: string, h: unknown) => {
      handler = h as (e: unknown) => void;
      return Promise.resolve(() => {});
    });
    const seen: Array<{ status: string }> = [];
    bridge.sip.onStatus((d) => seen.push(d));
    await Promise.resolve(); // flush listen promise
    handler?.({ payload: { status: 'registered' } });
    expect(seen).toEqual([{ status: 'registered' }]);
  });

  it('cleanup function detaches without throwing', async () => {
    const cleanup = bridge.sip.onStatus(() => {});
    expect(() => cleanup()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('subscription survives listen rejection', async () => {
    listenMock.mockRejectedValueOnce(new Error('bus down'));
    const cleanup = bridge.sip.onInvite(() => {});
    expect(() => cleanup()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});
