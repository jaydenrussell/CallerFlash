import { describe, it, expect, vi, beforeEach } from "vitest";
import { backgroundUpdateCheck } from "./backgroundUpdateCheck";
import { useAppStore } from "../store/useAppStore";

function setChannel(channel: "stable" | "beta") {
  const current = useAppStore.getState().updateInfo;
  useAppStore.setState({ updateInfo: { ...current, updateChannel: channel, lastChecked: null } });
}

describe("backgroundUpdateCheck", () => {
  let check: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    check = vi.fn();
    (window as unknown as Record<string, unknown>).callerflash = {
      updater: { check },
    };
    setChannel("stable");
    useAppStore.setState({ diagnosticLogs: [] });
  });

  it("checks the user's selected channel, not a hardcoded one", async () => {
    setChannel("beta");
    check.mockResolvedValue({ upToDate: true });
    await backgroundUpdateCheck("startup");
    expect(check).toHaveBeenCalledWith("beta");
  });

  it("checks the stable channel when stable is selected", async () => {
    check.mockResolvedValue({ upToDate: true });
    await backgroundUpdateCheck("scheduled");
    expect(check).toHaveBeenCalledWith("stable");
  });

  it("persists lastChecked on the up-to-date path so the scheduler does not re-fire", async () => {
    check.mockResolvedValue({ upToDate: true });
    expect(useAppStore.getState().updateInfo.lastChecked).toBeNull();
    await backgroundUpdateCheck("startup");
    expect(useAppStore.getState().updateInfo.lastChecked).toBeInstanceOf(Date);
    expect(useAppStore.getState().updateInfo.updateAvailable).toBe(false);
  });

  it("records an available update from the selected channel", async () => {
    setChannel("beta");
    check.mockResolvedValue({ version: "2.4.0-beta", downloadUrl: "https://example.com/x" });
    await backgroundUpdateCheck("scheduled");
    const info = useAppStore.getState().updateInfo;
    expect(info.latestVersion).toBe("2.4.0-beta");
    expect(info.updateAvailable).toBe(true);
    expect(info.lastChecked).toBeInstanceOf(Date);
  });

  it("does NOT advance lastChecked on a failed check (scheduler must retry)", async () => {
    check.mockResolvedValue({ error: "network down" });
    await backgroundUpdateCheck("startup");
    expect(useAppStore.getState().updateInfo.lastChecked).toBeNull();
    const logs = useAppStore.getState().diagnosticLogs;
    expect(logs[0].level).toBe("warning");
    expect(logs[0].message).toContain("network down");
  });

  it("logs a warning if the bridge violates its resolve-errors contract", async () => {
    check.mockRejectedValue(new Error("bridge blew up"));
    await backgroundUpdateCheck("startup");
    expect(useAppStore.getState().updateInfo.lastChecked).toBeNull();
    const logs = useAppStore.getState().diagnosticLogs;
    expect(logs[0].level).toBe("warning");
    expect(logs[0].message).toContain("bridge blew up");
  });

  it("never checks when the frequency is off", async () => {
    const current = useAppStore.getState().updateInfo;
    useAppStore.setState({ updateInfo: { ...current, updateCheckFrequency: "off", lastChecked: null } });
    await backgroundUpdateCheck("startup");
    await backgroundUpdateCheck("scheduled");
    expect(check).not.toHaveBeenCalled();
    expect(useAppStore.getState().diagnosticLogs).toHaveLength(0);
  });

  it("skips the startup check when one already ran within the interval", async () => {
    const current = useAppStore.getState().updateInfo;
    useAppStore.setState({
      updateInfo: { ...current, updateCheckFrequency: "daily", lastChecked: new Date(Date.now() - 60 * 60 * 1000) },
    });
    await backgroundUpdateCheck("startup");
    expect(check).not.toHaveBeenCalled();
    expect(useAppStore.getState().diagnosticLogs).toHaveLength(0);
  });
});
