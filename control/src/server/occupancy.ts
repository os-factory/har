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

export type ExistingSlotOccupancy = {
  active: boolean;
  workDir: string | null;
  worktreePath: string | null;
};

/**
 * Whether this slot payload should replace the stored occupancy (#256).
 *
 * One AgentSlot row per `(repository, slotId)` means N external workspaces
 * that each launched "slot 1" collapse onto the same row. An idle report from
 * a *different* occupancy (typical: the main checkout, which never launched
 * that number) must not null the live worktree / verify columns. Idle from
 * the same occupancy — or a path-less idle after the CLI has already merged
 * sources — still applies so teardown can free the row.
 */
export function shouldApplySlotSync(
  existing: ExistingSlotOccupancy | null | undefined,
  incoming: Pick<AgentSlotStatus, 'active' | 'workDir' | 'worktreePath'>,
): boolean {
  if (!existing) return true;
  if (incoming.active) return true;
  if (!existing.active) return true;

  const existingPath = existing.workDir ?? existing.worktreePath;
  const incomingPath = incoming.workDir ?? incoming.worktreePath;
  if (existingPath && incomingPath && existingPath !== incomingPath) return false;
  return true;
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

export interface RecordOccupancyInput {
  attemptId?: string | null;
  agentId?: number | null;
  workDir?: string | null;
  /** When the record was produced. */
  at: Date;
}

export interface OccupancyCandidate {
  slotId: number;
  workDir: string | null;
  sessionCreatedAt: Date | null;
  occupancyKey: string | null;
}

/**
 * Occupancy key for a run or snapshot record (#348).
 *
 * A record bound to an attempt is exact. Otherwise it belongs to the occupancy of the
 * slot it ran in when it was produced: same work dir, started at or after the session
 * began. `candidates` are the slot rows of the repository as known at sync time.
 */
export function resolveRecordOccupancyKey(
  record: RecordOccupancyInput,
  candidates: OccupancyCandidate[],
): string | null {
  if (record.attemptId) return occupancyKeyForAttempt(record.attemptId);
  if (record.agentId == null) return null;
  const slot = candidates.find((candidate) => candidate.slotId === record.agentId);
  if (!slot?.occupancyKey) return null;
  if (slot.workDir && record.workDir && slot.workDir !== record.workDir) return null;
  if (slot.sessionCreatedAt && record.at < slot.sessionCreatedAt) return null;
  return slot.occupancyKey;
}
