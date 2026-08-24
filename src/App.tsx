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
import { ErrorBoundary } from './components/ErrorBoundary';
import { StartupBanner } from './components/StartupBanner';
import { useAppStore, runStorageMigration, persistLastRunVersion, type DiagnosticLog } from './store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { sanitizeCallerNumberForClipboard, sanitizeCallerName } from './security/secretRedactor';
import { UPDATE_SCHEDULER_TICK_MS } from './utils/updateSchedule';
import { backgroundUpdateCheck } from './utils/backgroundUpdateCheck';

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
  const activeTab = useAppStore((s) => s.activeTab);

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
        <ErrorBoundary key={activeTab}>
          {content[activeTab]}
        </ErrorBoundary>
      </div>
    </div>
  );
}



export default function App() {
  const { setIsMinimized, addDiagnosticLog, appPreferences, sipConnected, sipRegistered, setActiveTab, sipConfig } =
    useAppStore(
      useShallow((s) => ({
        setIsMinimized: s.setIsMinimized,
        addDiagnosticLog: s.addDiagnosticLog,
        appPreferences: s.appPreferences,
        sipConnected: s.sipConnected,
        sipRegistered: s.sipRegistered,
        setActiveTab: s.setActiveTab,
        sipConfig: s.sipConfig,
      })),
    );
  const width = useWindowWidth();
  const sidebarCollapsed = width < SIDEBAR_COLLAPSE_BREAKPOINT;

  useEffect(() => {
    if (appPreferences.startWithWindows) {
      addDiagnosticLog({ level: 'info', category: 'SYSTEM', message: 'Ensuring Start with Windows registry key…' });
      window.callerflash?.app?.setStartWithWindows(true);
    }
  }, []);

  // Reconcile the start-with-Windows toggle with actual Windows state (Run key
  // + StartupApproved, which the user can flip in Task Manager). This must run
  // post-mount: window.callerflash installs on DOMContentLoaded, so any
  // module-scope check would silently miss the bridge.
  useEffect(() => {
    let cancelled = false;
    window.callerflash?.app?.getStartWithWindows?.().then((enabled) => {
      if (cancelled || enabled === null || enabled === undefined) return;
      const current = useAppStore.getState().appPreferences.startWithWindows;
      if (current !== enabled) {
        // Persist the corrected value so the reconciled state survives restart.
        useAppStore.getState().setAppPreferences({ startWithWindows: enabled });
        addDiagnosticLog({
          level: 'info',
          category: 'SYSTEM',
          message: `Start with Windows reconciled to actual system state: ${enabled ? 'enabled' : 'disabled'}`,
        });
      }
    }).catch(() => {
      // Bridge or registry unavailable — leave the stored value as-is.
    });
    return () => { cancelled = true; };
  }, [addDiagnosticLog]);

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
  const [isFirstRunAfterUpdate] = useState(() => {
    // Only access localStorage on client side
    if (typeof window === 'undefined') return false;
    try {
      const raw = window.localStorage.getItem('callerflash-ui-settings');
      if (!raw) return true; // Brand new install
      const settings = JSON.parse(raw);
      return settings.lastRunVersion !== __APP_VERSION__;
    } catch (e) {
      addDiagnosticLog({ level: 'error', category: 'SYSTEM', message: `Failed to read UI settings: ${e}` });
      return false;
    }
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !isFirstRunAfterUpdate) return;
    try {
      const raw = window.localStorage.getItem('callerflash-ui-settings');
      const settings = raw ? JSON.parse(raw) : {};
      settings.lastRunVersion = __APP_VERSION__;
      window.localStorage.setItem('callerflash-ui-settings', JSON.stringify(settings));
    } catch (e) {
      addDiagnosticLog({ level: 'error', category: 'SYSTEM', message: `Failed to write UI settings: ${e}` });
    }
    // Also record it in native storage so the Rust side can decide whether
    // this launch is a new version (it shows the window once in that case).
    persistLastRunVersion(__APP_VERSION__);
  }, [isFirstRunAfterUpdate]);

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
    // Hydrate from native (DPAPI) storage once the bridge is installed.
    // Auto-connect (below) waits for sipConfig.password, so this must run
    // before the auto-connect effect fires.
    runStorageMigration();
  }, []);

  // Window visibility at launch is decided by the Rust side BEFORE the
  // webview loads (main window is created hidden in tauri.conf.json), so
  // "start minimized" never flashes the window. Here we only keep isMinimized
  // in sync and re-show when the first-run-after-update override applies.
  useEffect(() => {
    if (appPreferences.startMinimized && !isFirstRunAfterUpdate) {
      setIsMinimized(true);
      // Belt and braces: the window should already be hidden; make sure it is.
      const t = setTimeout(() => {
        if (!window.callerflash?.window?.hideToTray) return;
        window.callerflash.window.hideToTray();
        addDiagnosticLog({
          level: 'info',
          category: 'SYSTEM',
          message: 'Application launched in background mode (hidden to system tray)',
        });
      }, 50);
      return () => clearTimeout(t);
    }

    setIsMinimized(false);
    if (isFirstRunAfterUpdate && window.callerflash?.window?.show) {
      window.callerflash.window.show();
    }
  }, [appPreferences.startMinimized, isFirstRunAfterUpdate, setIsMinimized, addDiagnosticLog]);

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
      };

      useAppStore.getState().addCallRecord(record);

      addDiagnosticLog({
        level: 'info',
        category: 'SIP',
        message: `INVITE received from ${safeNumber} (${safeName})`,
        details: `No response sent — CallerFlash does not answer calls`,
      });

      // Copy the caller number to the clipboard so a paste finds the caller.
      // Done via the Rust command (not navigator.clipboard) because it must
      // work even when the main window is minimized/hidden in the tray.
      if (toastConfig.autoCopyToClipboard && window.callerflash?.clipboard?.copy) {
        if (safeNumber) {
          window.callerflash.clipboard.copy(safeNumber);
          addDiagnosticLog({
            level: 'info',
            category: 'TOAST',
            message: `Auto-copied caller number to clipboard`,
            details: `${safeNumber}`,
          });
        }
      }

      // Show notification based on user's style preference
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

  // Background update check on app startup (Tauri only). Due-ness policy
  // (frequency + lastChecked) lives inside backgroundUpdateCheck itself.
  useEffect(() => {
    void backgroundUpdateCheck('startup');
  }, []);

  // Periodic update checks. The interval re-evaluates from the store on
  // every tick via backgroundUpdateCheck, so changing the frequency takes
  // effect without remounting.
  useEffect(() => {
    if (!window.callerflash?.updater?.check) return;
    const id = setInterval(() => {
      void backgroundUpdateCheck('scheduled');
    }, UPDATE_SCHEDULER_TICK_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col bg-win-bg overflow-hidden min-w-[360px]">
      <StartupBanner />
      <div className="flex flex-1 overflow-hidden min-h-0">
        <Sidebar collapsed={sidebarCollapsed} />
        <MainContent />
      </div>
      <ToastContainer />
    </div>
  );
}
