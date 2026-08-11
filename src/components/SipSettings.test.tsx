import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SipSettings } from "./SipSettings";

const mockStore = vi.hoisted(() => ({
  sipConfig: {
    server: "",
    port: 5060,
    protocol: "UDP" as const,
    username: "",
    password: "",
    authUsername: "",
    codec: "PCMU",
    registerExpiry: 300,
  },
  registrationStatus: "Disconnected",
  sipConnected: false,
  sipRegistered: false,
  isConnecting: false,
  setSipConfig: vi.fn().mockResolvedValue(undefined),
  addDiagnosticLog: vi.fn(),
  connectSip: vi.fn(),
  disconnectSip: vi.fn(),
}));

vi.mock("../store/useAppStore", () => ({
  useAppStore: (selector?: (s: typeof mockStore) => unknown) =>
    selector ? selector(mockStore) : mockStore,
}));

describe("SipSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.sipConfig = {
      server: "",
      port: 5060,
      protocol: "UDP",
      username: "",
      password: "",
      authUsername: "",
      codec: "PCMU",
      registerExpiry: 300,
    };
    mockStore.sipConnected = false;
    mockStore.sipRegistered = false;
    mockStore.isConnecting = false;
  });

  it("renders the heading", () => {
    render(<SipSettings />);
    expect(screen.getByText("SIP Settings")).toBeInTheDocument();
  });

  it("renders connect button in disconnected state", () => {
    render(<SipSettings />);
    expect(screen.getByRole("button", { name: /connect/i })).toBeInTheDocument();
  });

  it("renders disconnect button when connected", () => {
    mockStore.sipConnected = true;
    render(<SipSettings />);
    expect(screen.getByRole("button", { name: /disconnect/i })).toBeInTheDocument();
  });

  it("renders server address input with placeholder", () => {
    render(<SipSettings />);
    expect(screen.getByPlaceholderText("sip.example.com")).toBeInTheDocument();
  });

  it("renders port input with default value", () => {
    render(<SipSettings />);
    const portInput = screen.getByDisplayValue("5060");
    expect(portInput).toBeInTheDocument();
  });

  it("renders username input with placeholder", () => {
    render(<SipSettings />);
    const usernameInputs = screen.getAllByPlaceholderText("username");
    expect(usernameInputs.length).toBeGreaterThanOrEqual(1);
  });

  it("calls disconnectSip when disconnect clicked", () => {
    mockStore.sipConnected = true;
    render(<SipSettings />);
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(mockStore.disconnectSip).toHaveBeenCalled();
  });

  it("renders protocol select with UDP/TCP/TLS options", () => {
    render(<SipSettings />);
    const selects = screen.getAllByRole("combobox");
    // The protocol select is the second combobox (first is SIP provider)
    expect(selects.length).toBeGreaterThanOrEqual(2);
    const protocolSelect = selects[1] as HTMLSelectElement;
    expect(Array.from(protocolSelect.options).map((o) => o.value)).toEqual(["UDP", "TCP", "TLS"]);
  });

  it("auto-swaps port to 5061 when switching to TLS", () => {
    render(<SipSettings />);
    const protocolSelect = screen.getAllByRole("combobox")[1] as HTMLSelectElement;
    fireEvent.change(protocolSelect, { target: { value: "TLS" } });
    expect(screen.getByDisplayValue("5061")).toBeInTheDocument();
  });

  it("auto-swaps port back to 5060 when leaving TLS", () => {
    (mockStore.sipConfig as { protocol: string }).protocol = "TLS";
    mockStore.sipConfig.port = 5061;
    render(<SipSettings />);
    const protocolSelect = screen.getAllByRole("combobox")[1] as HTMLSelectElement;
    fireEvent.change(protocolSelect, { target: { value: "UDP" } });
    expect(screen.getByDisplayValue("5060")).toBeInTheDocument();
  });

  it("calls setSipConfig with updated fields on save", () => {
    render(<SipSettings />);
    const saveButton = screen.getByRole("button", { name: /^save$/i });
    fireEvent.click(saveButton);
    // The component saves the local config (initialized from store)
    expect(mockStore.setSipConfig).toHaveBeenCalled();
  });

  it("renders with pre-filled server value", () => {
    mockStore.sipConfig.server = "sip.test.com";
    render(<SipSettings />);
    expect(screen.getByDisplayValue("sip.test.com")).toBeInTheDocument();
  });

  it("only reveals the password after the user clicks show", () => {
    mockStore.sipConfig = { ...mockStore.sipConfig, password: "secret123" };
    render(<SipSettings />);
    const input = screen.getByPlaceholderText(/••••••••/) as HTMLInputElement;
    expect(input.value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: /show password/i }));
    expect(input.value).toBe("secret123");
    expect(input.type).toBe("text");
  });

  it("disables the TLS option when a VoIP.ms server is selected", () => {
    mockStore.sipConfig.server = "atlanta.voip.ms";
    render(<SipSettings />);
    const protocolSelect = screen.getAllByRole("combobox")[1] as HTMLSelectElement;
    const tlsOption = Array.from(protocolSelect.options).find((o) => o.value === "TLS");
    expect(tlsOption?.disabled).toBe(true);
    expect(tlsOption?.textContent).toContain("not implemented with VoIP.ms");
  });

  it("keeps TLS enabled for non-VoIP.ms servers", () => {
    mockStore.sipConfig.server = "sip.example.com";
    render(<SipSettings />);
    const protocolSelect = screen.getAllByRole("combobox")[1] as HTMLSelectElement;
    const tlsOption = Array.from(protocolSelect.options).find((o) => o.value === "TLS");
    expect(tlsOption?.disabled).toBe(false);
    expect(tlsOption?.textContent).toBe("TLS");
  });

  it("shows the TLS-not-implemented notice when a VoIP.ms server is selected", () => {
    mockStore.sipConfig.server = "atlanta.voip.ms";
    render(<SipSettings />);
    expect(screen.getByText(/TLS is greyed out/i)).toBeInTheDocument();
  });

  it("auto-switches to TCP when selecting a VoIP.ms server while TLS is active", () => {
    mockStore.sipConfig = { ...mockStore.sipConfig, protocol: "TLS", port: 5061, server: "" };
    render(<SipSettings />);
    const providerSelect = screen.getAllByRole("combobox")[0] as HTMLSelectElement;
    fireEvent.change(providerSelect, { target: { value: "atlanta.voip.ms" } });
    const protocolSelect = screen.getAllByRole("combobox")[1] as HTMLSelectElement;
    expect(protocolSelect.value).toBe("TCP");
    expect(screen.getByDisplayValue("5060")).toBeInTheDocument();
    expect(mockStore.addDiagnosticLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warning",
        message: expect.stringContaining("not implemented with VoIP.ms"),
      })
    );
  });

  it("normalizes a persisted VoIP.ms + TLS config to TCP on load", () => {
    mockStore.sipConfig = { ...mockStore.sipConfig, protocol: "TLS", port: 5061, server: "atlanta.voip.ms" };
    render(<SipSettings />);
    const protocolSelect = screen.getAllByRole("combobox")[1] as HTMLSelectElement;
    expect(protocolSelect.value).toBe("TCP");
    expect(screen.getByDisplayValue("5060")).toBeInTheDocument();
  });
});
