import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore, type AppState } from "./useAppStore";

const defaultState: Partial<AppState> = {
  sipConfig: {
    server: "",
    port: 5060,
    protocol: "UDP",
    username: "",
    password: "",
    authUsername: "",
    codec: "PCMU",
    registerExpiry: 300,
  },
  sipConnected: false,
  callHistory: [],
  diagnosticLogs: [],
};

describe("useAppStore", () => {
  beforeEach(() => {
    useAppStore.setState(defaultState);
  });

  it("initializes with default state", () => {
    const state = useAppStore.getState();
    expect(state.sipConfig.server).toBe("");
    expect(state.sipConfig.port).toBe(5060);
    expect(state.sipConnected).toBe(false);
  });

  it("setSipConfig updates config fields", () => {
    useAppStore.getState().setSipConfig({ server: "sip.test.com" });
    expect(useAppStore.getState().sipConfig.server).toBe("sip.test.com");
  });

  it("setSipConfig keeps unset fields", () => {
    useAppStore.getState().setSipConfig({ server: "sip.test.com" });
    const config = useAppStore.getState().sipConfig;
    expect(config.port).toBe(5060);
    expect(config.protocol).toBe("UDP");
  });

  it("addDiagnosticLog appends a log entry", () => {
    const store = useAppStore.getState();
    store.addDiagnosticLog({
      level: "info",
      category: "SYSTEM",
      message: "test log",
    });
    const logs = useAppStore.getState().diagnosticLogs;
    expect(logs.length).toBe(1);
    expect(logs[0].message).toBe("test log");
  });

  it("addDiagnosticLog respects 1000 entry cap", () => {
    const store = useAppStore.getState();
    for (let i = 0; i < 1005; i++) {
      store.addDiagnosticLog({ level: "info", category: "SYSTEM", message: `log ${i}` });
    }
    const logs = useAppStore.getState().diagnosticLogs;
    expect(logs.length).toBeLessThanOrEqual(1000);
    expect(logs[0].message).toBe("log 1004");
  });

  it("addCallRecord prepends records to callHistory", () => {
    useAppStore.getState().addCallRecord({
      id: "1",
      callerNumber: "555-0100",
      callerName: "Alice",
      timestamp: new Date("2025-01-01T10:00:00Z"),
      duration: 0,
      direction: "inbound",
    });
    useAppStore.getState().addCallRecord({
      id: "2",
      callerNumber: "555-0200",
      callerName: "Bob",
      timestamp: new Date("2025-01-02T10:00:00Z"),
      duration: 0,
      direction: "inbound",
    });
    const history = useAppStore.getState().callHistory;
    expect(history.map((c) => c.id)).toEqual(["2", "1"]);
  });

  it("addCallRecord respects 500 entry cap", () => {
    const store = useAppStore.getState();
    for (let i = 0; i < 505; i++) {
      store.addCallRecord({
        id: String(i),
        callerNumber: `555-0${i}`,
        callerName: "Tester",
        timestamp: new Date(),
        duration: 0,
        direction: "inbound",
      });
    }
    const history = useAppStore.getState().callHistory;
    expect(history.length).toBe(500);
    expect(history[0].id).toBe("504");
  });

  it("clearCallHistory empties callHistory", () => {
    useAppStore.getState().addCallRecord({
      id: "1",
      callerNumber: "555-0100",
      callerName: "Alice",
      timestamp: new Date(),
      duration: 0,
      direction: "inbound",
    });
    useAppStore.getState().clearCallHistory();
    expect(useAppStore.getState().callHistory).toEqual([]);
  });
});
