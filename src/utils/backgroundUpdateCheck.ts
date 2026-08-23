import { useAppStore, type DiagnosticLog } from '../store/useAppStore';

/**
 * Background update check shared by the startup check and the periodic
 * scheduler. Uses the store directly (no hooks) so both call sites stay in
 * sync. Checks the user's SELECTED CHANNEL (stable|beta) rather than a
 * hardcoded one — otherwise beta opt-ins would silently get stable-only
 * checks on startup/schedule. Also persists lastChecked on the "up to date"
 * path — without that, the scheduler would re-fire on every tick.
 */
export async function backgroundUpdateCheck(trigger: 'startup' | 'scheduled'): Promise<void> {
  const check = window.callerflash?.updater?.check;
  if (!check) return;
  const log = (level: DiagnosticLog['level'], message: string) =>
    useAppStore.getState().addDiagnosticLog({ level, category: 'UPDATE', message });
  log('info', trigger === 'startup' ? 'Checking for updates on startup…' : 'Scheduled update check…');
  try {
    const channel = useAppStore.getState().updateInfo.updateChannel;
    const result = await check(channel);
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
    }
  } catch (e) {
    // Failed checks do NOT advance lastChecked so the scheduler retries soon.
    log('error', `Update check failed: ${e}`);
  }
}
