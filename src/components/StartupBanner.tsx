import { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import type { StartupReport } from '../bridge-types';

const defaultFetch = (): Promise<StartupReport | null> =>
  window.callerflash?.startup?.runChecks?.().catch(() => null) ?? Promise.resolve(null);

/**
 * Surfaces the backend startup self-check report (run_startup_checks) when it
 * contains problems. Renders nothing when everything is healthy, so a clean
 * machine sees no UI change.
 */
export function StartupBanner({
  fetchReport = defaultFetch,
}: {
  fetchReport?: () => Promise<StartupReport | null>;
}) {
  const [report, setReport] = useState<StartupReport | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchReport()
      .then((r) => {
        if (!cancelled && r) setReport(r);
      })
      .catch(() => {
        // Bridge unavailable (web dev mode) — silently skip.
      });
    return () => {
      cancelled = true;
    };
  }, [fetchReport]);

  if (!report || dismissed) return null;
  const failed = report.checks.filter((c) => !c.ok);
  const osWarn = report.os_name === 'windows' && !report.is_windows_11;
  if (failed.length === 0 && !osWarn) return null;

  return (
    <div
      role="alert"
      data-testid="startup-banner"
      className="flex items-start gap-2 px-4 py-2 bg-amber-500/10 border-b border-amber-500/30"
    >
      <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1 text-xs text-win-text">
        <p className="font-semibold">Startup checks found issues</p>
        <ul className="list-disc list-inside mt-1 space-y-0.5 text-win-text-secondary">
          {failed.map((c) => (
            <li key={c.name}>
              <span className="font-medium">{c.name}</span>
              {c.message ? `: ${c.message}` : ''}
            </li>
          ))}
          {osWarn && (
            <li>
              Running on Windows build {report.os_version} (pre-Windows 11
              {report.edition ? `, ${report.edition}` : ''}) — some features may behave differently
            </li>
          )}
        </ul>
      </div>
      <button
        onClick={() => setDismissed(true)}
        aria-label="Dismiss startup warnings"
        className="shrink-0 p-1 rounded hover:bg-win-surface transition-colors"
      >
        <X className="w-3.5 h-3.5 text-win-text-secondary" />
      </button>
    </div>
  );
}
