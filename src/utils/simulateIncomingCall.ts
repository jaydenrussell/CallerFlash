import { useAppStore, type CallRecord } from '../store/useAppStore';
import { sanitizeCallerNumberForClipboard } from '../security/secretRedactor';

const sampleCallers = [
  { number: '(514) 555-0123', name: 'John Smith' },
  { number: '(416) 555-0456', name: 'Jane Doe' },
  { number: '(604) 555-0789', name: 'Client Services' },
  { number: '(905) 555-1234', name: 'Dr. Wilson' },
  { number: '(613) 555-5678', name: 'Mary Johnson' },
  { number: '(438) 555-9012', name: 'Bob Williams' },
  { number: '(647) 555-3456', name: 'Sarah Davis' },
  { number: '(250) 555-7890', name: 'Tech Support' },
];

// Track the popup window so repeated calls reuse the same window.
let toastPopup: Window | null = null;

/**
 * Show a toast in a SEPARATE, independent window — always.
 *   • Electron → IPC to dedicated always-on-top BrowserWindow
 *   • Web      → window.open() popup (real browser window)
 *
 * The toast NEVER renders inside the main app window.
 */
function showSeparateToast(data: {
  id: string;
  callerNumber: string;
  callerName: string;
  timestamp: string;
  config: {
    duration: number;
    backgroundColor: string;
    accentColor: string;
    textColor: string;
    borderRadius: number;
    opacity: number;
    fontFamily: string;
    fontSize: number;
    autoCopyToClipboard: boolean;
    showCallerName: boolean;
    showTimestamp: boolean;
    maxWidth: number;
    style: 'native' | 'custom';
  };
}) {
  const c = data.config;

  // ── Native style: OS-level notification only ────────────────────
  if (c.style === 'native') {
    if (window.callerflash?.notify?.show) {
      window.callerflash.notify.show({ title: 'Incoming Call', body: `${data.callerNumber}${data.callerName ? ` - ${data.callerName}` : ''}`, urgency: 'critical', timeoutType: 'never' });
    }
    // Auto-copy to clipboard if enabled
    if (c.autoCopyToClipboard && data.callerNumber && navigator.clipboard) {
      navigator.clipboard.writeText(data.callerNumber).catch(() => {});
    }
    return;
  }

  // ── Custom style: dedicated branded toast window only ──────────
  if (window.callerflash?.toast?.show) {
    window.callerflash.toast.show(data);
    return;
  }

  // ── Fallback when toast bridge unavailable: native notification ──
  if (window.callerflash?.notify?.show) {
    window.callerflash.notify.show({ title: 'Incoming Call', body: `${data.callerNumber}${data.callerName ? ` - ${data.callerName}` : ''}`, urgency: 'critical', timeoutType: 'never' });
  }

  // ── Web fallback: popup window ──────────────────────────────────
  if (typeof window === 'undefined') return;

  const ts = new Date(data.timestamp).toLocaleTimeString();
  const durationMs = c.duration * 1000;
  const popupWidth = Math.min(c.maxWidth, 440);
  const popupHeight = 170;

  // Position near top-right of the primary screen.
  const left = Math.round(screen.width - popupWidth - 40);
  const top = Math.round(screen.height * 0.05);

  // Close any existing toast popup before opening a new one.
  try { toastPopup?.close(); } catch { /* noop */ }

  toastPopup = window.open(
    '',
    'callerflash-toast-' + data.id,
    'width=' + popupWidth + ',height=' + popupHeight +
    ',left=' + left + ',top=' + top +
    ',toolbar=no,menubar=no,location=no,status=no' +
    ',scrollbars=no,resizable=no,noopener=no',
  );

  if (!toastPopup) return; // popup blocked

  const callerNameHtml = c.showCallerName && data.callerName
    ? '<div style="display:flex;align-items:center;gap:5px;margin-top:4px;">' +
      '<span style="font-size:' + (c.fontSize - 2) + 'px;color:' + c.textColor + 'bb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
      data.callerName + '</span></div>'
    : '';

  const timestampHtml = c.showTimestamp
    ? '<span style="font-size:' + (c.fontSize - 4) + 'px;color:' + c.textColor + '70;">' + ts + '</span>'
    : '';

  const copyHintHtml = c.autoCopyToClipboard
    ? '<p style="margin:6px 0 0;font-size:' + Math.max(c.fontSize - 5, 9) + 'px;color:' + c.textColor + '40;">📋 Number auto-copied to clipboard</p>'
    : '';

  const html = '<!DOCTYPE html>' +
    '<html><head><style>' +
    '*{margin:0;padding:0;box-sizing:border-box}' +
    'html,body{width:100%;height:100%;overflow:hidden;background:transparent;font-family:' + c.fontFamily + ',system-ui,sans-serif}' +
    '@keyframes slideIn{from{transform:translateY(-100%);opacity:0}to{transform:translateY(0);opacity:1}}' +
    '@keyframes pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.8);opacity:0}}' +
    '.toast{position:fixed;inset:8px;animation:slideIn .35s cubic-bezier(.16,1,.3,1) forwards;overflow:hidden;border:1px solid rgba(255,255,255,.1);box-shadow:0 12px 40px rgba(0,0,0,.5)}' +
    '.accent-bar{position:absolute;top:0;left:0;width:4px;height:100%}' +
    '.body{padding:14px 14px 14px 18px;display:flex;gap:10px}' +
    '.icon-wrap{flex-shrink:0;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;position:relative}' +
    '.ping{position:absolute;top:-2px;right:-2px;width:10px;height:10px;border-radius:50%;animation:pulse 1.2s ease-in-out infinite}' +
    '.ping-solid{position:absolute;top:-2px;right:-2px;width:10px;height:10px;border-radius:50%}' +
    '.info{flex:1;min-width:0}' +
    '.header{display:flex;justify-content:space-between;align-items:center;gap:6px}' +
    '.title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.number{font-weight:700;margin-top:5px;letter-spacing:.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.progress-track{position:absolute;bottom:0;left:0;width:100%;height:3px}' +
    '.progress-bar{height:100%;transition:width 100ms linear}' +
    '</style></head><body>' +
    '<div class="toast" style="background:' + c.backgroundColor + ';border-radius:' + c.borderRadius + 'px;opacity:' + (c.opacity / 100) + ';">' +
    '<div class="accent-bar" style="background:' + c.accentColor + ';"></div>' +
    '<div class="body">' +
    '<div class="icon-wrap" style="background:' + c.accentColor + '20;">' +
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="' + c.accentColor + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>' +
    '<div class="ping" style="background:#6ccb5f;"></div>' +
    '<div class="ping-solid" style="background:#6ccb5f;"></div>' +
    '</div>' +
    '<div class="info">' +
    '<div class="header">' +
    '<span class="title" style="color:' + c.accentColor + ';font-size:' + (c.fontSize - 2) + 'px;">Incoming Call</span>' +
    timestampHtml +
    '</div>' +
    '<div class="number" style="color:' + c.textColor + ';font-size:' + (c.fontSize + 4) + 'px;">' + data.callerNumber + '</div>' +
    callerNameHtml +
    copyHintHtml +
    '</div></div>' +
    '<div class="progress-track" style="background:' + c.accentColor + '10;">' +
    '<div class="progress-bar" id="pb" style="width:100%;background:' + c.accentColor + ';"></div>' +
    '</div></div>' +
    '<script>' +
    '(function(){var s=Date.now(),d=' + durationMs + ',iv=setInterval(function(){var r=Math.max(0,d-(Date.now()-s));document.getElementById("pb").style.width=(r/d*100)+"%";if(r<=0)clearInterval(iv)},80);setTimeout(function(){window.close()},d+200)})();' +
    '</' + 'script></body></html>';

  toastPopup.document.write(html);
  toastPopup.document.close();

  // Bring the popup to front
  try { toastPopup.focus(); } catch { /* noop */ }

  // Auto-copy to clipboard (web).
  if (c.autoCopyToClipboard && data.callerNumber) {
    navigator.clipboard?.writeText(data.callerNumber).catch(() => {});
  }
}

export function simulateIncomingCall(source: 'dashboard' | 'toast-settings' | 'background' = 'dashboard') {
  const store = useAppStore.getState();
  const { addCallRecord, addDiagnosticLog, isMinimized } = store;
  const caller = sampleCallers[Math.floor(Math.random() * sampleCallers.length)];

  const safeName = caller.name.replace(/[^\x20-\x7E]/g, '').slice(0, 64);
  const safeNumber = sanitizeCallerNumberForClipboard(caller.number);

  const record: CallRecord = {
    id: crypto.randomUUID(),
    callerNumber: caller.number,
    callerName: safeName,
    timestamp: new Date(),
    duration: 0,
    direction: 'inbound' as const,
    status: 'answered' as const,
  };

  addCallRecord(record);

  // ── Show notification based on selected style ──────────────────────
  if (store.toastConfig.style === 'native') {
    // Native style: ONLY the OS notification — no in-app toast
    if (window.callerflash?.notify?.show) {
      window.callerflash.notify.show({ title: 'Incoming Call', body: `${record.callerNumber}${record.callerName ? ` - ${record.callerName}` : ''}`, urgency: 'critical', timeoutType: 'never' });
    }
  } else {
    // Custom/Branded style: always-on-top inline HTML window ONLY
    // Do NOT call store.addToast — the toast renders in a separate
    // independent BrowserWindow, not inside the main app UI.
    if (window.callerflash?.toast?.show) {
      window.callerflash.toast.show({
        id: record.id,
        callerNumber: record.callerNumber,
        callerName: record.callerName,
        timestamp: record.timestamp.toISOString(),
        config: {
          duration: store.toastConfig.duration,
          backgroundColor: store.toastConfig.backgroundColor,
          accentColor: store.toastConfig.accentColor,
          textColor: store.toastConfig.textColor,
          borderRadius: store.toastConfig.borderRadius,
          opacity: store.toastConfig.opacity,
          fontFamily: store.toastConfig.fontFamily,
          fontSize: store.toastConfig.fontSize,
          autoCopyToClipboard: store.toastConfig.autoCopyToClipboard,
          showCallerName: store.toastConfig.showCallerName,
          showTimestamp: store.toastConfig.showTimestamp,
          maxWidth: store.toastConfig.maxWidth,
          style: store.toastConfig.style,
        },
      });
    }
  }

  // Auto-copy to clipboard if enabled
  if (store.toastConfig.autoCopyToClipboard && record.callerNumber) {
    try { navigator.clipboard?.writeText(safeNumber).catch(() => {}); } catch {}
  }

  addDiagnosticLog({
    level: 'info',
    category: 'SIP',
    message: `INVITE received from ${caller.number} (${safeName})`,
    details: `Source: ${source}${isMinimized ? ' • app minimized' : ''}`,
  });
  addDiagnosticLog({
    level: 'info',
    category: 'TOAST',
    message: `Toast displayed for ${caller.number} (${store.toastConfig.style === 'custom' ? 'Modern' : 'Native Windows'} style)`,
  });
}
