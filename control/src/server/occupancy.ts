import type { AgentSlotStatus } from '@har/schemas';

/**
 * Slot occupancy identity (#316).
 *
 * A **slot number** is a workstation; a **working session** is one occupancy of
 * one worktree. Reusing slot 1 after `complete` / `teardown` must mint a new
 * occupancy — not continue the previous one. Everything derived from a session
 * (purpose, trajectory streams, usage rows) is scoped to the occupancy, never
 * to the bare slot id.
 *
 * `--resume` / `recover` keeps the same worktree and therefore the same key.
 */

/** Separator that cannot appear in an attempt id, branch, or ISO timestamp. */
const PART_SEPARATOR = '::';

export type OccupancySource = Pick<
  AgentSlotStatus,
  'active' | 'attemptId' | 'branch' | 'sessionCreatedAt' | 'worktreePath' | 'workDir'
>;

/**
 * Stable key for one occupancy, or null when the slot is idle.
 *
 * Prefers `attemptId` — HAR mints one per launch, so it is the truest
 * occupancy identity. Falls back to branch + session creation time, then to the
 * worktree path, which still changes between occupancies because HAR encodes a
 * random per-session suffix in it.
 */
export function deriveOccupancyKey(slot: OccupancySource): string | null {
  if (!slot.active) return null;

  if (slot.attemptId) return `attempt${PART_SEPARATOR}${slot.attemptId}`;

  const createdAt = slot.sessionCreatedAt ? new Date(slot.sessionCreatedAt).toISOString() : null;
  if (slot.branch && createdAt) {
    return `branch${PART_SEPARATOR}${slot.branch}${PART_SEPARATOR}${createdAt}`;
  }

  const path = slot.worktreePath ?? slot.workDir;
  if (path && createdAt) return `path${PART_SEPARATOR}${path}${PART_SEPARATOR}${createdAt}`;
  if (path) return `path${PART_SEPARATOR}${path}`;

  return null;
}

/**
 * Whether a sync moved the slot to a different occupancy.
 *
 * Idle → active, active → different worktree, and active → idle all count.
 * Occupancy-derived state (purpose above all) must be cleared when this is
 * true, or slot N's page keeps describing the task the previous agent did.
 */
export function isNewOccupancy(
  previousKey: string | null | undefined,
  nextKey: string | null,
): boolean {
  return (previousKey ?? null) !== nextKey;
}
