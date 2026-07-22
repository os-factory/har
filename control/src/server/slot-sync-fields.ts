import type { AgentSlotStatus } from '@har/schemas';

/**
 * Prisma update payload for one agent slot sync.
 *
 * Optional JSON fields omitted from the harness status payload arrive as
 * `undefined`. Prisma treats `undefined` as "leave the column unchanged", which
 * left ghost worktree paths / drift after teardown (#68). Idle slots must
 * explicitly null live-session columns; last `branch` is kept for history when
 * the payload omits it.
 */
export type AgentSlotSyncFields = {
  active: boolean;
  workDir: string | null;
  worktreePath: string | null;
  branch?: string | null;
  previewUrls: Record<string, string> | null;
  harnessUsage: AgentSlotStatus['harnessUsage'];
  lastRunId: string | null;
  lastRunAt: Date | null;
  lastVerifyStatus: string | null;
  lastBuildPass: boolean | null;
  mode: string | null;
  suffix: string | null;
  baseBranch: string | null;
  baseCommit: string | null;
  sessionCreatedAt: Date | null;
  purpose: string | null;
  detachedHead: boolean | null;
  dirty: boolean | null;
  ahead: number | null;
  behind: number | null;
  stale: boolean | null;
};

export function buildAgentSlotSyncFields(parsed: AgentSlotStatus): AgentSlotSyncFields {
  const active = parsed.active;

  const fields: AgentSlotSyncFields = {
    active,
    workDir: active ? parsed.workDir ?? null : null,
    worktreePath: active ? parsed.worktreePath ?? null : null,
    previewUrls: active ? parsed.previewUrls ?? null : null,
    harnessUsage: parsed.harnessUsage,
    lastRunId: parsed.lastRunId ?? null,
    lastRunAt: parsed.lastRunAt ? new Date(parsed.lastRunAt) : null,
    lastVerifyStatus: parsed.lastVerifyStatus ?? null,
    lastBuildPass: parsed.lastBuildPass ?? null,
    mode: parsed.mode ?? null,
    suffix: parsed.suffix ?? null,
    baseBranch: parsed.baseBranch ?? null,
    baseCommit: parsed.baseCommit ?? null,
    sessionCreatedAt: parsed.sessionCreatedAt ? new Date(parsed.sessionCreatedAt) : null,
    purpose: parsed.purpose ?? null,
    detachedHead: active ? parsed.detachedHead ?? null : null,
    dirty: active ? parsed.dirty ?? null : null,
    ahead: active ? parsed.ahead ?? null : null,
    behind: active ? parsed.behind ?? null : null,
    stale: active ? parsed.stale ?? null : null,
  };

  if (parsed.branch !== undefined) {
    fields.branch = parsed.branch;
  } else if (active) {
    fields.branch = null;
  }
  // Idle + omitted branch: leave previous value (last session branch).

  return fields;
}
