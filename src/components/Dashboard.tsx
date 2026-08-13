import { useEffect, useState } from 'react';
import {
  Phone, PhoneIncoming, PhoneOff,
  Wifi, Clock, Shield, Info
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';

export function Dashboard() {
  const { sipConnected, sipRegistered, callHistory, appPreferences, isMinimized, sipConfig } = useAppStore(
    useShallow((s) => ({
      sipConnected: s.sipConnected,
      sipRegistered: s.sipRegistered,
      callHistory: s.callHistory,
      appPreferences: s.appPreferences,
      isMinimized: s.isMinimized,
      sipConfig: s.sipConfig,
    })),
  );

  const [uptime, setUptime] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      if (sipConnected) setUptime((u) => u + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [sipConnected]);

  const formatUptime = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };

  const todayCalls = callHistory.filter((c) => c.timestamp.getDate() === new Date().getDate()).length;

  return (
    <div className="flex flex-col h-full gap-3 animate-fade-in">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-win-text">Dashboard</h2>
          <p className="text-xs text-win-text-secondary mt-0.5">Monitor & control</p>
        </div>
      </div>

      {/* Compact status row */}
      <div className="grid grid-cols-2 gap-2">
        <StatusCard
          icon={<Wifi className="w-4 h-4" />}
          label="SIP"
          value={sipRegistered ? 'Registered' : sipConnected ? 'Connected' : 'Offline'}
          color={sipRegistered ? '#6ccb5f' : sipConnected ? '#fcb827' : '#ff6b6b'}
          tooltip={sipConnected ? `Uptime: ${formatUptime(uptime)}` : 'Not connected'}
        />
        <StatusCard
          icon={<Phone className="w-4 h-4" />}
          label="Calls today"
          value={todayCalls.toString()}
          color="#60cdff"
          tooltip={`${todayCalls} call${todayCalls === 1 ? '' : 's'} received today`}
        />
      </div>

      {/* Connection Details */}
      <div className="bg-win-surface rounded-xl border border-win-border p-3">
        <h3 className="text-sm font-semibold text-win-text mb-2 flex items-center gap-2">
          <Shield className="w-4 h-4 text-win-accent" />
          Connection
        </h3>
        <div className="grid grid-cols-2 gap-y-1.5 gap-x-4">
          <DetailRow label="SIP Server" value={sipConfig.server || '—'} />
          <DetailRow label="Protocol" value={`${sipConfig.protocol} : ${sipConfig.port}`} />
          <DetailRow label="Codec" value={sipConfig.codec} />
          <DetailRow label="Registration" value={sipRegistered ? `Active (${sipConfig.registerExpiry}s)` : 'Inactive'} />
          <DetailRow label="Encryption" value={sipConfig.protocol === 'TLS' ? 'TLS (encrypted)' : 'None'} />
        </div>
        <div className="mt-2 flex items-center gap-2">
          <InfoButton
            label="Background mode"
            value={isMinimized ? 'Hidden in tray' : 'Visible'}
            tooltip="Whether the main window is shown or hidden to the system tray. SIP registration + toasts keep running either way."
          />
          <InfoButton
            label="Startup"
            value={appPreferences.startWithWindows ? 'With Windows' : 'Manual'}
            tooltip="Whether CallerFlash registers itself to launch on Windows sign-in."
          />
        </div>
      </div>

      {/* Recent Calls */}
      <div className="bg-win-surface rounded-xl border border-win-border p-3 flex-1 min-h-0 flex flex-col">
      <h3 className="text-sm font-semibold text-win-text mb-2 flex items-center gap-2 flex-shrink-0">
        <Clock className="w-4 h-4 text-win-accent" />
        Recent calls
      </h3>
        {callHistory.length === 0 ? (
          <div className="text-center py-6 flex-1 flex flex-col items-center justify-center">
            <PhoneOff className="w-10 h-10 text-win-text-tertiary mx-auto mb-2" />
            <p className="text-xs text-win-text-secondary">No calls yet</p>
            <p className="text-[11px] text-win-text-tertiary mt-0.5">Connect to a provider and simulate a call.</p>
          </div>
        ) : (
          <div className="space-y-0.5 overflow-y-auto pr-1 flex-1 min-h-0">
            {callHistory.slice(0, 50).map((call) => (
              <div
                key={call.id}
                className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-win-surface-hover transition-colors"
              >
                <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 bg-win-accent/15">
                  <PhoneIncoming className="w-3.5 h-3.5 text-win-accent" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-win-text">{call.callerNumber}</p>
                  <p className="text-[11px] text-win-text-secondary">{call.callerName}</p>
                </div>
                <p className="text-[11px] text-win-text-tertiary">{call.timestamp.toLocaleTimeString()}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusCard({
  icon,
  label,
  value,
  color,
  valueSize = 'text-lg',
  tooltip,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: string;
  valueSize?: string;
  tooltip?: string;
}) {
  return (
    <div
      className="bg-win-surface rounded-xl border border-win-border p-2.5"
      title={tooltip}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <div
          className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: `${color}18`, color }}
        >
          {icon}
        </div>
        <span className="text-[11px] font-medium text-win-text-secondary">{label}</span>
      </div>
      <p className={`${valueSize} font-bold text-win-text truncate`} style={{ color }}>
        {value}
      </p>
    </div>
  );
}

function InfoButton({ label, value, tooltip }: { label: string; value: string; tooltip: string }) {
  return (
    <button
      type="button"
      title={tooltip}
      className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-win-card border border-win-border/50 text-[11px] hover:border-win-border transition-colors"
    >
      <Info className="w-3 h-3 text-win-text-tertiary" />
      <span className="text-win-text-tertiary">{label}:</span>
      <span className="text-win-text-secondary font-medium">{value}</span>
    </button>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-win-text-tertiary">{label}</span>
      <span className="text-[11px] font-medium text-win-text-secondary truncate ml-2">{value}</span>
    </div>
  );
}
