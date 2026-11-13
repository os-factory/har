/**
 * Slot occupancy identity (#316), shared by Mission Control and the HAR CLI.
 *
 * A **slot number** is a workstation; a **working session** is one occupancy of
 * one worktree. Reusing slot 1 after `complete` / `teardown` mints a new
 * occupancy; `--resume` / `recover` keeps the same worktree and therefore the
 * same key. Session bindings (ADR 0003) carry this key so a binding never
 * outlives its occupancy.
 */

/** Separator that cannot appear in an attempt id, branch, or ISO timestamp. */
const PART_SEPARATOR = '::';

/**
 * The slot fields an occupancy key is derived from — a structural subset of
 * `AgentSlotStatus`, kept free of the zod schema so the pure attribution core
 * (`usage-attribution`) can use it.
 */
export interface OccupancySource {
  active: boolean;
  attemptId?: string | null;
  branch?: string | null;
  sessionCreatedAt?: string | Date | null;
  worktreePath?: string | null;
  workDir?: string | null;
}

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

  if (slot.attemptId) return occupancyKeyForAttempt(slot.attemptId);

  const createdAt = slot.sessionCreatedAt ? new Date(slot.sessionCreatedAt).toISOString() : null;
  if (slot.branch && createdAt) {
    return `branch${PART_SEPARATOR}${slot.branch}${PART_SEPARATOR}${createdAt}`;
  }

  const path = slot.worktreePath ?? slot.workDir;
  if (path && createdAt) return `path${PART_SEPARATOR}${path}${PART_SEPARATOR}${createdAt}`;
  if (path) return `path${PART_SEPARATOR}${path}`;

  return null;
}

/** Occupancy key of a work attempt — HAR mints one attempt per launch. */
export function occupancyKeyForAttempt(attemptId: string): string {
  return `attempt${PART_SEPARATOR}${attemptId}`;
}

/** Attempt id encoded in an occupancy key, or null for branch / path keys. */
export function attemptIdFromOccupancyKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const prefix = `attempt${PART_SEPARATOR}`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}
