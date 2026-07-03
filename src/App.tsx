import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { Dashboard } from './components/Dashboard';
import { CallHistory } from './components/CallHistory';
import { SipSettings } from './components/SipSettings';
import { Preferences } from './components/Preferences';
import { ToastSettings } from './components/ToastSettings';
import { Diagnostics } from './components/Diagnostics';
import { AutoUpdate } from './components/AutoUpdate';
import { About } from './components/About';
import { ToastContainer } from './components/ToastNotification';
import { useAppStore } from './store/useAppStore';
import { AppWindow, Minus, PhoneIncoming, Square, Undo2, Wifi, WifiOff, X } from 'lucide-react';
import { simulateIncomingCall } from './utils/simulateIncomingCall';
import { formatVersion } from './utils/formatVersion';

// Threshold below which the sidebar collapses to icons only
const SIDEBAR_COLLAPSE_BREAKPOINT = 720;

function useWindowWidth() {
  const [width, setWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1280));

  useEffect(() => {
    const handleResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return width;
}

function TitleBar({ compact }: { compact: boolean }) {
  const { setIsMinimized, addDiagnosticLog, sipConnected, sipRegistered, updateInfo, setActiveTab } = useAppStore();

  // Both the minimize (−) and close (×) buttons hide the window to the
  // system tray. The app keeps running in the background; the user
  // restores it from the tray icon (left-click or "Show CallerFlash" menu).
  const hideToTray = () => {
    setIsMinimized(true);
    if (window.callerflash?.window?.hideToTray) {
      window.callerflash.window.hideToTray();
    } else {
      // Dev fallback (running outside Electron): just collapse to MinimizedShell.
      addDiagnosticLog({
        level: 'info',
        category: 'SYSTEM',
        message: 'Main window minimized to background mode',
      });
      return;
    }
    addDiagnosticLog({
      level: 'info',
      category: 'SYSTEM',
      message: 'Window hidden to system tray; SIP monitoring continues in background',
    });
  };

  // SIP status color: green = registered, yellow = connecting, red = offline
  const sipColor = sipConnected && sipRegistered
    ? '#6ccb5f'
    : sipConnected
    ? '#fcb827'
    : '#ff6b6b';
  const sipLabel = sipConnected && sipRegistered
    ? 'Registered'
    : sipConnected
    ? 'Connecting'
    : 'Offline';

  return (
    // Titlebar is the OS drag region. The `WebkitAppRegion: drag`
    // makes the whole bar draggable, and `no-drag` on the buttons
    // below keeps them clickable. Required because we use
    // `titleBarStyle: 'hidden'` so the OS chrome is hidden.
    <div
      className="h-9 bg-win-card border-b border-win-border flex items-center justify-between select-none flex-shrink-0"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="flex items-center gap-2 px-3 min-w-0 flex-1">
        <div className="w-4 h-4 rounded bg-gradient-to-br from-win-accent to-blue-600 flex items-center justify-center flex-shrink-0">
          <svg viewBox="0 0 24 24" className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" strokeWidth="3">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
          </svg>
        </div>
        <span className="text-xs text-win-text-secondary truncate">
          {compact ? 'CallerFlash' : 'CallerFlash — SIP Client'}
        </span>
        {/* SIP status: traffic-light dot */}
        <div
          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: sipColor }}
          title={sipLabel}
        />
        {/* Update available indicator — click to go to Updates tab */}
        {updateInfo.updateAvailable && (
          <button
            onClick={() => setActiveTab('update')}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 transition-colors flex-shrink-0"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            title={`Update ${formatVersion(updateInfo.latestVersion)} available — click to open`}
          >
            <div className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            <span className="text-[10px] font-semibold text-amber-400">Update</span>
          </button>
        )}
      </div>
      <div className="flex h-full flex-shrink-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          onClick={hideToTray}
          className="px-3 sm:px-4 h-full hover:bg-win-surface-hover transition-colors flex items-center"
          title="Minimize to tray"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <Minus className="w-3.5 h-3.5 text-win-text-secondary" />
        </button>
        <button
          onClick={() => window.callerflash?.window?.maximize?.()}
          className="px-3 sm:px-4 h-full hover:bg-win-surface-hover transition-colors flex items-center"
          title="Maximize / Restore"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <Square className="w-3 h-3 text-win-text-secondary" />
        </button>
        <button
          onClick={hideToTray}
          className="px-3 sm:px-4 h-full hover:bg-red-600 transition-colors flex items-center group"
          title="Hide to system tray"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <X className="w-3.5 h-3.5 text-win-text-secondary group-hover:text-white" />
        </button>
      </div>
    </div>
  );
}

function MainContent() {
  const { activeTab } = useAppStore();

  const content = {
    dashboard: <Dashboard />,
    calls: <CallHistory />,
    settings: <SipSettings />,
    preferences: <Preferences />,
    toast: <ToastSettings />,
    diagnostics: <Diagnostics />,
    update: <AutoUpdate />,
    about: <About />,
  };

  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6 min-w-0">
      {content[activeTab]}
    </div>
  );
}

function MinimizedShell() {
  const { sipConnected, sipRegistered, setIsMinimized, addDiagnosticLog, appPreferences } = useAppStore();

  const restore = () => {
    setIsMinimized(false);
    if (window.callerflash?.window?.show) {
      window.callerflash.window.show();
    }
    addDiagnosticLog({ level: 'info', category: 'SYSTEM', message: 'Main window restored from background mode' });
  };

  const hideToTray = () => {
    if (window.callerflash?.window?.hideToTray) {
      window.callerflash.window.hideToTray();
    }
    addDiagnosticLog({ level: 'info', category: 'SYSTEM', message: 'Window hidden to system tray' });
  };

  return (
    <div className="relative flex-1 overflow-hidden bg-[radial-gradient(circle_at_top,#12324d_0%,#202020_38%,#141414_100%)]">
      <div className="absolute inset-0 bg-black/20" />
      <div className="absolute inset-x-3 sm:inset-x-auto bottom-3 sm:bottom-6 sm:right-6 z-20 sm:w-[360px] rounded-2xl border border-win-border bg-win-card/95 p-4 sm:p-5 shadow-2xl backdrop-blur-xl">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <div className="mt-0.5 flex h-11 w-11 items-center justify-center rounded-2xl bg-win-accent/15 text-win-accent flex-shrink-0">
              <AppWindow className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-win-text">CallerFlash is in background mode</p>
              <p className="mt-1 text-xs text-win-text-secondary">
                Window is hidden to the system tray. Incoming calls still trigger toast alerts and clipboard auto-copy.
              </p>
            </div>
          </div>
          <button
            onClick={restore}
            className="rounded-lg border border-win-border bg-win-surface px-2.5 py-1.5 text-xs font-medium text-win-text-secondary transition-colors hover:bg-win-surface-hover hover:text-win-text flex-shrink-0"
            title="Restore window"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <MiniStat
            icon={sipConnected ? <Wifi className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />}
            label="SIP Session"
            value={sipConnected ? (sipRegistered ? 'Registered' : 'Connecting') : 'Offline'}
            color={sipConnected ? (sipRegistered ? '#6ccb5f' : '#fcb827') : '#ff6b6b'}
          />
          <MiniStat
            icon={<AppWindow className="h-4 w-4" />}
            label="Launch Mode"
            value={appPreferences.startMinimized ? 'Start minimized' : 'Normal start'}
            color="#60cdff"
          />
        </div>

        <div className="mt-4 rounded-xl border border-win-success/20 bg-win-success/10 p-3">
          <p className="text-xs font-semibold text-win-success">Background call detection active</p>
          <p className="mt-1 text-xs leading-relaxed text-win-text-secondary">
            Hiding to the system tray does not stop SIP registration, inbound INVITE handling, toast notifications, or clipboard copying.
            Click the tray icon in the Windows notification area to bring the window back.
          </p>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            onClick={restore}
            className="flex-1 min-w-[140px] rounded-xl bg-win-accent px-4 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-win-accent-hover"
          >
            Restore Window
          </button>
          <button
            onClick={hideToTray}
            className="flex items-center gap-2 rounded-xl border border-win-border bg-win-surface px-4 py-2.5 text-sm font-medium text-win-text-secondary transition-colors hover:bg-win-surface-hover hover:text-win-text"
            title="Hide window to the system tray"
          >
            <AppWindow className="h-4 w-4" />
            Hide to Tray
          </button>
          <button
            onClick={() => simulateIncomingCall('background')}
            disabled={!sipConnected}
            className="flex items-center gap-2 rounded-xl border border-win-accent/20 bg-win-accent/10 px-4 py-2.5 text-sm font-medium text-win-accent transition-colors hover:bg-win-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <PhoneIncoming className="h-4 w-4" />
            Test Call
          </button>
        </div>
      </div>
    </div>
  );
}

function MiniStat({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div className="rounded-xl border border-win-border bg-win-surface p-3">
      <div className="mb-2 flex items-center gap-2 text-win-text-tertiary">
        <span style={{ color }}>{icon}</span>
        <span className="text-xs font-medium uppercase tracking-wider truncate">{label}</span>
      </div>
      <p className="text-sm font-semibold truncate" style={{ color }}>
        {value}
      </p>
    </div>
  );
}

export default function App() {
  const { isMinimized, setIsMinimized, addDiagnosticLog, appPreferences, sipConnected, sipRegistered, setActiveTab, sipConfig } = useAppStore();
  const width = useWindowWidth();
  const sidebarCollapsed = width < SIDEBAR_COLLAPSE_BREAKPOINT;
  const titleCompact = width < 520;

  useEffect(() => {
    if (appPreferences.startWithWindows) {
      addDiagnosticLog({ level: 'info', category: 'SYSTEM', message: 'Start with Windows preference loaded' });
    }
  }, []);

  // Check if this is the first run of a new update
  const [isFirstRunAfterUpdate, setIsFirstRunAfterUpdate] = useState(false);
  
  useEffect(() => {
    // Only access localStorage on client side
    if (typeof window !== 'undefined') {
      try {
        const raw = window.localStorage.getItem('callerflash-ui-settings');
        if (raw) {
          const settings = JSON.parse(raw);
          if (settings.lastRunVersion !== __APP_VERSION__) {
            setIsFirstRunAfterUpdate(true);
            settings.lastRunVersion = __APP_VERSION__;
            window.localStorage.setItem('callerflash-ui-settings', JSON.stringify(settings));
          }
        } else {
          // Brand new install
          setIsFirstRunAfterUpdate(true);
          window.localStorage.setItem('callerflash-ui-settings', JSON.stringify({ lastRunVersion: __APP_VERSION__ }));
        }
      } catch {
        // ignore
      }
    }
  }, []);

  // If "Start minimized" is enabled, hide to the system tray as soon as
  // the renderer mounts. The user sees only the tray icon.
  // We override this on the first run after a fresh install or an update so the user actually sees the app UI.
  useEffect(() => {
    if (!appPreferences.startMinimized || isFirstRunAfterUpdate) {
      if (isFirstRunAfterUpdate) {
        setIsMinimized(false);
        if (window.callerflash?.window?.show) {
          window.callerflash.window.show();
        }
      }
      return;
    }
    
    setIsMinimized(true);
    // Defer one tick so the IPC channel is wired up by the preload bridge.
    const t = setTimeout(() => {
      if (window.callerflash?.window?.hideToTray) {
        window.callerflash.window.hideToTray();
      }
      addDiagnosticLog({
        level: 'info',
        category: 'SYSTEM',
        message: 'Application launched in background mode (hidden to system tray)',
      });
    }, 50);
    return () => clearTimeout(t);
  }, [appPreferences.startMinimized, isFirstRunAfterUpdate]);

  // Auto-connect on startup if SIP settings are fully configured
  useEffect(() => {
    if (sipConfig.server && sipConfig.username && sipConfig.password && !sipConnected) {
      // Delay slightly to let the store hydrate from safeStorage
      const t = setTimeout(() => {
        addDiagnosticLog({ level: 'info', category: 'SIP', message: 'Auto-connecting to SIP server on startup...' });
        useAppStore.getState().connectSip();
      }, 1500);
      
      return () => clearTimeout(t);
    }
  }, [sipConfig.password]);

  // Subscribe to tray → renderer events. The main process fires these
  // when the user clicks the tray icon (left-click toggle or "Show/Hide"
  // menu entries). We keep the renderer's `isMinimized` flag in sync so
  // MinimizedShell vs full-UI swaps correctly.
  useEffect(() => {
    if (!window.callerflash?.window) return;
    const offRestored = window.callerflash.window.onRestoredFromTray?.(() => {
      setIsMinimized(false);
    });
    const offHidden = window.callerflash.window.onHiddenToTray?.(() => {
      setIsMinimized(true);
    });
    return () => {
      offRestored?.();
      offHidden?.();
    };
  }, [setIsMinimized]);

  // Listen for tray menu "navigate to updates" click.
  useEffect(() => {
    if (!window.callerflash?.window?.onNavigateToUpdate) return;
    const off = window.callerflash.window.onNavigateToUpdate(() => {
      setActiveTab('update');
    });
    return () => off?.();
  }, [setActiveTab]);

  // Listen for Real SIP Backend Status Events
  useEffect(() => {
    if (!window.callerflash?.sip?.onStatus) return;
    const unsubStatus = window.callerflash.sip.onStatus((data) => {
      if (data.status === 'registered') {
        useAppStore.setState({ sipRegistered: true, isConnecting: false });
        addDiagnosticLog({ level: 'success', category: 'SIP', message: 'REGISTER 200 OK (Registration active)' });
        addDiagnosticLog({ level: 'info', category: 'SIP', message: 'Ready for incoming calls' });
      } else if (data.status === 'error') {
        useAppStore.setState({ sipRegistered: false, isConnecting: false });
        addDiagnosticLog({ level: 'error', category: 'SIP', message: `SIP Error: ${data.message}` });
      }
    });

    const unsubLog = window.callerflash.sip.onLog?.((data) => {
      addDiagnosticLog({ level: 'info', category: 'SIP', message: data.message });
    });

    return () => {
      unsubStatus();
      unsubLog?.();
    };
  }, [addDiagnosticLog]);

  // Listen for Real SIP Inbound Calls
  useEffect(() => {
    if (!window.callerflash?.sip?.onInvite) return;
    return window.callerflash.sip.onInvite((callerData) => {
      const { toastConfig } = useAppStore.getState();
      const safeNumber = callerData.callerNumber;
      const safeName = callerData.callerName || '';

      const record = {
        id: crypto.randomUUID(),
        callerNumber: safeNumber,
        callerName: safeName,
        timestamp: new Date(),
        duration: 0,
        direction: 'inbound' as const,
        status: 'answered' as const,
      };

      useAppStore.getState().addCallRecord(record);

      addDiagnosticLog({
        level: 'info',
        category: 'SIP',
        message: `INVITE received from ${safeNumber} (${safeName})`,
        details: `Source: SIP Backend Network Engine`,
      });

      // Show the toast!
      if (window.callerflash?.toast?.show) {
        window.callerflash.toast.show({
          id: record.id,
          callerNumber: record.callerNumber,
          callerName: record.callerName,
          timestamp: record.timestamp.toISOString(),
          config: {
            duration: toastConfig.duration,
            backgroundColor: toastConfig.backgroundColor,
            accentColor: toastConfig.accentColor,
            textColor: toastConfig.textColor,
            borderRadius: toastConfig.borderRadius,
            opacity: toastConfig.opacity,
            fontFamily: toastConfig.fontFamily,
            fontSize: toastConfig.fontSize,
            autoCopyToClipboard: toastConfig.autoCopyToClipboard,
            showCallerName: toastConfig.showCallerName,
            showTimestamp: toastConfig.showTimestamp,
            maxWidth: toastConfig.maxWidth,
          },
        });
      }
      
      // Native notification fallback
      if (window.callerflash?.notify?.show) {
        window.callerflash.notify.show({ title: 'Incoming Call', body: `${safeNumber}${safeName ? ` - ${safeName}` : ''}`, urgency: 'critical', timeoutType: 'never' });
      }
    });
  }, [addDiagnosticLog]);

  // Push the current SIP status to main so the tray tooltip + "SIP: …"
  // menu item stay current. Cheap — just a string IPC send.
  useEffect(() => {
    if (!window.callerflash?.tray?.setSipStatus) return;
    const label = sipConnected
      ? sipRegistered ? 'Registered' : 'Connecting'
      : 'Offline';
    window.callerflash.tray.setSipStatus(label);
  }, [sipConnected, sipRegistered]);

  return (
    <div className="h-screen w-screen flex flex-col bg-win-bg overflow-hidden min-w-[360px]">
      {isMinimized ? (
        <MinimizedShell />
      ) : (
        <>
          <TitleBar compact={titleCompact} />
          <div className="flex flex-1 overflow-hidden min-h-0">
            <Sidebar collapsed={sidebarCollapsed} />
            <MainContent />
          </div>
        </>
      )}
      <ToastContainer />
    </div>
  );
}
