import { useState } from 'react';
import { Power, AppWindow, Minimize2, ClipboardCopy } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';

export function Preferences() {
  const { appPreferences, setAppPreferences, addDiagnosticLog } = useAppStore();
  const [showHint, setShowHint] = useState(false);

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-win-text">Preferences</h2>
          <p className="text-xs text-win-text-secondary mt-1">
            App-level settings — startup, background mode, system tray
          </p>
        </div>
      </div>

      <div className="bg-win-surface rounded-xl border border-win-border p-4">
        <h3 className="text-sm font-semibold text-win-text mb-3 flex items-center gap-2">
          <Power className="w-4 h-4 text-win-accent" />
          Startup &amp; Background
          <button
            type="button"
            aria-label="What is this?"
            onClick={() => setShowHint((v) => !v)}
            onMouseEnter={() => setShowHint(true)}
            onMouseLeave={() => setShowHint(false)}
            className="ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full border border-win-border/60 text-win-text-tertiary hover:text-win-text-secondary hover:border-win-border text-[10px] font-bold leading-none"
          >
            i
          </button>
        </h3>

        {showHint && (
          <div className="mb-3 px-3 py-2 rounded-lg bg-win-card border border-win-border/50 text-xs text-win-text-secondary leading-relaxed">
            CallerFlash registers with your SIP provider in the background
            and pops a toast on every incoming call — even when the window
            is hidden to the tray. These toggles control how the app
            starts when you log in to Windows.
          </div>
        )}

        <div className="space-y-2">
          <ToggleRow
            icon={<AppWindow className="w-4 h-4" />}
            label="Start with Windows"
            description="Launch automatically when you sign in."
            value={appPreferences.startWithWindows}
            onToggle={() => {
              const next = !appPreferences.startWithWindows;
              setAppPreferences({ startWithWindows: next });
              // Tell the main process to register/unregister the login item.
              if (window.callerflash?.app?.setStartWithWindows) {
                window.callerflash.app.setStartWithWindows(next);
              }
              addDiagnosticLog({
                level: 'info',
                category: 'SYSTEM',
                message: next ? 'Start with Windows enabled' : 'Start with Windows disabled',
              });
            }}
          />
          <ToggleRow
            icon={<Minimize2 className="w-4 h-4" />}
            label="Start minimized to tray"
            description="On launch, hide the window — only the tray icon is visible."
            value={appPreferences.startMinimized}
            onToggle={() => {
              const next = !appPreferences.startMinimized;
              setAppPreferences({ startMinimized: next });
              // Tell the main process so login-item args stay in sync.
              if (window.callerflash?.app?.setStartMinimized) {
                window.callerflash.app.setStartMinimized(next);
              }
              addDiagnosticLog({
                level: 'info',
                category: 'SYSTEM',
                message: next
                  ? 'Start minimized to tray enabled for next launch'
                  : 'Start minimized to tray disabled',
              });
            }}
          />
        </div>
      </div>

      <div className="bg-win-surface rounded-xl border border-win-border p-4">
        <h3 className="text-sm font-semibold text-win-text mb-3 flex items-center gap-2">
          <ClipboardCopy className="w-4 h-4 text-win-accent" />
          Notifications
        </h3>
        <div className="space-y-2">
          <ToggleRow
            icon={<ClipboardCopy className="w-4 h-4" />}
            label="Caller ID to clipboard"
            description="Automatically copy the caller's phone number when a call comes in."
            value={useAppStore.getState().toastConfig.autoCopyToClipboard}
            onToggle={() => {
              const store = useAppStore.getState();
              const next = !store.toastConfig.autoCopyToClipboard;
              store.setToastConfig({ autoCopyToClipboard: next });
              store.addDiagnosticLog({
                level: 'info',
                category: 'SYSTEM',
                message: next ? 'Auto-copy caller ID enabled' : 'Auto-copy caller ID disabled',
              });
            }}
          />
        </div>
      </div>
    </div>
  );
}

function ToggleRow({
  icon,
  label,
  description,
  value,
  onToggle,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  value: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center justify-between rounded-lg border border-win-border/50 bg-win-card p-2.5 text-left transition-colors hover:border-win-border hover:bg-win-surface-hover"
    >
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-win-accent flex-shrink-0">{icon}</span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-win-text">{label}</p>
          <p className="text-xs text-win-text-tertiary">{description}</p>
        </div>
      </div>
      <div className={`relative h-[20px] w-9 rounded-full transition-colors flex-shrink-0 ml-3 ${value ? 'bg-win-accent' : 'bg-win-border'}`}>
        <div className={`absolute top-[2px] h-4 w-4 rounded-full bg-white shadow transition-transform ${value ? 'translate-x-[19px]' : 'translate-x-[2px]'}`} />
      </div>
    </button>
  );
}
