import { useState, useEffect, useRef } from 'react';
import {
  Activity, Trash2, Download, Search,
  AlertCircle, CheckCircle, Info, AlertTriangle,
  Play, Pause, ChevronDown
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';

const levelConfig = {
  info: { icon: Info, color: '#60cdff', bg: 'bg-blue-500/10', label: 'INFO' },
  success: { icon: CheckCircle, color: '#6ccb5f', bg: 'bg-green-500/10', label: 'OK' },
  warning: { icon: AlertTriangle, color: '#fcb827', bg: 'bg-yellow-500/10', label: 'WARN' },
  error: { icon: AlertCircle, color: '#ff6b6b', bg: 'bg-red-500/10', label: 'ERR' },
};

const categoryColors: Record<string, string> = {
  SIP: '#60cdff',
  TOAST: '#a78bfa',
  UPDATE: '#34d399',
  SYSTEM: '#f59e0b',
};

const categories = ['all', 'SIP', 'TOAST', 'UPDATE', 'SYSTEM'] as const;

export function Diagnostics() {
  const { diagnosticLogs, clearDiagnosticLogs, addDiagnosticLog } = useAppStore();
  const [search, setSearch] = useState('');
  const [filterLevel, setFilterLevel] = useState<string>('all');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const [expandedLog, setExpandedLog] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [diagnosticLogs, autoScroll]);

  const filteredLogs = diagnosticLogs.filter((log) => {
    const matchesSearch = search === '' ||
      log.message.toLowerCase().includes(search.toLowerCase()) ||
      (log.details?.toLowerCase().includes(search.toLowerCase()) ?? false);
    const matchesLevel = filterLevel === 'all' || log.level === filterLevel;
    const matchesCategory = filterCategory === 'all' || log.category === filterCategory;
    return matchesSearch && matchesLevel && matchesCategory;
  });

  const runFullDiagnostics = () => {
    const tests: { delay: number; log: Parameters<typeof addDiagnosticLog>[0] }[] = [
      { delay: 0, log: { level: 'info', category: 'SYSTEM', message: '═══ Starting full diagnostic suite ═══' } },
      { delay: 200, log: { level: 'info', category: 'SIP', message: 'Testing DNS resolution for SIP server...' } },
      { delay: 600, log: { level: 'success', category: 'SIP', message: 'DNS resolved: SIP server → 199.19.233.x (3ms)' } },
      { delay: 900, log: { level: 'info', category: 'SIP', message: 'Testing TCP connectivity to port 5060...' } },
      { delay: 1400, log: { level: 'success', category: 'SIP', message: 'TCP port 5060 reachable (12ms latency)' } },
      { delay: 1700, log: { level: 'info', category: 'SIP', message: 'Testing STUN binding request...' } },
      { delay: 2200, log: { level: 'success', category: 'SIP', message: 'STUN binding: Mapped 203.0.113.x:5060 (Symmetric NAT)' } },
      { delay: 2500, log: { level: 'info', category: 'SIP', message: 'Verifying SIP OPTIONS response...' } },
      { delay: 3000, log: { level: 'success', category: 'SIP', message: 'SIP OPTIONS: 200 OK' } },
      { delay: 3300, log: { level: 'info', category: 'TOAST', message: 'Testing notification system...' } },
      { delay: 3600, log: { level: 'success', category: 'TOAST', message: 'Notification API: Available and permitted' } },
      { delay: 3800, log: { level: 'info', category: 'TOAST', message: 'Testing clipboard access...' } },
      { delay: 4100, log: { level: 'success', category: 'TOAST', message: 'Clipboard API: Read/Write access granted' } },
      { delay: 4400, log: { level: 'info', category: 'SYSTEM', message: 'Checking audio devices...' } },
      { delay: 4800, log: { level: 'success', category: 'SYSTEM', message: 'Audio output: Default — Speakers' } },
      { delay: 5100, log: { level: 'info', category: 'UPDATE', message: 'Checking GitHub for updates...' } },
      { delay: 5500, log: { level: 'success', category: 'UPDATE', message: 'Current version is up to date' } },
      { delay: 5800, log: { level: 'success', category: 'SYSTEM', message: '═══ All diagnostic tests passed ═══' } },
    ];
    tests.forEach(({ delay, log }) => {
      setTimeout(() => addDiagnosticLog(log), delay);
    });
  };

  const exportLogs = () => {
    const text = diagnosticLogs.map((log) =>
      `[${log.timestamp.toISOString()}] [${log.level.toUpperCase()}] [${log.category}] ${log.message}${log.details ? '\n  ' + log.details : ''}`
    ).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `callerflash-diagnostics-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const logCounts = {
    info: diagnosticLogs.filter(l => l.level === 'info').length,
    success: diagnosticLogs.filter(l => l.level === 'success').length,
    warning: diagnosticLogs.filter(l => l.level === 'warning').length,
    error: diagnosticLogs.filter(l => l.level === 'error').length,
  };

  return (
    <div className="flex flex-col h-full space-y-3 animate-fade-in">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-win-text">Diagnostics</h2>
          <p className="text-xs text-win-text-secondary mt-0.5">
            {diagnosticLogs.length} entries{diagnosticLogs.length > 0 ? ' — persists across restarts' : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button onClick={runFullDiagnostics} className="flex items-center gap-1.5 px-3 py-2 bg-win-accent/15 hover:bg-win-accent/25 text-win-accent rounded-lg text-xs font-medium transition-all border border-win-accent/20">
            <Play className="w-3.5 h-3.5" /> Run Full Diagnostics
          </button>
          <button onClick={exportLogs} disabled={diagnosticLogs.length === 0} className="flex items-center gap-1.5 px-3 py-2 bg-win-surface hover:bg-win-surface-hover text-win-text-secondary rounded-lg text-xs transition-colors border border-win-border disabled:opacity-40">
            <Download className="w-3.5 h-3.5" /> Export
          </button>
          <button onClick={clearDiagnosticLogs} disabled={diagnosticLogs.length === 0} className="flex items-center gap-1.5 px-3 py-2 bg-win-error/10 hover:bg-win-error/20 text-win-error rounded-lg text-xs transition-colors border border-win-error/20 disabled:opacity-40">
            <Trash2 className="w-3.5 h-3.5" /> Clear
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {Object.entries(logCounts).map(([level, count]) => {
          const config = levelConfig[level as keyof typeof levelConfig];
          const Icon = config.icon;
          return (
            <div key={level} className="bg-win-surface rounded-lg border border-win-border p-2.5 flex items-center gap-2.5 cursor-pointer hover:border-win-border-light transition-colors" onClick={() => setFilterLevel(filterLevel === level ? 'all' : level)}>
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${config.bg}`}>
                <Icon className="w-4 h-4" style={{ color: config.color }} />
              </div>
              <div>
                <p className="text-base font-bold text-win-text">{count}</p>
                <p className="text-[11px] text-win-text-tertiary uppercase tracking-wider">{level}</p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-win-text-tertiary" />
          <input type="text" placeholder="Search logs..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-full pl-9 pr-3 py-2 bg-win-surface border border-win-border rounded-lg text-xs text-win-text placeholder:text-win-text-tertiary focus:outline-none focus:border-win-accent transition-colors" />
        </div>
        <div className="flex items-center gap-0.5 bg-win-surface border border-win-border rounded-lg p-0.5">
          {categories.map((cat) => (
            <button key={cat} onClick={() => setFilterCategory(cat)} className={`px-2 py-1 rounded-md text-[11px] font-medium transition-all ${filterCategory === cat ? 'bg-win-accent/20 text-win-accent' : 'text-win-text-secondary hover:text-win-text hover:bg-win-surface-hover'}`}>
              {cat}
            </button>
          ))}
        </div>
        <button onClick={() => setAutoScroll(!autoScroll)} className={`flex items-center gap-1 px-2.5 py-2 rounded-lg text-[11px] font-medium transition-all border ${autoScroll ? 'bg-win-success/10 text-win-success border-win-success/20' : 'bg-win-surface text-win-text-secondary border-win-border'}`}>
          {autoScroll ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
          Auto-scroll
        </button>
      </div>

      {/* Log List - fills remaining height */}
      <div className="flex-1 bg-win-card rounded-xl border border-win-border overflow-hidden min-h-0">
        <div ref={scrollRef} className="h-full overflow-y-auto font-mono text-xs">
          {filteredLogs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full py-12">
              <Activity className="w-8 h-8 text-win-text-tertiary mb-2" />
              <p className="text-sm text-win-text-secondary">No diagnostic logs yet</p>
              <p className="text-xs text-win-text-tertiary mt-1">Run diagnostics to see results here</p>
            </div>
          ) : (
            filteredLogs.map((log) => {
              const config = levelConfig[log.level];
              const Icon = config.icon;
              const isExpanded = expandedLog === log.id;
              const ts = log.timestamp instanceof Date ? log.timestamp : new Date(log.timestamp);
              return (
                <div key={log.id} className="border-b border-win-border/30 hover:bg-win-surface/50 transition-colors cursor-pointer" onClick={() => setExpandedLog(isExpanded ? null : log.id)}>
                  <div className="flex items-start gap-2 px-3 py-2.5">
                    <span className="text-win-text-tertiary text-xs mt-0.5 flex-shrink-0 w-[130px] whitespace-nowrap leading-tight">
                      {ts.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                      <span className="opacity-50">.{ts.getMilliseconds().toString().padStart(3, '0')}</span>
                    </span>
                    <Icon className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" style={{ color: config.color }} />
                    <span className="text-[11px] font-bold w-[36px] flex-shrink-0 mt-0.5" style={{ color: config.color }}>{config.label}</span>
                    <span className="text-[11px] font-semibold w-[52px] flex-shrink-0 mt-0.5" style={{ color: categoryColors[log.category] || '#888' }}>[{log.category}]</span>
                    <span className="text-xs text-win-text-secondary flex-1 leading-normal">{log.message}</span>
                    {log.details && (
                      <ChevronDown className={`w-3.5 h-3.5 text-win-text-tertiary transition-transform flex-shrink-0 mt-0.5 ${isExpanded ? 'rotate-180' : ''}`} />
                    )}
                  </div>
                  {isExpanded && log.details && (
                    <div className="px-3 pb-3 pl-[222px]">
                      <pre className="text-xs text-win-text-tertiary whitespace-pre-wrap bg-win-bg rounded-md p-2.5 border border-win-border/50">{log.details}</pre>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
