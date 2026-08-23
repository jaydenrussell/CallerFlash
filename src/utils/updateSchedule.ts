export type UpdateCheckFrequency = 'off' | 'daily' | 'weekly' | 'monthly';

/**
 * How often each frequency option triggers a background update check.
 * Returns null for 'off' (never schedule).
 */
export function updateCheckIntervalMs(frequency: UpdateCheckFrequency): number | null {
  switch (frequency) {
    case 'daily':
      return 24 * 60 * 60 * 1000;
    case 'weekly':
      return 7 * 24 * 60 * 60 * 1000;
    case 'monthly':
      return 30 * 24 * 60 * 60 * 1000;
    default:
      return null;
  }
}

/**
 * The same interval expressed in whole days, for UI copy.
 * Returns null for 'off' (never schedule).
 */
export function updateCheckIntervalDays(frequency: UpdateCheckFrequency): number | null {
  const ms = updateCheckIntervalMs(frequency);
  return ms === null ? null : Math.round(ms / 86_400_000);
}

/**
 * How often the scheduler wakes up to evaluate whether a check is due.
 * Deliberately much shorter than the smallest check interval — the app may
 * sleep/hibernate between ticks, so we re-evaluate frequently and rely on
 * the elapsed-time comparison to avoid redundant network calls.
 */
export const UPDATE_SCHEDULER_TICK_MS = 15 * 60 * 1000;

/**
 * True when a background update check should run now, given the user's
 * chosen frequency and the time of the last completed check (the startup
 * check counts as one).
 */
export function isUpdateCheckDue(
  frequency: UpdateCheckFrequency,
  lastChecked: Date | null | undefined,
  now: number,
): boolean {
  const interval = updateCheckIntervalMs(frequency);
  if (interval === null) return false;
  if (!lastChecked) return true;
  const elapsed = now - lastChecked.getTime();
  // An unparseable timestamp must not block future checks forever.
  if (!Number.isFinite(elapsed)) return true;
  return elapsed >= interval;
}
