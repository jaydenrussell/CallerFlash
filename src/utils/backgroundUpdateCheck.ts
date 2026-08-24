import { useAppStore, type DiagnosticLog } from '../store/useAppStore';
import { isUpdateCheckDue } from './updateSchedule';

/**
 * Background update check shared by the startup check and the periodic
 * scheduler. Uses the store directly (no hooks) so both call sites stay in
 * sync. Checks the user's SELECTED CHANNEL (stable|beta) rather than a
 * hardcoded one - otherwise beta opt-ins would silently get stable-only
 * checks on startup/schedule.
 *
 * Gating (frequency + lastChecked) lives HERE, not at call sites, so every
 * trigger path obeys the same policy: 'off' never checks; other frequencies
 * only check when due. The startup check counts as a check, so relaunching
 * twice in one day does not double-check.
 *
 * Error channel contract: the bridge RESOLVES failures as `{ error }` and
 * never rejects (tauri-bridge updater.check). Failed checks do NOT advance
 * lastChecked so the scheduler retries soon. The catch below only guards
 * against contract violations and maps them onto the same observable path.
 */
export async function backgroundUpdateCheck(trigger: 'startup' | 'scheduled'): Promise<void> {
  const check = window.callerflash?.updater?.check;
  if (!check) return;
  const log = (level: DiagnosticLog['level'], message: string) =>
    useAppStore.getState().addDiagnosticLog({ level, category: 'UPDATE', message });
  const { updateInfo } = useAppStore.getState();
  if (!isUpdateCheckDue(updateInfo.updateCheckFrequency, updateInfo.lastChecked ?? null, Date.now())) {
    return;
  }
  log('info', trigger === 'startup' ? 'Checking for updates on startup.' : 'Scheduled update check.');
  try {
    const result = await check(updateInfo.updateChannel);
    if (result?.version) {
      useAppStore.getState().setUpdateInfo({
        latestVersion: result.version,
        updateAvailable: true,
        lastChecked: new Date(),
      });
      log('info', `Update available: ${result.version}`);
    } else if (result?.upToDate) {
      useAppStore.getState().setUpdateInfo({ updateAvailable: false, lastChecked: new Date() });
      log('info', 'App is up to date.');
    } else if (result?.error) {
      log('warning', `Update check failed: ${result.error}`);
    }
  } catch (e) {
    // Contract violation - the bridge should resolve errors, not reject.
    log('warning', `Update check failed: ${e}`);
  }
}

