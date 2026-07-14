import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// Mock window.callerflash for all component tests
Object.defineProperty(window, "callerflash", {
  value: {
    notify: {
      show: vi.fn(),
      requestPermission: vi.fn().mockResolvedValue("granted"),
      isPermissionGranted: vi.fn().mockResolvedValue(true),
    },
    storage: {
      save: vi.fn().mockResolvedValue(undefined),
    },
    upgrader: {
      check: vi.fn(),
      download: vi.fn(),
      install: vi.fn(),
    },
    config: {
      getLogDir: vi.fn(),
    },
  },
  writable: true,
  configurable: true,
});
