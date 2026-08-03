import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

// Install the Tauri bridge (window.callerflash) on app startup.
// This ensures the existing UI code works unchanged on Tauri.
import "./tauri-bridge";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found — check index.html for <div id='root'>");
}
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>
);
