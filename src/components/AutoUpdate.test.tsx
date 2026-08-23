import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { AutoUpdate } from "./AutoUpdate";

// Realistic backend listReleases output: recent betas carry empty titles
// (releases created without --title) and v2.2.1 is the newest stable.
const RELEASES = [
  {
    tagName: "v2.2.3-beta",
    name: "",
    publishedAt: "2026-08-23T01:10:00Z",
    prerelease: true,
    body: "* fix(updater): send User-Agent to GitHub API\r\n* other change",
    htmlUrl: "https://github.com/jaydenrussell/CallerFlash/releases/tag/v2.2.3-beta",
  },
  {
    tagName: "v2.2.2-beta",
    name: "",
    publishedAt: "2026-08-23T00:45:00Z",
    prerelease: true,
    body: null,
    htmlUrl: "https://github.com/jaydenrussell/CallerFlash/releases/tag/v2.2.2-beta",
  },
  {
    tagName: "v2.2.1",
    name: "v2.2.1",
    publishedAt: "2026-08-22T21:23:08Z",
    prerelease: false,
    body: "* chore(deps): bump rsipstack to 0.6.4",
    htmlUrl: "https://github.com/jaydenrussell/CallerFlash/releases/tag/v2.2.1",
  },
  {
    tagName: "v2.2.0",
    name: "v2.2.0",
    publishedAt: "2026-08-22T20:00:00Z",
    prerelease: false,
    body: null,
    htmlUrl: "https://github.com/jaydenrussell/CallerFlash/releases/tag/v2.2.0",
  },
];

const mockStore = vi.hoisted(() => {
  interface UpdateInfoShape {
    currentVersion: string;
    latestVersion: string;
    updateAvailable: boolean;
    lastChecked: Date | null;
    autoUpdate: boolean;
    autoDownload: boolean;
    updateChannel: "stable" | "beta";
    updateCheckFrequency: "off" | "daily" | "weekly" | "monthly";
    githubRepo: string;
    releaseNotes: string;
    releasePageUrl: string;
    downloadProgress: number;
    isDownloading: boolean;
    isInstalling: boolean;
  }
  const store: {
    updateInfo: UpdateInfoShape;
    setUpdateInfo: (patch: Partial<UpdateInfoShape>) => void;
    addDiagnosticLog: ReturnType<typeof vi.fn>;
  } = {
    updateInfo: {
      currentVersion: "2.2.2-beta",
      latestVersion: "",
      updateAvailable: false,
      lastChecked: null,
      autoUpdate: true,
      autoDownload: false,
      updateChannel: "beta",
      updateCheckFrequency: "off",
      githubRepo: "https://github.com/jaydenrussell/CallerFlash",
      releaseNotes: "",
      releasePageUrl: "",
      downloadProgress: 0,
      isDownloading: false,
      isInstalling: false,
    },
    // Mirrors the real store's merge semantics so tests can drive state.
    setUpdateInfo: (patch) => {
      store.updateInfo = { ...store.updateInfo, ...patch };
    },
    addDiagnosticLog: vi.fn(),
  };
  return store;
});

vi.mock("../store/useAppStore", () => ({
  useAppStore: (selector?: (s: typeof mockStore) => unknown) =>
    selector ? selector(mockStore) : mockStore,
}));

function setUpdater(overrides: Record<string, unknown> = {}) {
  (window as unknown as Record<string, unknown>).callerflash = {
    updater: {
      listReleases: vi.fn(async () => structuredClone(RELEASES)),
      check: vi.fn(async () => ({ upToDate: true })),
      ...overrides,
    },
  };
}

describe("AutoUpdate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.updateInfo = {
      currentVersion: "2.2.2-beta",
      latestVersion: "",
      updateAvailable: false,
      lastChecked: null,
      autoUpdate: true,
      autoDownload: false,
      updateChannel: "beta",
      updateCheckFrequency: "off" as const,
      githubRepo: "https://github.com/jaydenrussell/CallerFlash",
      releaseNotes: "",
      releasePageUrl: "",
      downloadProgress: 0,
      isDownloading: false,
      isInstalling: false,
    };
    setUpdater();
  });

  it("lists beta releases on the beta channel", async () => {
    render(<AutoUpdate />);
    expect(await screen.findByText("2.2.3-beta")).toBeTruthy();
    expect(screen.getByText("2.2.2-beta")).toBeTruthy();
  });

  it("switching to stable lists stable releases without crashing", async () => {
    const view = render(<AutoUpdate />);
    await screen.findByText("2.2.3-beta");
    fireEvent.click(screen.getByRole("button", { name: /Stable/i }));
    // The real store applies the patch synchronously and notifies
    // subscribers; emulate that with a merged state + rerender.
    act(() => {
      mockStore.setUpdateInfo({ updateChannel: "stable" });
      view.rerender(<AutoUpdate />);
    });
    expect(await screen.findByText("2.2.1")).toBeTruthy();
    expect(screen.getByText("2.2.0")).toBeTruthy();
    expect(screen.queryByText("2.2.3-beta")).toBeNull();
  });

  it("renders with stable as the initial channel", async () => {
    mockStore.updateInfo = { ...mockStore.updateInfo, updateChannel: "stable" };
    render(<AutoUpdate />);
    expect(await screen.findByText("2.2.1")).toBeTruthy();
  });

  it("shows an explicit error when the release fetch fails", async () => {
    setUpdater({
      listReleases: vi.fn(async () => {
        throw new Error("GitHub API returned 403 Forbidden.");
      }),
    });
    render(<AutoUpdate />);
    expect(await screen.findByText(/403 Forbidden/)).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
  });
});
