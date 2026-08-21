/// <reference types="vitest/config" />
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkg = JSON.parse(readFileSync(path.join(__dirname, "package.json"), "utf-8"));

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_REPO__: JSON.stringify("https://github.com/jaydenrussell/CallerFlash"),
    __APP_BUILD_TIMESTAMP__: Date.now(),
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    coverage: {
      provider: "v8",
      // Full-file mode: every source file counts, untested ones included.
      // Floors sit just under the current baseline (~12%) as a ratchet —
      // new untested code drags the average down, so coverage can only
      // improve. Raise as tests are added.
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.*", "src/test-setup.ts"],
      thresholds: {
        statements: 11,
        branches: 11,
        functions: 11,
        lines: 12,
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        toast: path.resolve(__dirname, "toast.html"),
      },
    },
  },
});
