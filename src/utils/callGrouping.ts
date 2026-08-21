import type { CallRecord } from '../store/useAppStore';

export interface CallSection {
  key: string;
  label: string;
  calls: CallRecord[];
}

export function getDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getCallSectionLabel(key: string, now: Date = new Date(), locale?: string): string {
  if (key === getDayKey(now)) return 'Today';
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (key === getDayKey(yesterday)) return 'Yesterday';

  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const opts: Intl.DateTimeFormatOptions =
    y === now.getFullYear()
      ? { weekday: 'long', month: 'long', day: 'numeric' }
      : { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  return date.toLocaleDateString(locale, opts);
}

export function groupCallsBySection(
  calls: CallRecord[],
  now: Date = new Date(),
  locale?: string,
): CallSection[] {
  const byDay = new Map<string, CallRecord[]>();
  for (const call of calls) {
    const key = getDayKey(call.timestamp);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(call);
    else byDay.set(key, [call]);
  }
  return Array.from(byDay.entries()).map(([key, dayCalls]) => ({
    key,
    label: getCallSectionLabel(key, now, locale),
    calls: dayCalls,
  }));
}
