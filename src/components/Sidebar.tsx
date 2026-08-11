import {
  LayoutDashboard, Phone, Settings, Sliders, Bell, Activity,
  RefreshCw, Info, Wifi, WifiOff
} from 'lucide-react';
import { useAppStore, type TabId } from '../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '../utils/cn';
import { formatVersion } from '../utils/formatVersion';
import logoUrl from '../assets/icon.png';

const navItems: { id: TabId; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'calls', label: 'Call History', icon: Phone },
  { id: 'settings', label: 'SIP Settings', icon: Settings },
  { id: 'preferences', label: 'Preferences', icon: Sliders },
  { id: 'toast', label: 'Notifications', icon: Bell },
  { id: 'diagnostics', label: 'Diagnostics', icon: Activity },
  { id: 'update', label: 'Updates', icon: RefreshCw },
  { id: 'about', label: 'About', icon: Info },
];

const openExternal = (url: string) => {
  if (window.callerflash?.shell?.openExternal) {
    window.callerflash.shell.openExternal(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
};

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
    </svg>
  );
}

interface SidebarProps {
  collapsed: boolean;
}

export function Sidebar({ collapsed }: SidebarProps) {
  const { activeTab, setActiveTab, sipConnected, sipRegistered, updateInfo } = useAppStore(
    useShallow((s) => ({
      activeTab: s.activeTab,
      setActiveTab: s.setActiveTab,
      sipConnected: s.sipConnected,
      sipRegistered: s.sipRegistered,
      updateInfo: s.updateInfo,
    })),
  );

  if (collapsed) {
    return (
      <div className="w-14 min-w-14 bg-win-card border-r border-win-border flex flex-col h-full">
        {/* Compact App Header */}
        <div className="px-3 py-4 border-b border-win-border flex justify-center">
          <div
            className="w-8 h-8 flex items-center justify-center flex-shrink-0 drop-shadow-md"
            title="CallerFlash"
          >
            <img src={logoUrl} alt="CallerFlash" className="w-full h-full object-contain" />
          </div>
        </div>

        {/* Compact Status */}
        <div className="px-3 py-3 border-b border-win-border flex justify-center">
          <div
            className={cn(
              'w-2.5 h-2.5 rounded-full',
              sipConnected && sipRegistered ? 'bg-win-success' :
                sipConnected ? 'bg-win-warning' : 'bg-win-error'
            )}
            title={sipConnected && sipRegistered ? 'Registered' : sipConnected ? 'Connecting' : 'Offline'}
          />
        </div>

        {/* Icon-only Nav */}
        <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            const showUpdateBadge = item.id === 'update' && updateInfo.updateAvailable;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                title={item.label}
                className={cn(
                  'w-full flex items-center justify-center px-2 py-2.5 rounded-lg transition-all duration-150 relative',
                  isActive
                    ? 'bg-win-accent/15 text-win-accent border border-win-accent/20'
                    : 'text-win-text-secondary hover:bg-win-surface-hover hover:text-win-text border border-transparent'
                )}
              >
                <Icon className="w-[18px] h-[18px]" />
                {showUpdateBadge && (
                  <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-amber-400" />
                )}
              </button>
            );
          })}
        </nav>

        {/* Single GitHub entry — collapsed mode */}
        <div className="p-2 border-t border-win-border">
          <button
            onClick={() => openExternal(`${updateInfo.githubRepo}`)}
            title="Open Source on GitHub"
            className="w-full flex items-center justify-center px-2 py-2 rounded-lg text-win-text-secondary hover:bg-win-surface-hover hover:text-win-text transition-colors border border-transparent"
          >
            <GithubIcon className="w-[18px] h-[18px]" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-44 min-w-44 bg-win-card border-r border-win-border flex flex-col h-full">
      {/* App Header */}
      <div className="px-3 py-3 border-b border-win-border">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 flex items-center justify-center flex-shrink-0 drop-shadow-md">
            <img src={logoUrl} alt="CallerFlash" className="w-full h-full object-contain" />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-bold text-win-text tracking-tight truncate">CallerFlash</h1>
            <p className="text-[11px] text-win-text-secondary truncate">SIP Client</p>
          </div>
        </div>
      </div>

      {/* Connection Status */}
      <div className="px-3 py-3 border-b border-win-border">
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-win-surface">
          {sipConnected ? (
            <Wifi className="w-4 h-4 text-win-success flex-shrink-0" />
          ) : (
            <WifiOff className="w-4 h-4 text-win-error flex-shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-win-text truncate">
              {sipRegistered ? 'Registered' : sipConnected ? 'Connected' : 'Disconnected'}
            </p>
            <p className="text-xs text-win-text-tertiary truncate">
              {sipRegistered ? 'Active Session' : sipConnected ? 'Registering...' : 'Offline'}
            </p>
          </div>
          <div className={cn(
            'w-2.5 h-2.5 rounded-full flex-shrink-0',
            sipConnected && sipRegistered ? 'bg-win-success' :
              sipConnected ? 'bg-win-warning' : 'bg-win-error'
          )} />
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            const showUpdateBadge = item.id === 'update' && updateInfo.updateAvailable;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={cn(
                  'w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 relative',
                  isActive
                    ? 'bg-win-accent/15 text-win-accent border border-win-accent/20'
                    : 'text-win-text-secondary hover:bg-win-surface-hover hover:text-win-text border border-transparent'
                )}
              >
                <Icon className="w-[18px] h-[18px] flex-shrink-0" />
                <span className="truncate">{item.label}</span>
                {showUpdateBadge && (
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" />
                )}
              </button>
            );
          })}
      </nav>

      {/* Version + single GitHub link (the only GitHub entry in the whole app) */}
      <div className="p-3 border-t border-win-border space-y-2">
        <div className="text-center">
          <p className="text-xs text-win-text-tertiary truncate">{formatVersion(updateInfo.currentVersion)} • MIT</p>
        </div>
        <button
          onClick={() => openExternal(`${updateInfo.githubRepo}`)}
          className="w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium text-win-text-secondary hover:bg-win-surface-hover hover:text-win-text transition-colors border border-win-border/50"
        >
          <GithubIcon className="w-3.5 h-3.5" />
          Open Source on GitHub
        </button>
      </div>
    </div>
  );
}
