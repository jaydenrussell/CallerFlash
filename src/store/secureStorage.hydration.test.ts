import { describe, it, expect, beforeEach, vi } from "vitest";

describe("SecureStorage hydration gate", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    vi.resetModules();
    window.localStorage?.clear();
  });

  function installBridge(bridge: {
    load: () => Promise<unknown>;
    save: (d: Record<string, unknown>) => Promise<void>;
  }): void {
    (window as unknown as { callerflash: unknown }).callerflash = { storage: bridge };
  }

  it("early write waits for native hydration and preserves the stored password", async () => {
    let resolveLoad!: (v: unknown) => void;
    const saved: Array<Record<string, unknown>> = [];
    installBridge({
      load: () =>
        new Promise((res) => {
          resolveLoad = res;
        }),
      save: async (d) => {
        saved.push(d);
      },
    });

    const store = await import("./useAppStore");
    store.runStorageMigration();

    // Write fired BEFORE native data arrives - it must block on hydration.
    store.persistLastRunVersion("9.9.9");
    await flush();
    expect(saved).toHaveLength(0);

    resolveLoad({
      version: 3,
      sipConfig: { server: "a.example.com", password: "real-secret" },
    });
    await flush();
    expect(saved).toHaveLength(1);
    const payload = saved[0] as { lastRunVersion?: string; sipConfig?: { password?: string } };
    expect(payload.lastRunVersion).toBe("9.9.9");
    expect(payload.sipConfig?.password).toBe("real-secret");

    // The WebView-localStorage copy stays sanitized even though the
    // native payload carried the credential (best-effort: some test
    // environments do not provide a storage backend).
    const rawLocal = window.localStorage?.getItem("callerflash-ui-settings");
    if (rawLocal != null) {
      const local = JSON.parse(rawLocal) as { sipConfig?: { password?: string } };
      expect(local.sipConfig?.password).toBe("");
    }
  });

  it("subsequent writes merge over hydrated cache instead of replacing it", async () => {
    const saved: Array<Record<string, unknown>> = [];
    installBridge({
      load: async () => ({
        version: 3,
        updateChannel: "beta",
        sipConfig: { server: "s", password: "p" },
      }),
      save: async (d) => {
        saved.push(d);
      },
    });

    const store = await import("./useAppStore");
    store.runStorageMigration();
    await flush(); // let hydration complete

    store.useAppStore.getState().clearCallHistory();
    await flush();
    expect(saved.length).toBeGreaterThanOrEqual(1);
    const payload = saved[saved.length - 1] as {
      callHistory?: unknown[];
      updateChannel?: string;
      sipConfig?: { password?: string };
    };
    expect(payload.callHistory).toEqual([]);
    expect(payload.updateChannel).toBe("beta");
    expect(payload.sipConfig?.password).toBe("p");
  });

  it("writes issued before runStorageMigration still wait for hydration", async () => {
    let resolveLoad!: (v: unknown) => void;
    const saved: Array<Record<string, unknown>> = [];
    installBridge({
      load: () =>
        new Promise((res) => {
          resolveLoad = res;
        }),
      save: async (d) => {
        saved.push(d);
      },
    });

    const store = await import("./useAppStore");
    // Queue the write first (gate promise is still null), then start
    // hydration in the same synchronous block - the queued doSave must
    // observe the gate and block until native data arrives.
    store.persistLastRunVersion("1.2.3");
    store.runStorageMigration();
    await flush();
    resolveLoad({ version: 3, sipConfig: { server: "late", password: "late-secret" } });
    await flush();
    const payload = saved[saved.length - 1] as {
      lastRunVersion?: string;
      sipConfig?: { server?: string };
    };
    expect(payload.lastRunVersion).toBe("1.2.3");
    expect(payload.sipConfig?.server).toBe("late");
  });
});
