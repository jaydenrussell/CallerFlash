import { describe, it, expect, vi, beforeEach } from "vitest";
import { useAppStore } from "./useAppStore";

describe("connectSip bridge failure handling", () => {
  beforeEach(() => {
    useAppStore.setState({
      sipConnected: false,
      sipRegistered: false,
      isConnecting: false,
      diagnosticLogs: [],
    });
  });

  it("resets isConnecting when the bridge promise rejects", async () => {
    const connect = vi.fn().mockRejectedValue(new Error("IPC channel closed"));
    (window as unknown as Record<string, unknown>).callerflash = { sip: { connect } };

    useAppStore.getState().connectSip();
    expect(useAppStore.getState().isConnecting).toBe(true);

    await vi.waitFor(() => {
      expect(useAppStore.getState().isConnecting).toBe(false);
    });
    expect(useAppStore.getState().sipConnected).toBe(false);

    const logs = useAppStore.getState().diagnosticLogs;
    expect(logs[0].level).toBe("error");
    expect(logs[0].message).toContain("Connection failed");
    expect(logs[0].message).toContain("IPC channel closed");
  });

  it("recovers cleanly when the bridge reports failure without throwing", async () => {
    const connect = vi.fn().mockResolvedValue({ success: false, message: "rate limited" });
    (window as unknown as Record<string, unknown>).callerflash = { sip: { connect } };

    useAppStore.getState().connectSip();
    await vi.waitFor(() => {
      expect(useAppStore.getState().isConnecting).toBe(false);
    });
    expect(useAppStore.getState().sipConnected).toBe(false);
    expect(useAppStore.getState().diagnosticLogs[0].message).toContain("rate limited");
  });
});
