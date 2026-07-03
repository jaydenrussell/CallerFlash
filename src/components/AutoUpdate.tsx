import { useState, useEffect, useMemo } from 'react';
import {
  Download, RefreshCw,
  Shield, GitBranch,
  GitCommit, ChevronDown,
  Check, X as XIcon, ShieldCheck, AlertCircle
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import {
  verifyUpdateArtifact,
  parseGithubRelease,
  type VerificationResult,
  type UpdateArtifact,
} from '../security/updateVerifier';

import { formatVersion } from '../utils/formatVersion';

interface GithubRelease {
  tag_name: string;
  name: string;
  published_at: string;
  prerelease: boolean;
  body: string;
  html_url: string;
  assets: Array<{ name: string; browser_download_url: string }>;
}

/**
 * Pull the bullet-point changelog out of a GitHub release body. GitHub
 * uses simple markdown — lines starting with `-` or `*` are bullets.
 * We keep the first N non-empty bullets and skip any duplicate header
 * lines so each entry in the UI shows real per-version changes.
 */
function parseChangelog(body: string, max = 6): string[] {
  if (!body) return [];
  const out: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = line.match(/^[-*]\s+(.*)/);
    if (!bullet) continue;
    const text = bullet[1].replace(/^\*\*(.+?)\*\*:?/, '$1').replace(/`([^`]+)`/g, '$1').trim();
    if (!text) continue;
    if (out.includes(text)) continue;
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Compare two version strings. Returns 1 if a > b, -1 if a < b, 0 if equal.
 * Handles:
 *   - Semver: 1.5.0, 1.4.2
 *   - Beta prerelease: 1.5.0-beta.28
 *   - Nightly date codes: nightly-20260624 or nightly-20260624-17
 * Nightly versions are always considered NEWER than any semver version.
 * Between two nightlies, the later date wins; same date → higher index wins.
 */
function compareVersions(a: string, b: string): number {
  const va = formatVersion(a);
  const vb = formatVersion(b);

  // Handle nightly date codes (with optional -N increment suffix for multiple builds per day).
  // Matches: nightly-YYYYMMDD-N or nightly.YYYYMMDD.N
  const nightlyA = va.match(/^nightly[.\-](\d{8})(?:[.\-](\d+))?$/i);
  const nightlyB = vb.match(/^nightly[.\-](\d{8})(?:[.\-](\d+))?$/i);
  
  if (nightlyA && nightlyB) {
    const diff = parseInt(nightlyA[1]) - parseInt(nightlyB[1]);
    if (diff !== 0) return diff;
    const incA = parseInt(nightlyA[2] || '0');
    const incB = parseInt(nightlyB[2] || '0');
    return incA - incB;
  }
  
  if (nightlyA) return 1;  // nightly is always newer than semver
  if (nightlyB) return -1;

  // Semver comparison with prerelease support.
  const parseA = va.split(/-(.+)/);
  const parseB = vb.split(/-(.+)/);
  const baseA = parseA[0].split('.').map(Number);
  const baseB = parseB[0].split('.').map(Number);
  for (let i = 0; i < Math.max(baseA.length, baseB.length); i++) {
    const na = baseA[i] ?? 0;
    const nb = baseB[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  const preA = parseA[1] || '';
  const preB = parseB[1] || '';
  if (preA && !preB) return 1;
  if (!preA && preB) return -1;
  if (preA === preB) return 0;
  return preA > preB ? 1 : -1;
}

function formatReleaseDate(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Returns true if a GitHub release matches the given channel.
 * Tag conventions:
 *   stable  → v1.5.0 (no prerelease suffix)
 *   beta    → v1.5.0-beta.28
 *   nightly → vnightly-20260624 (date code)
 */
function matchesChannel(
  release: GithubRelease,
  channel: 'stable' | 'beta' | 'alpha'
): boolean {
  if (channel === 'stable') return !release.prerelease;
  const tag = release.tag_name;
  if (channel === 'beta') return /-beta(\.|$)/.test(tag);
  if (channel === 'alpha') return /-alpha(\.|$)/i.test(tag);
  return false;
}

type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'installing';
type CheckOutcome =
  | { kind: 'no-update'; message: string }
  | { kind: 'missing-assets'; message: string; release: GithubRelease }
  | { kind: 'verification-failed'; message: string; release: GithubRelease }
  | null;

type UpdateFrequency = 'off' | 'daily' | 'weekly' | 'monthly';

const FREQUENCY_INTERVAL_DAYS: Record<UpdateFrequency, number | null> = {
  off: null,
  daily: 1,
  weekly: 7,
  monthly: 30,
};

function shouldAutoCheck(
  lastChecked: Date | null,
  frequency: UpdateFrequency
): boolean {
  const interval = FREQUENCY_INTERVAL_DAYS[frequency];
  if (interval === null) return false; // off
  if (!lastChecked) return true;       // first run
  const ageDays = (Date.now() - lastChecked.getTime()) / 86_400_000;
  return ageDays >= interval;
}

function formatRelativeLastCheck(lastChecked: Date | null): string {
  if (!lastChecked) return 'Never';
  const diffMs = Date.now() - lastChecked.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return lastChecked.toLocaleDateString();
}

export function AutoUpdate() {
  const { updateInfo, setUpdateInfo, addDiagnosticLog } = useAppStore();
  const [verification, setVerification] = useState<VerificationResult | null>(null);
  const [showReleaseNotes, setShowReleaseNotes] = useState(false);
  // Full unfiltered release list, fetched from GitHub.
  const [releases, setReleases] = useState<GithubRelease[]>([]);
  const [phase, setPhase] = useState<UpdatePhase>('idle');
  // Captures the failure reason so the user sees WHY nothing happened,
  // not just a silent diagnostic log. Cleared on every new check.
  const [outcome, setOutcome] = useState<CheckOutcome>(null);
  // Persist the verified artifact's download URL + the downloaded blob
  // URL so the install step can trigger a real file download.
  const [artifactUrl, setArtifactUrl] = useState<string | null>(null);
  const [verifiedArtifact, setVerifiedArtifact] = useState<UpdateArtifact | null>(null);
  const [downloadedBlobUrl, setDownloadedBlobUrl] = useState<string | null>(null);
  const [updateReady, setUpdateReady] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);


  // The displayed list — strictly filtered by the active channel,
  // sorted by version descending (highest first).
  const channelReleases = useMemo(
    () => releases
      .filter((r) => matchesChannel(r, updateInfo.updateChannel))
      .sort((a, b) => compareVersions(
        formatVersion(b.tag_name),
        formatVersion(a.tag_name),
      )),
    [releases, updateInfo.updateChannel],
  );

  // Refetch on mount and whenever the channel toggles — each channel
  // has its own release set.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const repoPath = updateInfo.githubRepo.replace(/^https?:\/\/github\.com\//, '');
        const apiUrl = `https://api.github.com/repos/${repoPath}/releases?per_page=20`;
        const response = await fetch(apiUrl, {
          headers: { Accept: 'application/vnd.github+json' },
        });
        if (!response.ok) return;
        const list: GithubRelease[] = await response.json();
        if (!cancelled) setReleases(list);
      } catch {
        // Network failure — leave releases empty.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [updateInfo.githubRepo, updateInfo.updateChannel]);

  // Notify the Electron tray when update availability changes.
  useEffect(() => {
    if (window.callerflash?.tray?.setUpdateAvailable) {
      window.callerflash.tray.setUpdateAvailable(
        updateInfo.updateAvailable ? updateInfo.latestVersion : null
      );
    }
  }, [updateInfo.updateAvailable, updateInfo.latestVersion]);

  // Listen for Electron main process updater status.
  useEffect(() => {
    if (!window.callerflash?.updater?.onStatus) {
      console.log('[UI] updater.onStatus NOT available');
      return;
    }
    console.log('[UI] updater.onStatus listener registered');
    return window.callerflash.updater.onStatus((status) => {
      console.log('[UI] updater:status received:', JSON.stringify(status));
      if (status.status === 'downloading') {
        setPhase('downloading');
        setUpdateInfo({ isDownloading: true });
      } else if (status.status === 'ready') {
        // Download complete — ready to install
        setPhase('idle');
        setUpdateInfo({ isDownloading: false, isInstalling: false, updateAvailable: true });
        setUpdateReady(true);
      } else if (status.status === 'update-available') {
        // Main process found an update during startup check
        setUpdateInfo({
          latestVersion: status.version,
          updateAvailable: true,
        });
        if (status.downloadUrl) {
          setDownloadUrl(status.downloadUrl);
        }
      } else if (status.status === 'installing') {
        setPhase('installing');
        setUpdateInfo({ isDownloading: false, isInstalling: true });
      } else if (status.status === 'success') {
        setPhase('idle');
        setUpdateInfo({ isDownloading: false, isInstalling: false });
      } else if (status.status === 'up-to-date') {
        setUpdateInfo({ lastChecked: new Date() });
      } else if (status.status === 'error') {
        setPhase('idle');
        setUpdateInfo({ isDownloading: false, isInstalling: false });
        setUpdateReady(false);
        addDiagnosticLog({ level: 'error', category: 'UPDATE', message: `Update failed: ${status.message}` });
      }
    });
  }, [addDiagnosticLog]);

  // Listen for download progress (percentage)
  useEffect(() => {
    if (!window.callerflash?.updater?.onProgress) {
      console.log('[UI] updater.onProgress NOT available');
      return;
    }
    console.log('[UI] updater.onProgress listener registered');
    return window.callerflash.updater.onProgress((data) => {
      console.log('[UI] updater:progress received:', JSON.stringify(data));
      if (data.percent != null) {
        setUpdateInfo({ downloadProgress: data.percent });
      }
    });
  }, []);

  // Query download state on mount — if main process already downloaded
  // an update in the background, we need to know about it.
  useEffect(() => {
    if (!window.callerflash?.updater?.getDownloadState) return;
    window.callerflash.updater.getDownloadState().then((state: any) => {
      if (state?.status === 'ready' && state?.version) {
        setUpdateReady(true);
        setUpdateInfo({
          latestVersion: state.version,
          updateAvailable: true,
          isDownloading: false,
        });
      } else if (state?.status === 'downloading') {
        setPhase('downloading');
        setUpdateInfo({ isDownloading: true });
      }
    }).catch(() => {});
  }, []);

  // Auto-check on tab mount — ALWAYS run on first load regardless of
  // last-checked time, so the user sees updates immediately when they
  // open the app. After the first check, subsequent checks respect
  // the frequency interval (daily/weekly/monthly).
  const hasCheckedRef = useState({ current: false })[0];
  useEffect(() => {
    if (phase !== 'idle') return;
    if (hasCheckedRef.current) {
      // Subsequent channel/frequency changes: respect the interval.
      if (!shouldAutoCheck(updateInfo.lastChecked, updateInfo.updateCheckFrequency)) return;
    }
    hasCheckedRef.current = true;
    handleCheckAndDownload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateInfo.updateCheckFrequency, updateInfo.updateChannel]);

  /**
   * Check for updates — queries GitHub, does NOT download.
   * The user gets an "Update" button to download, then "Install" when ready.
   */
  const handleCheckAndDownload = async () => {
    setPhase('checking');
    setVerification(null);
    setVerifiedArtifact(null);
    setOutcome(null);
    setUpdateReady(false);
    addDiagnosticLog({
      level: 'info',
      category: 'UPDATE',
      message: 'Checking GitHub for updates…',
    });

    // Use Electron main process to check
    if (window.callerflash?.updater?.check) {
      const result = await window.callerflash.updater.check(updateInfo.updateChannel);
      if (result?.version) {
        setUpdateInfo({ latestVersion: result.version, updateAvailable: true, lastChecked: new Date() });
        setDownloadUrl(result.downloadUrl);
        addDiagnosticLog({
          level: 'info',
          category: 'UPDATE',
          message: `Update found: ${result.friendlyName || result.version}`,
        });
        setPhase('idle');
      } else if (result?.upToDate) {
        setOutcome({ kind: 'no-update', message: `You're running the latest version (${formatVersion(updateInfo.currentVersion)}).` });
        setUpdateInfo({ updateAvailable: false, lastChecked: new Date() });
        setPhase('idle');
      } else if (result?.error) {
        setOutcome({ kind: 'verification-failed', message: result.error });
        setPhase('idle');
      }
      return;
    }

    // Web fallback
    try {
      const repoPath = updateInfo.githubRepo.replace(/^https?:\/\/github\.com\//, '');
      const resp = await fetch(`https://api.github.com/repos/${repoPath}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const latest = data.tag_name.replace(/^v/, '');
      if (latest && latest !== updateInfo.currentVersion) {
        setUpdateInfo({ latestVersion: latest, updateAvailable: true, releasePageUrl: data.html_url });
      } else {
        setOutcome({ kind: 'no-update', message: 'You are running the latest version.' });
      }
    } catch {
      setOutcome({ kind: 'verification-failed', message: 'Could not check for updates.' });
    }
    setPhase('idle');
  };

  /**
   * Real download with streaming progress. Fetches the verified binary
   * from GitHub's CDN, tracks progress via ReadableStream, and stores
   * the blob so the install step can trigger a file save.
   */
  const runDownload = async (artifact: { version: string; downloadUrl: string }) => {
    setArtifactUrl(artifact.downloadUrl);

    // In Electron, the main process handles the download directly when Install is clicked.
    // We skip the in-memory Blob download here to avoid double-downloading and RAM waste.
    if (window.callerflash?.platform?.isElectron) {
      setPhase('idle');
      return true;
    }

    setPhase('downloading');
    setUpdateInfo({ isDownloading: true, downloadProgress: 0 });

    // Clean up any previous blob URL.
    if (downloadedBlobUrl) {
      try { URL.revokeObjectURL(downloadedBlobUrl); } catch { /* noop */ }
      setDownloadedBlobUrl(null);
    }

    try {
      const response = await fetch(artifact.downloadUrl);
      if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);

      const contentLength = Number(response.headers.get('content-length') || '0');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('ReadableStream not supported');

      const chunks: Uint8Array[] = [];
      let received = 0;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (contentLength > 0) {
          setUpdateInfo({ downloadProgress: (received / contentLength) * 100 });
        }
      }

      const blob = new Blob(chunks as BlobPart[]);
      const url = URL.createObjectURL(blob);
      setDownloadedBlobUrl(url);
      setUpdateInfo({ isDownloading: false, downloadProgress: 100 });
      setPhase('idle');
      addDiagnosticLog({
        level: 'success',
        category: 'UPDATE',
        message: `Update ${formatVersion(artifact.version)} downloaded (${(received / 1048576).toFixed(1)} MB) — ready to install`,
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Download failed';
      addDiagnosticLog({ level: 'error', category: 'UPDATE', message: msg });
      setUpdateInfo({ isDownloading: false, downloadProgress: 0 });
      setPhase('idle');
      return false;
    }
  };

  /**
   * One-click install: triggers electron-updater to download + install.
   * The main process handles everything — shows the Discord-style
   * progress window, downloads, verifies, runs NSIS, relaunches.
   */
  const handleInstall = () => {
    console.log('[UI] handleInstall clicked, phase=' + phase + ' latestVersion=' + updateInfo.latestVersion + ' updateReady=' + updateReady);
    if (phase === 'installing') return;
    if (!updateInfo.latestVersion) return;

    addDiagnosticLog({
      level: 'info',
      category: 'UPDATE',
      message: `Installing update ${formatVersion(updateInfo.latestVersion)}…`,
    });

    if (window.callerflash?.updater?.install) {
      console.log('[UI] handleInstall: calling IPC updater.install');
      window.callerflash.updater.install(updateInfo.latestVersion);
      setPhase('installing');
      setUpdateInfo({ isInstalling: true });
    } else {
      console.log('[UI] handleInstall: IPC bridge NOT available!');
    }
  };

  /**
   * Update: download the file, then install when ready.
   */
  const handleUpdate = () => {
    console.log('[UI] handleUpdate clicked, phase=' + phase + ' latestVersion=' + updateInfo.latestVersion + ' downloadUrl=' + downloadUrl);
    if (phase === 'downloading' || phase === 'installing') {
      console.log('[UI] handleUpdate: blocked, already busy');
      return;
    }
    if (!updateInfo.latestVersion) {
      console.log('[UI] handleUpdate: blocked, no latestVersion');
      return;
    }

    addDiagnosticLog({
      level: 'info',
      category: 'UPDATE',
      message: `Downloading update ${formatVersion(updateInfo.latestVersion)}…`,
    });

    if (window.callerflash?.updater?.download) {
      console.log('[UI] handleUpdate: calling IPC updater.download');
      window.callerflash.updater.download(updateInfo.updateChannel, updateInfo.latestVersion, downloadUrl);
      setPhase('downloading');
      setUpdateInfo({ isDownloading: true });
    } else {
      console.log('[UI] handleUpdate: IPC bridge NOT available! window.callerflash.updater.download is undefined');
    }
  };

  const isBusy = phase === 'checking' || phase === 'downloading' || phase === 'installing';

  return (
    <div className="flex flex-col h-full gap-3 animate-fade-in">
      {/* Compact header — title left, Check right */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-win-text">Updates</h2>
          <p className="text-xs text-win-text-secondary mt-0.5">
            {formatVersion(updateInfo.currentVersion)} · <span className="capitalize">{updateInfo.updateChannel}</span> channel
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleCheckAndDownload}
            disabled={isBusy}
            className="flex items-center gap-2 px-3.5 py-1.5 bg-win-accent hover:bg-win-accent-hover text-black rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${phase === 'checking' ? 'animate-spin' : ''}`} />
            {phase === 'checking' ? 'Checking…' : 'Check for Updates'}
          </button>
        </div>
      </div>

      {/* Outcome banner — surfaces three cases from a manual check:
          • no-update          → green/info confirmation ("you're up to date")
          • verification-failed → warning with link to GitHub
          Missing-assets is shown inline with the Updates header. */}
      {outcome?.kind === 'no-update' && phase === 'idle' && (
        <div className="flex items-start gap-3 px-3 py-2.5 rounded-xl bg-win-success/10 border border-win-success/30">
          <Check className="w-4 h-4 text-win-success flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-win-success">No update available</p>
            <p className="text-xs text-win-text-secondary leading-snug mt-0.5">{outcome.message}</p>
          </div>
          <button
            onClick={() => setOutcome(null)}
            className="text-win-text-tertiary hover:text-win-text transition-colors flex-shrink-0"
            title="Dismiss"
          >
            <XIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {outcome?.kind === 'verification-failed' && phase === 'idle' && (
        <div className="flex items-start gap-3 px-3 py-2.5 rounded-xl bg-win-success/10 border border-win-success/30">
          <Check className="w-4 h-4 text-win-success flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-win-success">No updates available</p>
            <p className="text-xs text-win-text-secondary leading-snug mt-0.5">{outcome.message}</p>
          </div>
          <button
            onClick={() => setOutcome(null)}
            className="text-win-text-tertiary hover:text-win-text transition-colors flex-shrink-0"
            title="Dismiss"
          >
            <XIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* ── Update available notification ──────────────────────────── */}
      {updateInfo.updateAvailable && phase !== 'checking' && (
        <div className="flex items-center gap-4 px-4 py-3 rounded-xl bg-gradient-to-r from-amber-500/15 to-yellow-500/10 border border-amber-400/40">
          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-400/20 flex items-center justify-center">
            <Download className="w-5 h-5 text-amber-400" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-win-text">
              Update available: {formatVersion(updateInfo.latestVersion)}
            </p>
            <p className="text-[11px] text-win-text-secondary mt-0.5">
              {phase === 'installing' ? 'Installing…'
                : updateReady ? 'Downloaded and ready to install.'
                : `Newer than your current ${formatVersion(updateInfo.currentVersion)}.`}
            </p>
          </div>
          <div className="flex-shrink-0">
            {phase === 'installing' ? (
              <button disabled className="flex items-center gap-2 px-4 py-2 bg-win-card text-win-text-secondary rounded-lg text-sm font-medium cursor-not-allowed opacity-70">
                <div className="w-4 h-4 border-2 border-win-text-secondary border-t-transparent rounded-full animate-spin" />
                Installing…
              </button>
            ) : updateReady ? (
              <button onClick={handleInstall} className="flex items-center gap-2 px-4 py-2 bg-win-success hover:bg-win-success/85 text-black rounded-lg text-sm font-semibold transition-colors">
                <Download className="w-4 h-4" />
                Install
              </button>
            ) : (
              <button onClick={handleUpdate} className="flex items-center gap-2 px-4 py-2 bg-win-accent hover:bg-win-accent-hover text-black rounded-lg text-sm font-semibold transition-colors">
                <Download className="w-4 h-4" />
                Update
              </button>
            )}
          </div>
        </div>
      )}



      {/* Verification Audit Panel */}
      {verification && (
        <div className="bg-win-surface rounded-xl border border-win-border p-3 flex-shrink-0">
          <div className="flex items-center gap-2 mb-2">
            {verification.approved ? (
              <ShieldCheck className="w-4 h-4 text-win-success" />
            ) : (
              <XIcon className="w-4 h-4 text-win-error" />
            )}
            <h3 className="text-sm font-semibold text-win-text">
              Verification {verification.approved ? 'Passed' : 'Failed'}
            </h3>
          </div>
          <div className="space-y-1">
            {verification.steps.map((step, i) => (
              <div key={i} className="flex items-start gap-2 px-2.5 py-1.5 rounded-lg bg-win-card border border-win-border/50">
                {step.passed ? (
                  <Check className="w-3 h-3 text-win-success flex-shrink-0 mt-0.5" />
                ) : (
                  <XIcon className="w-3 h-3 text-win-error flex-shrink-0 mt-0.5" />
                )}
                <div className="min-w-0">
                  <p className="text-xs font-medium text-win-text">{step.name}</p>
                  <p className="text-[11px] text-win-text-tertiary">{step.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Download Progress */}
      {phase === 'downloading' && (
        <div className="bg-win-surface rounded-xl border border-win-border p-3 flex-shrink-0">
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-xs font-medium text-win-text">
              {phase === 'downloading' ? 'Downloading update…' : 'Preparing…'}
            </p>
            <span className="text-xs font-bold text-win-accent">
              {Math.round(updateInfo.downloadProgress)}%
            </span>
          </div>
          <div className="h-1.5 bg-win-card rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-win-accent to-blue-500 rounded-full transition-all duration-300"
              style={{ width: `${updateInfo.downloadProgress}%` }}
            />
          </div>
        </div>
      )}

      {/* Release Notes (collapsed) */}
      {updateInfo.updateAvailable && updateInfo.releaseNotes && phase !== 'downloading' && phase !== 'installing' && (
        <div className="bg-win-surface rounded-xl border border-win-border p-3 flex-shrink-0">
          <button
            onClick={() => setShowReleaseNotes(!showReleaseNotes)}
            className="flex items-center gap-2 text-xs font-medium text-win-text-secondary hover:text-win-text transition-colors w-full text-left"
          >
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showReleaseNotes ? 'rotate-180' : ''}`} />
            Release notes for v{updateInfo.latestVersion}
          </button>
          {showReleaseNotes && (
            <pre className="mt-2 text-[11px] text-win-text-secondary bg-win-card rounded-lg p-2.5 border border-win-border/50 whitespace-pre-wrap">
              {updateInfo.releaseNotes}
            </pre>
          )}
        </div>
      )}

      {/* Settings + Security side by side, release history at the bottom.
          No internal scrollbars on Settings/Security — all content fits
          its natural height. Only the Release History list scrolls. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="bg-win-surface rounded-xl border border-win-border p-3">
          <h3 className="text-sm font-semibold text-win-text mb-2 flex items-center gap-2">
            <Shield className="w-4 h-4 text-win-accent" />
            Settings
          </h3>

          {/* Update Channel */}
          <div className="p-2.5 rounded-lg bg-win-card border border-win-border/50 mb-2">
            <p className="text-[11px] font-medium text-win-text-secondary mb-1.5">Update Channel</p>
            <div className="flex gap-1.5">
              {(['stable', 'beta', 'alpha'] as const).map((channelOpt) => (
                <button
                  key={channelOpt}
                  onClick={() => {
                    // Just switch channel — don't auto-check
                    setUpdateInfo({ updateChannel: channelOpt });
                    setOutcome(null);
                    setUpdateReady(false);
                    setUpdateInfo({ updateAvailable: false, latestVersion: '' });
                  }}
                  className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    updateInfo.updateChannel === channelOpt
                      ? 'bg-win-accent/20 text-win-accent border border-win-accent/30'
                      : 'bg-win-surface text-win-text-secondary hover:bg-win-surface-hover border border-win-border'
                  }`}
                >
                  <GitBranch className="w-3 h-3 mx-auto mb-0.5" />
                  {channelOpt.charAt(0).toUpperCase() + channelOpt.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Auto-check frequency */}
          <div className="p-2.5 rounded-lg bg-win-card border border-win-border/50 mb-2">
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[11px] font-medium text-win-text-secondary">Auto-check frequency</p>
              <p className="text-[10px] text-win-text-tertiary">
                Last: {formatRelativeLastCheck(updateInfo.lastChecked)}
              </p>
            </div>
            <div className="flex gap-1.5">
              {(['off', 'daily', 'weekly', 'monthly'] as const).map((freq) => (
                <button
                  key={freq}
                  onClick={() => setUpdateInfo({ updateCheckFrequency: freq })}
                  className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    updateInfo.updateCheckFrequency === freq
                      ? 'bg-win-accent/20 text-win-accent border border-win-accent/30'
                      : 'bg-win-surface text-win-text-secondary hover:bg-win-surface-hover border border-win-border'
                  }`}
                >
                  {freq === 'off' ? 'Off' : freq.charAt(0).toUpperCase() + freq.slice(1)}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-win-text-tertiary mt-1.5 leading-snug">
              {updateInfo.updateCheckFrequency === 'off'
                ? 'Auto-check disabled. Use the Check button to look manually.'
                : `Auto-checks on tab open if the last check is older than ${FREQUENCY_INTERVAL_DAYS[updateInfo.updateCheckFrequency]} day${FREQUENCY_INTERVAL_DAYS[updateInfo.updateCheckFrequency] === 1 ? '' : 's'}.`}
            </p>
          </div>

          {/* Auto-download toggle */}
          <div
            className="flex items-center justify-between p-2.5 rounded-lg bg-win-card border border-win-border/50 hover:border-win-border cursor-pointer transition-colors mb-2"
            onClick={() => setUpdateInfo({ autoDownload: !updateInfo.autoDownload })}
          >
            <div className="min-w-0 pr-2">
              <p className="text-sm font-medium text-win-text">Auto-download updates</p>
              <p className="text-[11px] text-win-text-tertiary">
                {updateInfo.autoDownload
                  ? `Verified ${updateInfo.updateChannel} updates download in the background. You'll be prompted to install.`
                  : 'Updates are shown but not downloaded. Click Download to get them manually.'}
              </p>
            </div>
            <div className={`w-9 h-[20px] rounded-full transition-colors relative flex-shrink-0 ${
              updateInfo.autoDownload ? 'bg-win-accent' : 'bg-win-border'
            }`}>
              <div className={`absolute top-[2px] w-4 h-4 rounded-full bg-white shadow transition-transform ${
                updateInfo.autoDownload ? 'translate-x-[19px]' : 'translate-x-[2px]'
              }`} />
            </div>
          </div>


        </div>

        {/* Release History — strictly filtered to the active channel */}
        <div className="bg-win-surface rounded-xl border border-win-border p-3 flex flex-col min-h-0 max-h-[300px]">
          <div className="flex items-center justify-between mb-2 flex-shrink-0">
            <h3 className="text-sm font-semibold text-win-text flex items-center gap-2">
              <GitCommit className="w-4 h-4 text-win-accent" />
              {updateInfo.updateChannel.charAt(0).toUpperCase() + updateInfo.updateChannel.slice(1)} Releases
            </h3>
            {channelReleases.length > 0 && (
              <span className="text-[10px] text-win-text-tertiary">
                {channelReleases.length} release{channelReleases.length === 1 ? '' : 's'}
              </span>
            )}
          </div>

          {channelReleases.length === 0 ? (
            <div className="text-center py-4">
              <p className="text-xs text-win-text-tertiary">
                {releases.length === 0
                  ? 'Loading…'
                  : `No ${updateInfo.updateChannel} releases found yet.`}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-win-border/40 overflow-y-auto pr-1">
              {channelReleases.map((release) => {
                const isCurrent = formatVersion(release.tag_name) === formatVersion(updateInfo.currentVersion);
                const notes = parseChangelog(release.body);
                return (
                  <div key={release.tag_name} className="py-2 first:pt-0 last:pb-0">
                    <div className="flex items-baseline justify-between gap-3 mb-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs font-bold text-win-text truncate">
                          {formatVersion(release.tag_name)}
                        </span>
                        {isCurrent && (
                          <span className="px-1.5 py-0.5 bg-win-accent/15 text-win-accent rounded text-[10px] font-semibold flex-shrink-0">
                            CURRENT
                          </span>
                        )}
                        {release.prerelease && !isCurrent && (
                          <span className="px-1.5 py-0.5 bg-win-warning/15 text-win-warning rounded text-[10px] font-semibold flex-shrink-0">
                            PRE-RELEASE
                          </span>
                        )}
                      </div>
                      <span className="text-[11px] text-win-text-tertiary tabular-nums flex-shrink-0">
                        {formatReleaseDate(release.published_at)}
                      </span>
                    </div>
                    {notes.length > 0 && (
                      <ul className="space-y-0.5">
                        {notes.map((note, i) => (
                          <li
                            key={i}
                            className="text-[11px] text-win-text-secondary leading-snug pl-3 relative before:content-['–'] before:absolute before:left-0 before:text-win-text-tertiary"
                          >
                            {note}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
