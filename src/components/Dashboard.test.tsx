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
});
