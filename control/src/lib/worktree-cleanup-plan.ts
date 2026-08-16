export type WorktreeCleanupRecommendation = 'teardown' | 'clear_missing' | 'review' | 'keep';

export interface WorktreeCleanupAssessment {
  recommendation: WorktreeCleanupRecommendation;
  reason: string;
  ageDays?: number;
}

const DEFAULT_STALE_DAYS = 7;

function ageDaysFrom(date: Date | null | undefined): number | undefined {
  if (!date) return undefined;
  return Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000));
}

export function classifyWorktreeCleanup(
  row: {
    active: boolean;
    dirty: boolean | null;
    sessionCreatedAt: Date | null;
    onDisk?: boolean;
  },
  options?: { staleDays?: number },
): WorktreeCleanupAssessment {
  const staleDays = options?.staleDays ?? DEFAULT_STALE_DAYS;
  const ageDays = ageDaysFrom(row.sessionCreatedAt);

  if (row.onDisk === false) {
    return {
      recommendation: 'clear_missing',
      reason: 'Path missing on disk — clear dashboard row or run har env teardown on the host',
      ageDays,
    };
  }

  if (row.dirty) {
    return {
      recommendation: 'review',
      reason: 'Uncommitted changes — review before cleanup',
      ageDays,
    };
  }

  if (ageDays !== undefined && ageDays >= staleDays) {
    return {
      recommendation: 'teardown',
      reason: `Idle ${ageDays}d and clean — safe to tear down`,
      ageDays,
    };
  }

  if (row.active) {
    return {
      recommendation: 'review',
      reason:
        ageDays !== undefined
          ? `Active session (${ageDays}d) — keep unless finished`
          : 'Active session — keep unless finished',
      ageDays,
    };
  }

  return {
    recommendation: 'review',
    reason: 'Idle session — confirm before deleting',
    ageDays,
  };
}

export function isAutoCleanupRecommendation(
  recommendation: WorktreeCleanupRecommendation,
): boolean {
  return recommendation === 'teardown' || recommendation === 'clear_missing';
}
