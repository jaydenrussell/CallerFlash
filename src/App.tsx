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
import { useAppStore, type DiagnosticLog } from './store/useAppStore';
import { sanitizeCallerNumberForClipboard, sanitizeCallerName } from './security/secretRedactor';

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

  useEffect(() => {
    if (appPreferences.startWithWindows) {
      addDiagnosticLog({ level: 'info', category: 'SYSTEM', message: 'Ensuring Start with Windows registry key…' });
      window.callerflash?.app?.setStartWithWindows(true);
    }
  }, []);

  // Suppress the default browser right-click menu everywhere except text inputs
  // and contenteditable elements — matches Windows 11 shell behavior.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable
      ) {
        return; // allow native context menu on text fields
      }
      e.preventDefault();
    };
    document.addEventListener('contextmenu', handler);
    return () => document.removeEventListener('contextmenu', handler);
  }, []);

  // Request native notification permission on first launch
  useEffect(() => {
    if (typeof window !== 'undefined' && window.callerflash?.notify) {
      const { requestPermission, isPermissionGranted } = window.callerflash.notify;
      if (typeof isPermissionGranted === 'function') {
        isPermissionGranted().then((granted) => {
          if (!granted && typeof requestPermission === 'function') {
            requestPermission().catch(() => {
              // User denied — notifications won't work, the SIP toast window still shows calls
            });
          }
        }).catch(() => {
          // API not available, ignore
        });
      }
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
      } catch (e) {
        addDiagnosticLog({ level: 'error', category: 'SYSTEM', message: `Failed to read UI settings: ${e}` });
      }
    }
  }, []);

  // Load persisted diagnostics from disk (survives app restarts)
  useEffect(() => {
    if (typeof window !== 'undefined' && window.callerflash?.diagnostics) {
      window.callerflash.diagnostics.load().then((entries) => {
        if (entries && entries.length > 0) {
          useAppStore.getState().loadPersistedDiagnostics(
            entries.map((e) => ({
              ...e,
              level: e.level as DiagnosticLog['level'],
              category: e.category as DiagnosticLog['category'],
              details: e.details ?? undefined,
            })),
          );
        }
      }).catch((e) => addDiagnosticLog({ level: 'error', category: 'SYSTEM', message: `Failed to load diagnostics: ${e}` }));
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
        useAppStore.setState({ sipConnected: false, sipRegistered: false, isConnecting: false });
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
      const safeNumber = sanitizeCallerNumberForClipboard(callerData.callerNumber || '');
      const safeName = sanitizeCallerName(callerData.callerName || '');

      const record = {
        id: crypto.randomUUID(),
        callerNumber: safeNumber,
        callerName: safeName,
        timestamp: new Date(),
        duration: 0,
        direction: 'inbound' as const,
        status: 'missed' as const,
      };

      useAppStore.getState().addCallRecord(record);

      addDiagnosticLog({
        level: 'info',
        category: 'SIP',
        message: `INVITE received from ${safeNumber} (${safeName})`,
        details: `No response sent — CallerFlash does not answer calls`,
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

  // Finalize inbound call: voip.ms cancelled our branch (answered elsewhere / caller hung up)
  useEffect(() => {
    if (!window.callerflash?.sip?.onInviteEnded) return;
    return window.callerflash.sip.onInviteEnded((data: { reason: string }) => {
      addDiagnosticLog({
        level: data.reason === 'timeout' ? 'warning' : 'info',
        category: 'SIP',
        message: 'Inbound call ended',
        details:
          data.reason === 'cancel'
            ? 'voip.ms cancelled this device — call may have been answered by another sub-account, or the caller hung up'
            : `No response sent; branch ended (${data.reason})`,
      });
    });
  }, [addDiagnosticLog]);

  // Listen for toast diagnostic events from main process and log them.
  useEffect(() => {
    if (!window.callerflash?.onToastDiagnostic) return;
    return window.callerflash.onToastDiagnostic((data: { level: string; message: string; details?: string }) => {
      addDiagnosticLog({
        level: data.level as 'info' | 'success' | 'warning' | 'error',
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

  // Background update check on app startup (Tauri only).
  useEffect(() => {
    if (!window.callerflash?.updater?.check) return;
    addDiagnosticLog({ level: 'info', category: 'UPDATE', message: 'Checking for updates on startup…' });
    window.callerflash.updater.check('stable').then((result) => {
      if (result?.version) {
        useAppStore.getState().setUpdateInfo({
          latestVersion: result.version,
          updateAvailable: true,
          lastChecked: new Date(),
        });
        addDiagnosticLog({ level: 'info', category: 'UPDATE', message: `Update available: ${result.version}` });
      } else if (result?.upToDate) {
        addDiagnosticLog({ level: 'info', category: 'UPDATE', message: 'App is up to date.' });
      }
    }).catch((e) => addDiagnosticLog({ level: 'error', category: 'UPDATE', message: `Update check failed: ${e}` }));
  }, [addDiagnosticLog]);

  return (
    <div className="h-screen w-screen flex flex-col bg-win-bg overflow-hidden min-w-[360px]">
      <div className="flex flex-1 overflow-hidden min-h-0">
        <Sidebar collapsed={sidebarCollapsed} />
        <MainContent />
      </div>
      <ToastContainer />
    </div>
  );
}
