import type { CallRecord } from '../store/useAppStore';

export type CallSectionKey = 'today' | 'yesterday' | 'last7' | 'last30' | 'older';

export interface CallSection {
  key: CallSectionKey;
  label: string;
  calls: CallRecord[];
}

const SECTION_ORDER: CallSectionKey[] = ['today', 'yesterday', 'last7', 'last30', 'older'];

export function getCallSection(timestamp: Date, now: Date = new Date()): CallSectionKey {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayDiff = Math.floor((startOfDay(now).getTime() - startOfDay(timestamp).getTime()) / 86_400_000);

  if (dayDiff <= 0) return 'today';
  if (dayDiff === 1) return 'yesterday';
  if (dayDiff <= 7) return 'last7';
  if (dayDiff <= 30) return 'last30';
  return 'older';
}

export function getCallSectionLabel(key: CallSectionKey): string {
  switch (key) {
    case 'today':
      return 'Today';
    case 'yesterday':
      return 'Yesterday';
    case 'last7':
      return 'Last 7 days';
    case 'last30':
      return 'Last 30 days';
    case 'older':
      return 'Older';
  }
}

export function groupCallsBySection(calls: CallRecord[], now: Date = new Date()): CallSection[] {
  const sections = new Map<CallSectionKey, CallRecord[]>();
  for (const key of SECTION_ORDER) sections.set(key, []);

  for (const call of calls) {
    sections.get(getCallSection(call.timestamp, now))?.push(call);
  }

  return SECTION_ORDER.filter((key) => (sections.get(key)?.length ?? 0) > 0).map((key) => ({
    key,
    label: getCallSectionLabel(key),
    calls: sections.get(key) ?? [],
  }));
}
