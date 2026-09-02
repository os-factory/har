export const WORK_UNIT_STATES = ['active', 'verified', 'failed', 'pending', 'completed', 'abandoned'] as const;
export type WorkUnitState = (typeof WORK_UNIT_STATES)[number];

/**
 * State is derived from execution evidence; only completion and abandonment are explicit.
 * Mirrors the rule the Factory home page used before the redesign.
 */
export function deriveWorkUnitState(input: {
  decision?: string | null;
  hasActiveSlot: boolean;
  hasFullProof: boolean;
  latestRunStatus?: string | null;
}): WorkUnitState {
  if (input.decision === 'completed' || input.decision === 'abandoned') return input.decision;
  if (input.hasActiveSlot) return 'active';
  if (input.hasFullProof) return 'verified';
  if (input.latestRunStatus === 'fail' || input.latestRunStatus === 'error') return 'failed';
  return 'pending';
}

export function formatDurationMs(ms: number): string {
  if (ms <= 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
