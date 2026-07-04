import { useState, useEffect, useRef, useCallback } from 'react';
import { Download, Rocket, AlertCircle, CheckCircle2, Loader2, Info } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import {
  verifyUpdateArtifact,
  parseGithubRelease,
  type VerificationResult,
  type UpdateArtifact,
} from '../security/updateVerifier';

interface UpdateInfo {
  version?: string;
  downloadUrl?: string;
  publishedAt?: string;
  upToDate?: boolean;
  error?: string;
}

interface DownloadState {
  version: string | null;
  path: string | null;
  status: 'idle' | 'downloading' | 'ready' | 'error';
  error: string | null;
}

function friendlyName(v: string | undefined) {
  if (!v) return 'unknown';
  const beta = v.match(/^(.+?)-beta\.(\d+)$/);
  if (beta) return `Beta ${beta[1]} (#${beta[2]})`;
  const alpha = v.match(/^(.+?)-alpha\.(\d+)$/);
  if (alpha) return `Alpha ${alpha[1]} (#${alpha[2]})`;
  return v;
}

function compareVersions(a: string, b: string) {
  const normalise = (v: string) => v.replace(/^v/, '').replace(/0\.0\.0-nightly[.\-]/i, 'nightly-');
  const na = normalise(a), nb = normalise(b);
  if (na === nb) return 0;
  const pa = na.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  const pb = nb.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (pa && pb) {
    const [, am, ai, ap] = pa.map(Number);
    const [, bm, bi, bp] = pb.map(Number);
    if (am !== bm) return am - bm;
    if (ai !== bi) return ai - bi;
    if (ap !== bp) return ap - bp;
  }
  return na < nb ? -1 : na > nb ? 1 : 0;
}

export function AutoUpdate() {
  const { updateInfo } = useAppStore();
  const channel = updateInfo.updateChannel;
  const autoDownload = updateInfo.autoDownload;
  const addDiagnosticLog = useAppStore(s => s.addDiagnosticLog);

  const [isChecking, setIsChecking] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [downloadState, setDownloadState] = useState<DownloadState | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number>(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const [showBetaNotice, setShowBetaNotice] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkInFlight = useRef(false);

  const installedVersion = useAppStore(s => s.updateInfo.currentVersion);

  const refreshDownloadState = useCallback(async () => {
    try {
      const s = await window.callerflash?.updater?.getDownloadState() as DownloadState | null;
      setDownloadState(s);
      return s;
    } catch { return null; }
  }, []);

  const doCheck = useCallback(async (opts?: { silent?: boolean }) => {
    if (checkInFlight.current) return null;
    checkInFlight.current = true;
    if (!opts?.silent) setIsChecking(true);
    try {
      const result = await window.callerflash?.updater?.check(channel) as UpdateInfo | null;
      if (!result) return null;

      if (result.upToDate) {
        setStatusMessage(null);
        setLatestVersion(null);
        setLastError(null);
        setLastCheckedAt(Date.now());
        if (!opts?.silent) addDiagnosticLog({ level: 'success', category: 'UPDATE', message: 'App is up to date.' });
        await refreshDownloadState();
        return null;
      }

      setLatestVersion(result.version ?? null);
      setLastCheckedAt(Date.now());
      setLastError(null);
      setShowBetaNotice(channel === 'beta' || channel === 'alpha');

      if (!opts?.silent) {
        const updateVersion = result.version ?? 'unknown';
        const shouldInstall = compareVersions(installedVersion, updateVersion) <= 0;
        if (shouldInstall) {
          setStatusMessage(`Update ready to install.`);
          addDiagnosticLog({ level: 'success', category: 'UPDATE', message: `Version ${result.version} downloaded and ready.` });
        } else {
          setStatusMessage(`Version ${result.version} is available.`);
          addDiagnosticLog({ level: 'info', category: 'UPDATE', message: `Update available: ${result.version}` });
        }
      }

      if (result.version && autoDownload && !opts?.silent) {
        window.callerflash?.updater?.download({ channel, version: result.version, downloadUrl: result.downloadUrl! });
        setIsDownloading(true);
        setStatusMessage('Downloading update...');
        addDiagnosticLog({ level: 'info', category: 'UPDATE', message: `Downloading ${result.version}...` });
      }

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLastError(message);
      setLastCheckedAt(Date.now());
      if (!opts?.silent) {
        setStatusMessage(null);
        addDiagnosticLog({ level: 'error', category: 'UPDATE', message: `Check failed: ${message}` });
      }
      return null;
    } finally {
      checkInFlight.current = false;
      if (!opts?.silent) setIsChecking(false);
    }
  }, [channel, autoDownload, installedVersion, refreshDownloadState, addDiagnosticLog]);

  useEffect(() => {
    const clearTimer = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
    const startTimer = (secs: number) => {
      clearTimer();
      timerRef.current = setInterval(() => doCheck({ silent: true }), secs * 1000);
    };

    const frequency = updateInfo.updateCheckFrequency ?? 'daily';
    if (frequency === 'off') clearTimer();
    else if (frequency === 'daily') startTimer(86400);
    else if (frequency === 'weekly') startTimer(604800);
    else startTimer(86400);

    return clearTimer;
  }, [updateInfo.updateCheckFrequency, doCheck]);

  useEffect(() => {
    let mounted = true;

    (async () => {
      const s = await window.callerflash?.updater?.getDownloadState() as DownloadState | null;
      if (mounted) setDownloadState(s);
    })();

    bgTimerRef.current = setTimeout(() => doCheck({ silent: true }), 2000);

    return () => {
      mounted = false;
      if (bgTimerRef.current) clearTimeout(bgTimerRef.current);
    };
  }, [doCheck]);

  useEffect(() => {
    const unsubs: (() => void)[] = [];

    const unsub1 = window.callerflash?.updater?.onStatus?.((payload: any) => {
      if (payload.status === 'downloading') { setIsDownloading(true); setStatusMessage('Downloading update...'); }
      if (payload.status === 'ready') {
        setIsDownloading(false);
        setStatusMessage('Update ready to install.');
        addDiagnosticLog({ level: 'success', category: 'UPDATE', message: 'Download complete.' });
        refreshDownloadState();
      }
      if (payload.status === 'installing') { setIsInstalling(true); setStatusMessage('Installing update...'); }
      if (payload.status === 'error') {
        setIsDownloading(false);
        setIsInstalling(false);
        setStatusMessage(null);
        if (payload.message) {
          setLastError(payload.message);
          addDiagnosticLog({ level: 'error', category: 'UPDATE', message: `Error: ${payload.message}` });
        }
      }
    });

    const unsub2 = window.callerflash?.updater?.onProgress?.((p: { percent: number }) => {
      if (p.percent !== undefined) setDownloadProgress(p.percent);
    });

    if (unsub1) unsubs.push(unsub1);
    if (unsub2) unsubs.push(unsub2);

    return () => { unsubs.forEach(u => u()); };
  }, [refreshDownloadState, addDiagnosticLog]);

  const isUpToDate = installedVersion !== 'unknown' && latestVersion !== null && compareVersions(installedVersion, latestVersion) >= 0;
  const hasDownload = downloadState?.status === 'ready' && downloadState.path;
  const updateAvailable = latestVersion !== null && !isUpToDate;
  const isBusy = isChecking || isDownloading || isInstalling;

  const handleUpdateClick = async () => {
    if (isBusy) return;

    // Case 1: File already downloaded — install
    if (downloadState?.status === 'ready' && downloadState.version && hasDownload) {
      setIsInstalling(true);
      setStatusMessage('Installing update...');
      window.callerflash?.updater?.install({ version: downloadState.version });
      addDiagnosticLog({ level: 'info', category: 'UPDATE', message: `Installing ${downloadState.version}...` });
      return;
    }

    // Case 2: No update known yet — check first
    if (!updateAvailable && !latestVersion) {
      const result = await doCheck();
      if (!result?.version) return; // up to date or error
    }

    // Case 3: Download needed
    if (latestVersion) {
      setIsDownloading(true);
      setDownloadProgress(0);
      setStatusMessage('Downloading update...');
      window.callerflash?.updater?.download({ channel, version: latestVersion, downloadUrl: '' });
      addDiagnosticLog({ level: 'info', category: 'UPDATE', message: `Downloading ${latestVersion}...` });
    }
  };

  const buttonLabel = () => {
    if (isInstalling) return <><Loader2 className="w-4 h-4 animate-spin" /> Installing...</>;
    if (isDownloading) return <><Loader2 className="w-4 h-4 animate-spin" /> Downloading...</>;
    if (isChecking) return <><Loader2 className="w-4 h-4 animate-spin" /> Checking...</>;
    if (hasDownload) return <><Rocket className="w-4 h-4" /> Update</>;
    return <><Download className="w-4 h-4" /> Update</>;
  };

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-win-text">Updates</h2>
          <p className="text-xs text-win-text-secondary mt-1">
            Check, download, and install application updates
          </p>
        </div>
      </div>

      {showBetaNotice && (channel === 'beta' || channel === 'alpha') && (
        <div className="bg-win-surface rounded-xl border border-win-border p-4">
          <div className="flex items-start gap-3">
            <Info className="w-5 h-5 text-win-text-tertiary mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm text-win-text-secondary">
                You are on the <span className="font-medium text-win-text capitalize">{channel}</span> channel.
                {channel === 'alpha' && ' Alpha versions may be unstable.'}
                {channel === 'beta' && ' Beta versions may contain bugs.'}
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="bg-win-surface rounded-xl border border-win-border p-4">
        <div className="space-y-4">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-win-text">Version Information</h3>
            <div className="flex items-center gap-2">
              <p className="text-sm text-win-text-secondary">
                Installed: <span className="font-mono text-win-text">{friendlyName(installedVersion)}</span>
              </p>
              {isUpToDate && (
                <span className="inline-flex items-center gap-1 text-xs text-green-500">
                  <CheckCircle2 className="w-3 h-3" /> Up to date
                </span>
              )}
            </div>
            {latestVersion && (
              <p className="text-sm text-win-text-secondary">
                Latest: <span className="font-mono text-win-text">{friendlyName(latestVersion)}</span>
                {updateAvailable && (
                  <span className="ml-2 inline-flex items-center gap-1 text-xs text-win-accent">
                    <Download className="w-3 h-3" /> Available
                  </span>
                )}
              </p>
            )}
            {lastCheckedAt > 0 && (
              <p className="text-xs text-win-text-tertiary mt-1">
                Checked: {new Date(lastCheckedAt).toLocaleTimeString()}
              </p>
            )}
          </div>

          {isDownloading && (
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-win-text-secondary">
                <span>Downloading update...</span>
                <span>{downloadProgress}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-win-border overflow-hidden">
                <div
                  className="h-full bg-win-accent rounded-full transition-all duration-300 ease-out"
                  style={{ width: `${downloadProgress}%` }}
                />
              </div>
            </div>
          )}

          {lastError && (
            <div className="flex items-center gap-2 text-sm text-red-400">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span className="truncate">{lastError}</span>
            </div>
          )}

          {statusMessage && !lastError && (
            <div className="flex items-center gap-2 text-sm text-win-text-secondary">
              <Info className="w-4 h-4 flex-shrink-0" />
              <span>{statusMessage}</span>
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={handleUpdateClick}
              disabled={isBusy || isUpToDate}
              className="flex items-center justify-center gap-2 flex-1 px-4 py-2.5 bg-win-accent hover:bg-win-accent-hover text-black rounded-lg text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {buttonLabel()}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AutoUpdate;
