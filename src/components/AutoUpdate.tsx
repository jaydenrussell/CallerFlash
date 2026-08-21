import { useState, useEffect, useMemo, useRef } from 'react';
import {
  Download, RefreshCw,
  Shield, GitBranch,
  GitCommit, ChevronDown,
  Check, X as XIcon, AlertTriangle
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';

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
 *   Stable > beta (same base version).
 */
function compareVersions(a: string, b: string): number {
  const va = formatVersion(a);
  const vb = formatVersion(b);

  // Handle nightly date codes (with optional -N increment suffix for multiple builds per day).
  const nightlyA = va.match(/^nightly[.-](\d{8})(?:[.-](\d+))?$/i);
  const nightlyB = vb.match(/^nightly[.-](\d{8})(?:[.-](\d+))?$/i);

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
  // Parse "1.5.0-beta.28" → { major:1, minor:5, patch:0, pre:"beta", preN:28 }
  const parseSemver = (v: string) => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:[-.]([\w]+)(?:[.-](\d+))?)?$/);
    if (!m) return null;
    return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null, preN: m[5] ? +m[5] : 0 };
  };

  const pa = parseSemver(va);
  const pb = parseSemver(vb);

  if (pa && pb) {
    if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
    if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
    if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;

    // Same base version — compare prerelease tags.
    // No prerelease (stable) is NEWER than any prerelease (beta/alpha).
    if (!pa.pre && pb.pre) return 1;   // a is stable, b is beta → a > b
    if (pa.pre && !pb.pre) return -1;  // a is beta, b is stable → a < b
    if (pa.pre && pb.pre) {
      // Both have prerelease — compare type first (alpha < beta), then number.
      const typeOrder: Record<string, number> = { beta: 0 };
      const tA = typeOrder[pa.pre] ?? 1;
      const tB = typeOrder[pb.pre] ?? 1;
      if (tA !== tB) return tA > tB ? 1 : -1;
      return pa.preN > pb.preN ? 1 : pa.preN < pb.preN ? -1 : 0;
    }
    return 0; // both stable, same version
  }

  // Fallback: lexicographic comparison
  return va > vb ? 1 : va < vb ? -1 : 0;
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
 *   stable → v1.5.0 (no prerelease suffix)
 *   beta   → v1.5.0-beta.28
 */
function matchesChannel(
  release: GithubRelease,
  channel: 'stable' | 'beta'
): boolean {
  const tag = release.tag_name;
  if (channel === 'stable') return !/-(beta|tauri)(\.|$)/i.test(tag);
  if (channel === 'beta') return /-(beta|tauri)(\.|$)/i.test(tag);
  return false;
}

/** Check if a raw version string belongs to the given channel. */
function versionMatchesChannel(version: string, channel: 'stable' | 'beta'): boolean {
  const tag = version.replace(/^v/, '');
  if (channel === 'stable') return !/-(beta|tauri)(\.|$)/i.test(tag);
  if (channel === 'beta') return /-(beta|tauri)(\.|$)/i.test(tag);
  return false;
}

/** Map a backend ReleaseInfo into the shape the UI already consumes. */
function toGithubRelease(r: {
  tagName: string;
  name: string | null;
  publishedAt: string | null;
  prerelease: boolean;
  body: string | null;
  htmlUrl: string;
}): GithubRelease {
  return {
    tag_name: r.tagName,
    name: r.name ?? '',
    published_at: r.publishedAt ?? '',
    prerelease: r.prerelease,
    body: r.body ?? '',
    html_url: r.htmlUrl,
    assets: [],
  };
}

/**
 * Fetch the newest GitHub release for a single channel.
 *   stable → `/releases/latest` (GitHub's non-prerelease pointer).
 *   beta   → the newest prerelease whose tag matches the beta pattern
 *            (GitHub has no "latest prerelease" alias).
 * Uses the backend command when available (packaged app); falls back to a
 * direct fetch only in a plain browser dev session.
 * Returns null when the channel has no matching release.
 */
async function fetchChannelLatest(
  repoPath: string,
  channel: 'stable' | 'beta'
): Promise<GithubRelease | null> {
  const headers = { Accept: 'application/vnd.github+json' };
  if (window.callerflash?.updater?.listReleases) {
    const list = await window.callerflash.updater.listReleases();
    const mapped = list.map(toGithubRelease);
    if (channel === 'beta') {
      return mapped.find((r) => r.prerelease && /-(beta|tauri)(\.|$)/i.test(r.tag_name)) ?? null;
    }
    return mapped.find((r) => !r.prerelease) ?? null;
  }
  if (channel === 'beta') {
    const resp = await fetch(`https://api.github.com/repos/${repoPath}/releases?per_page=20`, { headers });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const list: GithubRelease[] = await resp.json();
    return list.find((r) => r.prerelease && /-(beta|tauri)(\.|$)/i.test(r.tag_name)) ?? null;
  }
  const resp = await fetch(`https://api.github.com/repos/${repoPath}/releases/latest`, { headers });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json() as Promise<GithubRelease>;
}

type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'installing';
type CheckOutcome =
  | { kind: 'no-update'; message: string }
  | { kind: 'missing-assets'; message: string; release: GithubRelease }
  | { kind: 'verification-failed'; message: string; release?: GithubRelease }
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
  const { updateInfo, setUpdateInfo, addDiagnosticLog } = useAppStore(
    useShallow((s) => ({
      updateInfo: s.updateInfo,
      setUpdateInfo: s.setUpdateInfo,
      addDiagnosticLog: s.addDiagnosticLog,
    })),
  );
  const [showReleaseNotes, setShowReleaseNotes] = useState(false);
  // Full unfiltered release list, fetched from GitHub.
  const [releases, setReleases] = useState<GithubRelease[]>([]);
  const [phase, setPhase] = useState<UpdatePhase>('idle');
  // Captures the failure reason so the user sees WHY nothing happened,
  // not just a silent diagnostic log. Cleared on every new check.
  const [outcome, setOutcome] = useState<CheckOutcome>(null);
  // Persist the verified artifact's download URL + the downloaded blob
  // URL so the install step can trigger a real file download.
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const channelRef = useRef(updateInfo.updateChannel);
  const checkIdRef = useRef(0);

  // Sync channel ref so the onStatus listener (registered once on mount)
  // always reads the current channel.
  useEffect(() => {
    channelRef.current = updateInfo.updateChannel;
  }, [updateInfo.updateChannel]);

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
  // has its own release set. Uses the backend command when available;
  // direct fetch only in a plain browser dev session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (window.callerflash?.updater?.listReleases) {
          const list = await window.callerflash.updater.listReleases();
          if (!cancelled) setReleases(list.map(toGithubRelease));
          return;
        }
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

  // Listen for updater status events from the backend.
  useEffect(() => {
    if (!window.callerflash?.updater?.onStatus) {
      return;
    }
    return window.callerflash.updater.onStatus((status) => {
      if (status.status === 'downloading') {
        setPhase('downloading');
        setUpdateInfo({ isDownloading: true });
      } else if (status.status === 'ready') {
        if (status.version && !versionMatchesChannel(status.version, channelRef.current)) {
          setUpdateInfo({ isDownloading: false, isInstalling: false });
          return;
        }
        // Skip if the ready version is not newer than current
        if (status.version && compareVersions(
          formatVersion(status.version),
          formatVersion(updateInfo.currentVersion)
        ) <= 0) {
          setUpdateInfo({ isDownloading: false, isInstalling: false });
          return;
        }
        // Don't reset phase here — handleUpdate() manages the flow.
        // The onStatus('ready') event can arrive AFTER handleUpdate has
        // already started the install step (setting phase='installing'),
        // which would race and reset phase to 'idle'.
        setUpdateInfo({ isDownloading: false, isInstalling: false, updateAvailable: true });
      } else if (status.status === 'update-available') {
        if (status.version && !versionMatchesChannel(status.version, channelRef.current)) return;
        if (status.version && compareVersions(
          formatVersion(status.version),
          formatVersion(updateInfo.currentVersion)
        ) <= 0) return;
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
        setUpdateInfo({ lastChecked: new Date(), updateAvailable: false, latestVersion: '' });
      } else if (status.status === 'error') {
        setPhase('idle');
        setUpdateInfo({ isDownloading: false, isInstalling: false });
        setOutcome({ kind: 'verification-failed', message: status.message || 'Update failed' });
      }
    });
  }, [addDiagnosticLog]);

  // Listen for download progress (percentage)
  useEffect(() => {
    if (!window.callerflash?.updater?.onProgress) {
      return;
    }
    return window.callerflash.updater.onProgress((data) => {
      if (data.percent != null) {
        setUpdateInfo({ downloadProgress: data.percent });
      }
    });
  }, []);

  // Listen for diagnostic log events from the main process updater
  useEffect(() => {
    if (!window.callerflash?.updater?.onDiagnostic) return;
    return window.callerflash.updater.onDiagnostic((data: { level: string; message: string; details?: string }) => {
      addDiagnosticLog({
        level: data.level as 'info' | 'success' | 'warning' | 'error',
        category: 'UPDATE',
        message: data.message,
        details: data.details,
      });
    });
  }, [addDiagnosticLog]);

  // Query download state — if main process already downloaded an update
  // in the background, we need to know about it. Re-check when channel
  // changes so stale downloads from a different channel don't leak through.
  useEffect(() => {
    if (!window.callerflash?.updater?.getDownloadState) return;
    window.callerflash.updater.getDownloadState().then((state) => {
      const s = state as { status?: string; version?: string };
      if (s?.status === 'ready' && s?.version) {
        if (!versionMatchesChannel(s.version, updateInfo.updateChannel)) return;
        const currentFormatted = formatVersion(updateInfo.currentVersion);
        const foundFormatted = formatVersion(s.version);
        if (compareVersions(foundFormatted, currentFormatted) <= 0) {
          return;
        }
        setUpdateInfo({
          latestVersion: s.version,
          updateAvailable: true,
          isDownloading: false,
        });
      } else if (s?.status === 'downloading') {
        setPhase('downloading');
        setUpdateInfo({ isDownloading: true });
      }
    }).catch((e) => addDiagnosticLog({ level: 'error', category: 'UPDATE', message: `Failed to get download state: ${e}` }));
  }, [updateInfo.updateChannel]);

  /**
   * Check for updates — queries GitHub, does NOT download.
   * The user gets an "Update" button to download, then "Install" when ready.
   * Always scoped to ONE channel: defaults to the currently selected one, but
   * callers can pass an explicit channel (e.g. right after a channel switch).
   */
  const handleCheckAndDownload = async (channelOverride?: 'stable' | 'beta') => {
    const channel: 'stable' | 'beta' = channelOverride ?? updateInfo.updateChannel;
    const id = ++checkIdRef.current;
    setPhase('checking');
    setOutcome(null);
    addDiagnosticLog({
      level: 'info',
      category: 'UPDATE',
      message: `Checking GitHub for updates (${channel} channel)…`,
    });

    // Use Tauri updater to check
    if (window.callerflash?.updater?.check) {
      const result = await window.callerflash.updater.check(channel);
      if (id !== checkIdRef.current) return; // Stale response — channel changed
      if (result?.upToDate) {
        // Clear any stale update state — we are on the latest version
        setOutcome({ kind: 'no-update', message: `You're running the latest version (${formatVersion(updateInfo.currentVersion)}).` });
        setUpdateInfo({ updateAvailable: false, latestVersion: '', lastChecked: new Date() });
        setDownloadUrl(null);
        setPhase('idle');
      } else if (result?.version) {
        setUpdateInfo({ latestVersion: result.version, updateAvailable: true, lastChecked: new Date() });
        setDownloadUrl(result.downloadUrl ?? null);
        addDiagnosticLog({
          level: 'info',
          category: 'UPDATE',
          message: `Update found: ${result.friendlyName || result.version}`,
        });
        setPhase('idle');
      } else if (result?.error) {
        setOutcome({ kind: 'verification-failed', message: result.error });
        setUpdateInfo({ updateAvailable: false, latestVersion: '' });
        setPhase('idle');
      }
      return;
    }

    // Web fallback — also scoped to the active channel only.
    try {
      const repoPath = updateInfo.githubRepo.replace(/^https?:\/\/github\.com\//, '');
      const latest = await fetchChannelLatest(repoPath, channel);
      if (id !== checkIdRef.current) return;
      if (
        latest &&
        versionMatchesChannel(latest.tag_name, channel) &&
        formatVersion(latest.tag_name) !== formatVersion(updateInfo.currentVersion)
      ) {
        setUpdateInfo({
          latestVersion: formatVersion(latest.tag_name),
          updateAvailable: true,
          releasePageUrl: latest.html_url,
        });
      } else {
        setOutcome({ kind: 'no-update', message: 'You are running the latest version.' });
        setUpdateInfo({ updateAvailable: false, latestVersion: '' });
      }
    } catch {
      if (id !== checkIdRef.current) return;
      setOutcome({ kind: 'verification-failed', message: 'Could not check for updates.' });
      setUpdateInfo({ updateAvailable: false, latestVersion: '' });
    }
    setPhase('idle');
  };

  // Auto-check on tab mount — ALWAYS run on first load regardless of
  // last-checked time, so the user sees updates immediately when they
  // open the app. After the first check, subsequent checks respect
  // the frequency interval (daily/weekly/monthly).
  const hasCheckedRef = useRef(false);
  useEffect(() => {
    if (phase !== 'idle') return;
    if (!shouldAutoCheck(updateInfo.lastChecked, updateInfo.updateCheckFrequency)) return;
    if (hasCheckedRef.current) {
      if (!shouldAutoCheck(updateInfo.lastChecked, updateInfo.updateCheckFrequency)) return;
    }
    hasCheckedRef.current = true;
    handleCheckAndDownload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateInfo.updateCheckFrequency]);

  // Changing the update channel must immediately re-check the NEWLY selected
  // channel only. This also invalidates any in-flight check from the previous
  // channel so stale results can never leak into the new channel's UI.
  const lastChannelRef = useRef(updateInfo.updateChannel);
  useEffect(() => {
    const prev = lastChannelRef.current;
    lastChannelRef.current = updateInfo.updateChannel;
    if (prev !== updateInfo.updateChannel) {
      checkIdRef.current++; // drop any stale in-flight result from the old channel
      handleCheckAndDownload(updateInfo.updateChannel);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateInfo.updateChannel]);

  /**
   * Sequential update: 1) ensure URL, 2) download (await result),
   * 3) install (await result). Every step logged to Diagnostics.
   */
  const handleUpdate = async () => {
    if (phase === 'downloading' || phase === 'installing') return;
    if (!updateInfo.latestVersion) return;

    addDiagnosticLog({ level: 'info', category: 'UPDATE', message: `Update ${formatVersion(updateInfo.latestVersion)}: starting…` });

    // ── 1. Ensure download URL ──────────────────────────────────────────
    let url = downloadUrl;
    if (!url && window.callerflash?.updater?.check) {
      addDiagnosticLog({ level: 'info', category: 'UPDATE', message: 'Fetching download URL…' });
      try {
        const result = await window.callerflash.updater.check(updateInfo.updateChannel);
        if (result?.downloadUrl) {
          url = result.downloadUrl;
          setDownloadUrl(result.downloadUrl);
        } else if (result?.error) {
          throw new Error(result.error);
        } else {
          throw new Error('No download URL returned');
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        addDiagnosticLog({ level: 'error', category: 'UPDATE', message: 'Failed to get download URL', details: msg });
        setOutcome({ kind: 'verification-failed', message: msg });
        return;
      }
    }

    if (!url) {
      addDiagnosticLog({ level: 'error', category: 'UPDATE', message: 'No download URL available.' });
      setOutcome({ kind: 'verification-failed', message: 'No download URL available. Try checking for updates first.' });
      return;
    }

    // ── 2. Download (await result) ──────────────────────────────────────
    addDiagnosticLog({ level: 'info', category: 'UPDATE', message: `Downloading ${formatVersion(updateInfo.latestVersion)}…` });
    setPhase('downloading');
    setUpdateInfo({ isDownloading: true, downloadProgress: 0 });

    if (!window.callerflash?.updater?.download) {
      addDiagnosticLog({ level: 'error', category: 'UPDATE', message: 'Download not available in this environment' });
      setPhase('idle');
      setUpdateInfo({ isDownloading: false });
      return;
    }

    let dlResult: { status?: string; error?: string } | null;
    try {
      const raw = await window.callerflash.updater.download(updateInfo.updateChannel, updateInfo.latestVersion, url);
      dlResult = raw as { status?: string; error?: string };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Download error';
      addDiagnosticLog({ level: 'error', category: 'UPDATE', message: 'Download threw an exception', details: msg });
      setPhase('idle');
      setUpdateInfo({ isDownloading: false, downloadProgress: 0 });
      setOutcome({ kind: 'verification-failed', message: msg });
      return;
    }

    if (!dlResult || dlResult.status === 'error') {
      const errMsg = dlResult?.error || 'Unknown download error';
      addDiagnosticLog({ level: 'error', category: 'UPDATE', message: 'Download failed', details: errMsg });
      setPhase('idle');
      setUpdateInfo({ isDownloading: false, downloadProgress: 0 });
      setOutcome({ kind: 'verification-failed', message: errMsg });
      return;
    }

    if (dlResult.status === 'busy') {
      addDiagnosticLog({ level: 'warning', category: 'UPDATE', message: 'Download already in progress' });
      return;
    }

    // Download succeeded
    addDiagnosticLog({ level: 'success', category: 'UPDATE', message: `Downloaded ${formatVersion(updateInfo.latestVersion)}` });
    setUpdateInfo({ isDownloading: false, downloadProgress: 100 });

    // ── 3. Install ──────────────────────────────────────────────────────
    addDiagnosticLog({ level: 'info', category: 'UPDATE', message: `Installing ${formatVersion(updateInfo.latestVersion)}…` });
    setPhase('installing');
    setUpdateInfo({ isInstalling: true });

    if (!window.callerflash?.updater?.install) {
      addDiagnosticLog({ level: 'error', category: 'UPDATE', message: 'Install not available in this environment' });
      setPhase('idle');
      setUpdateInfo({ isInstalling: false });
      return;
    }

    try {
      const installResult = await window.callerflash.updater.install(updateInfo.latestVersion);
      if (installResult?.status === 'error') {
        throw new Error(installResult.error || 'Install failed');
      }
      // installResult.status === 'installing' → app will quit shortly
      addDiagnosticLog({ level: 'info', category: 'UPDATE', message: 'Installer launched, app will restart…' });
    } catch (err: unknown) {
      addDiagnosticLog({ level: 'error', category: 'UPDATE', message: 'Install failed', details: err instanceof Error ? err.message : String(err) });
      setPhase('idle');
      setUpdateInfo({ isInstalling: false });
      const msg = err instanceof Error ? err.message : 'Install error';
      setOutcome({ kind: 'verification-failed', message: msg });
    }
  };

  const isBusy = phase === 'checking' || phase === 'downloading' || phase === 'installing';

  return (
    <div className="flex flex-col h-full gap-2 animate-fade-in">
      {/* Compact header — title left, Check right */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-win-text">Updates</h2>
          <p className="text-xs text-win-text-secondary mt-0.5">
            {formatVersion(updateInfo.currentVersion)} · <span className="capitalize">{updateInfo.updateChannel}</span> channel
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => handleCheckAndDownload()}
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
        <div className="flex items-start gap-3 px-3 py-2.5 rounded-xl bg-win-warning/10 border border-win-warning/30">
          <AlertTriangle className="w-4 h-4 text-win-warning flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-win-warning">Update failed</p>
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
                : phase === 'downloading' ? `Downloading ${Math.round(updateInfo.downloadProgress)}%…`
                : updateInfo.autoDownload ? 'Downloaded and ready to install.'
                : `Newer than your current ${formatVersion(updateInfo.currentVersion)}.`}
            </p>
          </div>
          <div className="flex-shrink-0">
            {phase === 'installing' ? (
              <button disabled className="flex items-center gap-2 px-4 py-2 bg-win-card text-win-text-secondary rounded-lg text-sm font-medium cursor-not-allowed opacity-70">
                <div className="w-4 h-4 border-2 border-win-text-secondary border-t-transparent rounded-full animate-spin" />
                Installing…
              </button>
            ) : (
              <button onClick={handleUpdate} disabled={isBusy} className="flex items-center gap-2 px-4 py-2 bg-win-accent hover:bg-win-accent-hover text-black rounded-lg text-sm font-semibold transition-colors disabled:opacity-50">
                <Download className="w-4 h-4" />
                {phase === 'downloading' ? 'Downloading…' : 'Update'}
              </button>
            )}
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

      {/* Settings + Release History — fill remaining vertical space */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 gap-2">
        <div className="bg-win-surface rounded-xl border border-win-border p-2.5 overflow-y-auto min-h-0">
          <h3 className="text-sm font-semibold text-win-text mb-1.5 flex items-center gap-2">
            <Shield className="w-4 h-4 text-win-accent" />
            Settings
          </h3>

          {/* Update Channel */}
          <div className="p-2 rounded-lg bg-win-card border border-win-border/50 mb-1.5">
            <p className="text-[11px] font-medium text-win-text-secondary mb-1">Update Channel</p>
            <div className="flex gap-1">
              {(['stable', 'beta'] as const).map((channelOpt) => (
                <button
                  key={channelOpt}
                  onClick={() => {
                    setUpdateInfo({ updateChannel: channelOpt, updateAvailable: false, latestVersion: '' });
                    setDownloadUrl(null);
                    setOutcome(null);
                  }}
                  className={`flex-1 px-1.5 py-1 rounded-lg text-xs font-medium transition-all ${
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
          <div className="p-2 rounded-lg bg-win-card border border-win-border/50 mb-1.5">
            <div className="flex items-center justify-between mb-1">
              <p className="text-[11px] font-medium text-win-text-secondary">Auto-check frequency</p>
              <p className="text-[10px] text-win-text-tertiary">
                Last: {formatRelativeLastCheck(updateInfo.lastChecked)}
              </p>
            </div>
            <div className="flex gap-1">
              {(['off', 'daily', 'weekly', 'monthly'] as const).map((freq) => (
                <button
                  key={freq}
                  onClick={() => setUpdateInfo({ updateCheckFrequency: freq })}
                  className={`flex-1 px-1.5 py-1 rounded-lg text-xs font-medium transition-all ${
                    updateInfo.updateCheckFrequency === freq
                      ? 'bg-win-accent/20 text-win-accent border border-win-accent/30'
                      : 'bg-win-surface text-win-text-secondary hover:bg-win-surface-hover border border-win-border'
                  }`}
                >
                  {freq === 'off' ? 'Off' : freq.charAt(0).toUpperCase() + freq.slice(1)}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-win-text-tertiary mt-1 leading-snug">
              {updateInfo.updateCheckFrequency === 'off'
                ? 'Auto-check disabled. Use the Check button to look manually.'
                : `Auto-checks on tab open if the last check is older than ${FREQUENCY_INTERVAL_DAYS[updateInfo.updateCheckFrequency]} day${FREQUENCY_INTERVAL_DAYS[updateInfo.updateCheckFrequency] === 1 ? '' : 's'}.`}
            </p>
          </div>

          {/* Auto-download toggle */}
          <div
            className="flex items-center justify-between p-2 rounded-lg bg-win-card border border-win-border/50 hover:border-win-border cursor-pointer transition-colors"
            onClick={() => setUpdateInfo({ autoDownload: !updateInfo.autoDownload })}
          >
            <div className="min-w-0 pr-2">
              <p className="text-sm font-medium text-win-text">Auto-download updates</p>
              <p className="text-[11px] text-win-text-tertiary leading-snug">
                {updateInfo.autoDownload
                  ? `Verified ${updateInfo.updateChannel} updates download in the background and install automatically when you click Update.`
                  : 'Updates are checked but not downloaded. Click Update to download and install.'}
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
        <div className="bg-win-surface rounded-xl border border-win-border p-2.5 flex flex-col min-h-0">
          <div className="flex items-center justify-between mb-1.5 flex-shrink-0">
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
            <div className="flex-1 min-h-0 divide-y divide-win-border/40 overflow-y-auto pr-1">
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
