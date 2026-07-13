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

  const runFullDiagnostics = async () => {
    const addLog = addDiagnosticLog;

    addLog({ level: 'info', category: 'SYSTEM', message: '══════ Starting full diagnostic suite ══════' });

    const savedConfig = useAppStore.getState().sipConfig;
    const hasSipConfig = savedConfig.server && savedConfig.server.trim().length > 0;

    // ── Phase 1: SIP Protocol Connectivity ────────────────────────────
    if (!hasSipConfig) {
      addLog({ level: 'warning', category: 'SIP', message: 'SIP server not configured — skipping protocol tests' });
      addLog({ level: 'info', category: 'SIP', message: 'Configure SIP settings first, then re-run diagnostics' });
    } else {
      const protocols = ['UDP', 'TCP', 'TLS'] as const;
      for (const protocol of protocols) {
        addLog({ level: 'info', category: 'SIP', message: `Testing ${protocol} connectivity to ${savedConfig.server}...` });
        try {
          const config: Record<string, unknown> = {
            server: savedConfig.server,
            username: savedConfig.username,
            password: savedConfig.password,
            authUsername: savedConfig.authUsername,
            registerExpiry: savedConfig.registerExpiry,
            protocol,
            port: protocol === 'TLS' ? 5061 : savedConfig.port,
          };
          const result = await window.callerflash!.sip.testConnection(config) as Record<string, unknown>;
          const success = result.success as boolean;
          if (success) {
            const dns = result.dns as Record<string, unknown> | undefined;
            if (dns) {
              addLog({
                level: 'success', category: 'SIP',
                message: `${protocol} DNS: ${dns.ip as string} (${dns.family as string}, ${dns.timeMs as number}ms)`,
              });
            }
            const portCheck = result.portCheck as Record<string, unknown> | undefined;
            if (portCheck) {
              if (portCheck.reachable === true || portCheck.reachable === 'local-ok') {
                const latency = portCheck.latencyMs as number | undefined;
                const suffix = latency != null ? ` (${latency}ms)` : '';
                addLog({ level: 'success', category: 'SIP', message: `${protocol} port ${result.port as number}: reachable${suffix}` });
              } else if (portCheck.reachable === false) {
                addLog({ level: 'warning', category: 'SIP', message: `${protocol} port ${result.port as number}: unreachable — ${(portCheck.detail as string) || 'no detail'}` });
              }
            }
          } else {
            addLog({ level: 'error', category: 'SIP', message: `${protocol} test failed: ${(result.error as string) || 'Unknown'}` });
          }
        } catch (e) {
          addLog({ level: 'error', category: 'SIP', message: `${protocol} exception: ${String(e)}` });
        }
        // Rate limit: SIP_RATE_LIMITER = 2 calls/sec, so wait 600ms between tests
        if (protocol !== 'TLS') {
          await new Promise((r) => setTimeout(r, 600));
        }
      }
    }

    // ── Phase 2: Notifications ────────────────────────────────────────
    addLog({ level: 'info', category: 'TOAST', message: 'Testing native OS notification...' });
    try {
      if (window.callerflash?.notify?.show) {
        window.callerflash.notify.show({
          title: 'CallerFlash Diagnostics',
          body: 'Native notification system is working correctly.',
        });
        addLog({ level: 'success', category: 'TOAST', message: 'Native notification sent — check your notification centre' });
      } else {
        addLog({ level: 'warning', category: 'TOAST', message: 'Native notification API not available' });
      }
    } catch (e) {
      addLog({ level: 'error', category: 'TOAST', message: `Native notification failed: ${String(e)}` });
    }

    addLog({ level: 'info', category: 'TOAST', message: 'Testing toast window...' });
    try {
      const toastCfg = useAppStore.getState().toastConfig;
      if (window.callerflash?.toast?.show) {
        window.callerflash.toast.show({
          id: crypto.randomUUID(),
          callerNumber: '+15551234567',
          callerName: 'Diagnostics Test Call',
          timestamp: new Date().toISOString(),
          config: toastCfg,
        } as unknown as Parameters<typeof window.callerflash.toast.show>[0]);
        addLog({ level: 'success', category: 'TOAST', message: `Toast window shown — style: ${toastCfg.style}, ${toastCfg.duration}s, ${toastCfg.position}` });
        addLog({ level: 'info', category: 'TOAST', message: `  Sound: ${toastCfg.soundName} | Auto-copy: ${toastCfg.autoCopyToClipboard} | Show name: ${toastCfg.showCallerName} | Show time: ${toastCfg.showTimestamp}` });
        addLog({ level: 'info', category: 'TOAST', message: `  Font: ${toastCfg.fontFamily} ${toastCfg.fontSize}px | Opacity: ${toastCfg.opacity}% | Radius: ${toastCfg.borderRadius}px` });
      } else {
        addLog({ level: 'warning', category: 'TOAST', message: 'Toast API not available' });
      }
    } catch (e) {
      addLog({ level: 'error', category: 'TOAST', message: `Toast test failed: ${String(e)}` });
    }

    // ── Phase 3: Clipboard + Audio ────────────────────────────────────
    addLog({ level: 'info', category: 'TOAST', message: 'Testing clipboard API...' });
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText('callerflash-diag-ok');
        const read = await navigator.clipboard.readText();
        if (read === 'callerflash-diag-ok') {
          addLog({ level: 'success', category: 'TOAST', message: 'Clipboard read/write: OK' });
        } else {
          addLog({ level: 'warning', category: 'TOAST', message: 'Clipboard: write OK but read mismatch' });
        }
      } else {
        addLog({ level: 'warning', category: 'TOAST', message: 'Clipboard API unavailable (HTTPS or Tauri required)' });
      }
    } catch (e) {
      addLog({ level: 'warning', category: 'TOAST', message: `Clipboard API: ${String(e)}` });
    }

    addLog({ level: 'info', category: 'SYSTEM', message: 'Testing audio playback...' });
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AC) {
        const ctx = new AC();
        if (ctx.state === 'suspended') await ctx.resume();
        ctx.close();
        addLog({ level: 'success', category: 'SYSTEM', message: 'AudioContext: available and operational' });
      } else {
        addLog({ level: 'warning', category: 'SYSTEM', message: 'AudioContext API not available' });
      }
    } catch (e) {
      addLog({ level: 'warning', category: 'SYSTEM', message: `Audio API: ${String(e)}` });
    }

    // ── Phase 4: Startup System Checks ────────────────────────────────
    addLog({ level: 'info', category: 'SYSTEM', message: 'Running startup system checks...' });
    try {
      if (window.callerflash?.startup?.runChecks) {
        const report = await window.callerflash.startup.runChecks();
        addLog({ level: 'info', category: 'SYSTEM', message: `OS: ${report.os_name} ${report.os_version} (${report.edition})` });
        if (report.is_windows_11) {
          addLog({ level: 'info', category: 'SYSTEM', message: 'Windows 11 detected' });
        }
        for (const check of report.checks) {
          addLog({
            level: check.ok ? 'success' : 'error',
            category: 'SYSTEM',
            message: `${check.ok ? '✓' : '✗'} ${check.name}${check.message ? ': ' + check.message : ''}`,
          });
        }
        addLog({ level: report.all_ok ? 'success' : 'warning', category: 'SYSTEM', message: report.all_ok ? 'All startup checks passed' : 'Some startup checks had issues (non-fatal)' });
      } else {
        addLog({ level: 'warning', category: 'SYSTEM', message: 'Startup checks API not available' });
      }
    } catch (e) {
      addLog({ level: 'error', category: 'SYSTEM', message: `Startup checks failed: ${String(e)}` });
    }

    // ── Phase 5: Update Check ─────────────────────────────────────────
    addLog({ level: 'info', category: 'UPDATE', message: 'Checking for updates...' });
    try {
      const channel = useAppStore.getState().updateInfo.updateChannel;
      if (window.callerflash?.updater?.check) {
        const result = (await window.callerflash.updater.check(channel)) as Record<string, unknown>;
        if (result.upToDate === true) {
          const ver = useAppStore.getState().updateInfo.currentVersion;
          addLog({ level: 'success', category: 'UPDATE', message: `Version ${ver} is up to date (channel: ${channel})` });
        } else if (result.version) {
          addLog({ level: 'info', category: 'UPDATE', message: `Update available: ${result.version as string}` });
          if (result.downloadUrl) {
            addLog({ level: 'info', category: 'UPDATE', message: `  Release: ${result.downloadUrl as string}` });
          }
        } else if (result.error) {
          addLog({ level: 'warning', category: 'UPDATE', message: `Update check returned: ${result.error as string}` });
        } else {
          addLog({ level: 'info', category: 'UPDATE', message: 'Update check complete (no actionable result)' });
        }
      } else {
        addLog({ level: 'warning', category: 'UPDATE', message: 'Update API not available (dev mode)' });
      }
    } catch (e) {
      addLog({ level: 'warning', category: 'UPDATE', message: `Update check failed: ${String(e)}` });
    }

    addLog({ level: 'success', category: 'SYSTEM', message: '══════ Diagnostic suite complete ══════' });
  };

  const exportLogs = async () => {
    const text = diagnosticLogs.map((log) => {
      const ts = log.timestamp instanceof Date ? log.timestamp : new Date(log.timestamp);
      return `[${ts.toISOString()}] [${log.level.toUpperCase()}] [${log.category}] ${log.message}${log.details ? '\n  ' + log.details : ''}`;
    }).join('\n');
    // Use Rust backend to write to temp file and open it (reliable in Tauri webview)
    if (window.callerflash?.diagnostics?.exportLogs) {
      const path = await window.callerflash.diagnostics.exportLogs(text);
      if (path) {
        addDiagnosticLog({ level: 'info', category: 'SYSTEM', message: `Log exported to ${path}` });
      } else {
        addDiagnosticLog({ level: 'error', category: 'SYSTEM', message: 'Log export failed' });
      }
    } else {
      // Fallback: browser blob download
      const blob = new Blob([text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `callerflash-diagnostics-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.log`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
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
