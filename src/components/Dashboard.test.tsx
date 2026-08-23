import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { Dashboard } from "./Dashboard";

const mockStore = vi.hoisted(() => ({
  sipConfig: {
    server: "sip.example.com",
    port: 5060,
    protocol: "UDP" as const,
    username: "user",
    password: "pass",
    authUsername: "",
    codec: "PCMU",
    registerExpiry: 300,
  },
  registrationStatus: "Registered",
  registrationError: null,
  sipConnected: true,
  sipRegistered: true,
  callHistory: [],
  activeCall: null,
  inboundCall: null,
  setInboundCall: vi.fn(),
  appPreferences: { startWithWindows: true, startMinimized: false },
  isMinimized: false,
}));

vi.mock("../store/useAppStore", () => ({
  useAppStore: (selector?: (s: typeof mockStore) => unknown) =>
    selector ? selector(mockStore) : mockStore,
}));

describe("Dashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.sipConfig = {
      server: "sip.example.com",
      port: 5060,
      protocol: "UDP",
      username: "user",
      password: "pass",
      authUsername: "",
      codec: "PCMU",
      registerExpiry: 300,
    };
    mockStore.registrationStatus = "Registered";
    mockStore.sipConnected = true;
    mockStore.sipRegistered = true;
    mockStore.appPreferences = { startWithWindows: true, startMinimized: false };
  });

  it("shows registration status", () => {
    render(<Dashboard />);
    expect(screen.getByText(/registered/i)).toBeInTheDocument();
  });

  it("shows offline state when not connected", () => {
    mockStore.sipConnected = false;
    mockStore.sipRegistered = false;
    mockStore.registrationStatus = "Disconnected";
    render(<Dashboard />);
    expect(screen.getByText("Offline")).toBeInTheDocument();
  });

  it("shows SIP configuration details", () => {
    render(<Dashboard />);
    expect(screen.getByText(/sip\.example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/5060/)).toBeInTheDocument();
  });

  it("shows encryption label derived from protocol", () => {
    render(<Dashboard />);
    expect(screen.getByText(/none/i)).toBeInTheDocument();
  });

  it("shows TLS encryption label when protocol is TLS", () => {
    (mockStore.sipConfig as { protocol: string }).protocol = "TLS";
    render(<Dashboard />);
    expect(screen.getByText(/TLS \(encrypted\)/i)).toBeInTheDocument();
  });

  it("renders without crashing when no server is configured", () => {
    mockStore.sipConfig.server = "";
    mockStore.sipConnected = false;
    mockStore.sipRegistered = false;
    mockStore.registrationStatus = "Idle";
    const { container } = render(<Dashboard />);
    expect(container).toBeTruthy();
  });

  it("counts only calls received today", () => {
    const now = new Date();
    mockStore.callHistory = [
      { id: "1", callerNumber: "+15550001", callerName: "A", timestamp: now, duration: 0, direction: "inbound" },
      {
        id: "2",
        callerNumber: "+15550002",
        callerName: "B",
        timestamp: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        duration: 0,
        direction: "inbound",
      },
    ];
    const { container } = render(<Dashboard />);
    expect(callsTodayValue(container)).toBe("1");
  });

  it("does not count calls from the same day-of-month in a previous month", () => {
    // Regression: old code compared getDate() only, so a Jul 23 call counted on Aug 23.
    const now = new Date();
    const lastMonthSameDay = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate(), 12, 0, 0);
    mockStore.callHistory = [
      { id: "1", callerNumber: "+15550001", callerName: "A", timestamp: lastMonthSameDay, duration: 0, direction: "inbound" },
    ];
    const { container } = render(<Dashboard />);
    expect(callsTodayValue(container)).toBe("0");
  });
});

function callsTodayValue(container: HTMLElement): string | null {
  const valueEl = container.querySelector<HTMLElement>(".grid.grid-cols-2 > div:nth-child(2) p.font-bold");
  return valueEl?.textContent ?? null;
}
