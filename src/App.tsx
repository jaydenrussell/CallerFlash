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
import { Minus, Square, X } from 'lucide-react';
import { formatVersion } from './utils/formatVersion';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

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
    // Titlebar is the window drag region (`data-tauri-drag-region`).
    // Buttons are outside the drag region and stay clickable.
    <div
      className="h-9 bg-win-card border-b border-win-border flex items-center justify-between select-none flex-shrink-0"
      onMouseDown={(e) => {
        // Only start drag when clicking on non-interactive titlebar area (not on buttons)
        var t = e.target;
        while (t && t !== e.currentTarget) {
          if ((t as HTMLElement).tagName === 'BUTTON') return;
          t = (t as HTMLElement).parentElement;
        }
        getCurrentWebviewWindow().startDragging().catch(function () {});
      }}
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
            title={`Update ${formatVersion(updateInfo.latestVersion)} available — click to open`}
          >
            <div className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            <span className="text-[10px] font-semibold text-amber-400">Update</span>
          </button>
        )}
      </div>
      <div className="flex h-full flex-shrink-0">
        <button
          onClick={hideToTray}
          className="px-3 sm:px-4 h-full hover:bg-win-surface-hover transition-colors flex items-center"
          title="Minimize to tray"
        >
          <Minus className="w-3.5 h-3.5 text-win-text-secondary" />
        </button>
        <button
          onClick={() => window.callerflash?.window?.maximize?.()}
          className="px-3 sm:px-4 h-full hover:bg-win-surface-hover transition-colors flex items-center"
          title="Maximize / Restore"
        >
          <Square className="w-3 h-3 text-win-text-secondary" />
        </button>
        <button
          onClick={hideToTray}
          className="px-3 sm:px-4 h-full hover:bg-red-600 transition-colors flex items-center group"
          title="Hide to system tray"
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
    <div className="flex-1 p-4 sm:p-6 min-w-0 overflow-hidden">
      <div className="h-full overflow-y-auto overflow-x-hidden">
        {content[activeTab]}
      </div>
    </div>
  );
}



export default function App() {
  const { setIsMinimized, addDiagnosticLog, appPreferences, sipConnected, sipRegistered, setActiveTab, sipConfig } = useAppStore();
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

  // Load persisted diagnostics from disk (survives app restarts)
  useEffect(() => {
    if (typeof window !== 'undefined' && window.callerflash?.diagnostics) {
      window.callerflash.diagnostics.load().then((entries) => {
        if (entries && entries.length > 0) {
          useAppStore.getState().loadPersistedDiagnostics(entries);
        }
      }).catch(() => {});
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

  // Subscribe to tray → renderer events for isMinimized state sync.
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

      // Show notification based on user's style preference
      console.log('[App] SIP invite handler, toastConfig.style:', toastConfig.style, 'toast.show:', typeof window.callerflash?.toast?.show);
      if (toastConfig.style === 'custom' && window.callerflash?.toast?.show) {
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
            soundEnabled: toastConfig.soundEnabled,
            soundName: toastConfig.soundName,
          },
        });
      } else if (toastConfig.style === 'native' && window.callerflash?.notify?.show) {
        window.callerflash.notify.show({ title: 'Incoming Call', body: `${safeNumber}${safeName ? ` - ${safeName}` : ''}`, urgency: 'critical', timeoutType: 'never', soundEnabled: toastConfig.soundEnabled });
      }
    });
  }, [addDiagnosticLog]);

  // Listen for toast diagnostic events from main process and log them.
  useEffect(() => {
    if (!window.callerflash?.onToastDiagnostic) return;
    return window.callerflash.onToastDiagnostic((data: { level: string; message: string; details?: string }) => {
      addDiagnosticLog({
        level: data.level as any,
        category: 'TOAST',
        message: data.message,
        details: data.details,
      });
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
      <TitleBar compact={titleCompact} />
      <div className="flex flex-1 overflow-hidden min-h-0">
        <Sidebar collapsed={sidebarCollapsed} />
        <MainContent />
      </div>
      <ToastContainer />
    </div>
  );
}
