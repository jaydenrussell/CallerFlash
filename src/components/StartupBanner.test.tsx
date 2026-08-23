import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { StartupBanner } from "./StartupBanner";
import type { StartupReport } from "../bridge-types";

const report = (over: Partial<StartupReport> = {}): StartupReport => ({
  checks: [
    { name: "settings-readable", ok: true, message: null },
    { name: "data-dir-writable", ok: true, message: null },
  ],
  all_ok: true,
  os_name: "windows",
  os_version: "10.0.26100",
  is_windows_11: true,
  edition: "Pro",
  ...over,
});

describe("StartupBanner", () => {
  it("renders nothing when all checks pass", async () => {
    const fetchReport = vi.fn().mockResolvedValue(report());
    const { container } = render(<StartupBanner fetchReport={fetchReport} />);
    await waitFor(() => expect(fetchReport).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("lists failed checks and OS warning", async () => {
    const fetchReport = vi.fn().mockResolvedValue(
      report({
        all_ok: false,
        os_name: "windows",
        is_windows_11: false,
        os_version: "10.0.19045",
        edition: "Home",
        checks: [
          { name: "settings-readable", ok: false, message: "corrupt JSON" },
          { name: "data-dir-writable", ok: true, message: null },
        ],
      }),
    );
    render(<StartupBanner fetchReport={fetchReport} />);
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("settings-readable");
    expect(banner.textContent).toContain("corrupt JSON");
    expect(banner.textContent).toContain("10.0.19045");
    expect(banner.textContent).not.toContain("data-dir-writable");
  });

  it("stays hidden when only non-Windows or healthy OS rows exist", async () => {
    const fetchReport = vi.fn().mockResolvedValue(report({ os_name: "linux" }));
    const { container } = render(<StartupBanner fetchReport={fetchReport} />);
    await waitFor(() => expect(fetchReport).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("dismisses on click", async () => {
    const fetchReport = vi.fn().mockResolvedValue(
      report({ all_ok: false, checks: [{ name: "a", ok: false, message: "b" }] }),
    );
    render(<StartupBanner fetchReport={fetchReport} />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByLabelText(/dismiss startup warnings/i));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("survives a rejecting bridge", async () => {
    const fetchReport = vi.fn().mockRejectedValue(new Error("no bridge"));
    const { container } = render(<StartupBanner fetchReport={fetchReport} />);
    await waitFor(() => expect(fetchReport).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
