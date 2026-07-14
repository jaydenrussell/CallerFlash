import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const elNumber = document.getElementById('callerNumber') as HTMLElement | null;
const elName = document.getElementById('callerName') as HTMLElement | null;
const elTime = document.getElementById('timestamp') as HTMLElement | null;
const elTitle = document.getElementById('headerTitle') as HTMLElement | null;
const elInner = document.getElementById('toastInner') as HTMLElement | null;
const elIcon = document.getElementById('iconRing') as HTMLElement | null;
const elProg = document.getElementById('progressFill') as HTMLElement | null;

let hideTimer: ReturnType<typeof setTimeout> | null = null;
let progTimer: ReturnType<typeof setInterval> | null = null;

function fmt(iso: string | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

interface ToastPayload {
  callerNumber?: string;
  callerName?: string;
  timestamp?: string;
  config?: {
    duration?: number;
    fontFamily?: string;
    fontSize?: number;
    backgroundColor?: string;
    accentColor?: string;
    borderRadius?: number;
    opacity?: number;
    showTimestamp?: boolean;
    soundEnabled?: boolean;
    soundName?: string;
  };
}

function show(data: ToastPayload): void {
  if (!data) return;
  const c = data.config || {};
  const dur = (typeof c.duration === 'number' ? c.duration : 5) * 1000;

  if (elNumber) elNumber.textContent = data.callerNumber || 'Unknown';
  if (elName) {
    elName.textContent = data.callerName || '';
    elName.style.display = data.callerName ? '' : 'none';
  }
  if (elTime) {
    elTime.textContent = fmt(data.timestamp);
    elTime.style.display = c.showTimestamp !== false ? '' : 'none';
  }

  if (c.fontFamily) document.body.style.fontFamily = c.fontFamily;
  if (c.fontSize && elNumber) {
    const b = Math.min(36, Math.max(12, c.fontSize));
    elNumber.style.fontSize = b + 'px';
    if (elName) elName.style.fontSize = Math.max(12, b - 4) + 'px';
  }

  const toastEl = document.getElementById('toast');
  if (c.backgroundColor && toastEl) toastEl.style.background = c.backgroundColor;
  if (c.accentColor && elIcon) {
    elIcon.style.setProperty('--accent', c.accentColor);
    if (elTitle) elTitle.style.color = c.accentColor;
    if (elProg) {
      elProg.style.background = c.accentColor;
      elProg.style.boxShadow = '0 0 6px ' + c.accentColor + ', 0 0 20px ' + c.accentColor + '80';
    }
  }
  if (c.borderRadius && toastEl) toastEl.style.borderRadius = c.borderRadius + 'px';
  if (c.opacity !== undefined && toastEl) toastEl.style.opacity = String(c.opacity);

  if (elProg) elProg.style.width = '100%';
  if (progTimer) { clearInterval(progTimer); progTimer = null; }
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }

  if (dur > 0) {
    const start = Date.now();
    progTimer = setInterval(() => {
      const pct = Math.max(0, (dur - (Date.now() - start)) / dur * 100);
      if (elProg) elProg.style.width = pct + '%';
      if (pct <= 0 && progTimer) clearInterval(progTimer);
    }, 30);
    hideTimer = setTimeout(() => {
      if (progTimer) { clearInterval(progTimer); progTimer = null; }
      invoke('toast_hide').catch((e) => console.error('[toast] hide on timeout failed:', e));
    }, dur);
  } else {
    if (elProg) elProg.style.width = '0%';
  }

  if (c.soundEnabled !== false) playTone(c.soundName ?? 'chime');
}

function playTone(t: string): void {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.connect(g);
    g.connect(ctx.destination);
    if (t === 'ring') {
      osc.type = 'sine'; osc.frequency.value = 440; g.gain.value = 0.3;
      osc.start(); osc.stop(ctx.currentTime + 0.5);
    } else if (t === 'beep') {
      osc.type = 'square'; osc.frequency.value = 800; g.gain.value = 0.2;
      osc.start(); osc.stop(ctx.currentTime + 0.15);
    } else if (t === 'gentle') {
      osc.type = 'sine'; osc.frequency.value = 523; g.gain.value = 0.15;
      g.gain.setValueAtTime(0.15, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.8);
      osc.start(); osc.stop(ctx.currentTime + 0.8);
    } else {
      osc.type = 'sine'; osc.frequency.value = 880; g.gain.value = 0.2;
      osc.start(); osc.stop(ctx.currentTime + 0.2);
    }
  } catch {
    console.log('[toast] audio error');
  }
}

async function init(): Promise<void> {
  await listen<ToastPayload>('toast:show:event', (e) => {
    if (e && e.payload) show(e.payload);
  });

  try {
    const d = await invoke<ToastPayload | null>('toast_get_initial');
    if (d) show(d);
  } catch {
    // no initial data
  }

  if (elInner) {
    elInner.addEventListener('click', () => {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      if (progTimer) { clearInterval(progTimer); progTimer = null; }
      invoke('toast_hide').catch((e) => console.error('[toast] hide on click failed:', e));
    });
  }
}

init().catch((e) => console.error('[toast] init failed:', e));
