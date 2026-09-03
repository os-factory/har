/** Repository and period filters of the Cost page (#339); pure so they can be unit-tested. */

interface UsageFilterRow {
  repositoryId: string;
  lastSeenAt: Date | string;
}

/** Period presets for the Cost page (#339). */
export const USAGE_PERIODS = [
  { id: 'all', label: 'All time', days: null },
  { id: '1d', label: 'Last 24 hours', days: 1 },
  { id: '7d', label: 'Last 7 days', days: 7 },
  { id: '30d', label: 'Last 30 days', days: 30 },
] as const;
export type UsagePeriodId = (typeof USAGE_PERIODS)[number]['id'];

export function filterUsageRows<T extends UsageFilterRow>(rows: T[], filters: { repositoryId: string | null; period: UsagePeriodId; now?: Date }): T[] {
  const days = USAGE_PERIODS.find((period) => period.id === filters.period)?.days ?? null;
  const since = days == null ? null : (filters.now ?? new Date()).getTime() - days * 86_400_000;
  return rows.filter((row) => {
    if (filters.repositoryId && row.repositoryId !== filters.repositoryId) return false;
    if (since != null && new Date(row.lastSeenAt).getTime() < since) return false;
    return true;
  });
}

