import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { ToastWindow } from "./components/ToastWindow";

// Install the Tauri bridge (window.callerflash) on app startup.
// This ensures the existing UI code works unchanged on both Tauri
// and Electron — the bridge wraps Tauri invoke/listen into the
// familiar Electron-style IPC surface.
import "./tauri-bridge";

// Two render modes share the same bundled HTML:
//   • Normal app:    index.html           → <App />
//   • Toast window:  index.html?toast=1   → <ToastWindow /> (legacy — not used in Tauri)
const isToastWindow =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("toast") === "1";

if (isToastWindow && typeof document !== "undefined") {
  document.body.classList.add("toast-window");
}

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found — check index.html for <div id='root'>");
}
createRoot(rootEl).render(
  <StrictMode>
    {isToastWindow ? <ToastWindow /> : <App />}
  </StrictMode>
);
