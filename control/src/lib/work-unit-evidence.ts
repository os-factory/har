export interface WorkUnitWorktreeRow {
  id: string;
  repoId: string;
  agentId: number;
  attemptId: string | null;
  worktreePath: string | null;
  workDir: string | null;
  branch: string | null;
  baseCommit: string | null;
  active: boolean;
  source: 'attempt' | 'slot';
  at: Date | null;
}

export function buildWorkUnitWorktreeRows(input: {
  repoId: string;
  attempts: Array<{
    attemptId: string;
    agentId: number;
    workDir: string | null;
    worktreePath: string | null;
    branch: string | null;
    baseCommit: string | null;
    sourceCreatedAt: Date;
  }>;
  slots: Array<{
    slotId: number;
    active: boolean;
    workDir: string | null;
    worktreePath: string | null;
    branch: string | null;
    baseCommit: string | null;
    attemptId: string | null;
    updatedAt: Date;
  }>;
}): WorkUnitWorktreeRow[] {
  const byKey = new Map<string, WorkUnitWorktreeRow>();

  for (const attempt of input.attempts) {
    const path = attempt.worktreePath ?? attempt.workDir;
    const key = path
      ? `path:${path}`
      : `attempt:${attempt.attemptId}`;
    byKey.set(key, {
      id: key,
      repoId: input.repoId,
      agentId: attempt.agentId,
      attemptId: attempt.attemptId,
      worktreePath: attempt.worktreePath,
      workDir: attempt.workDir,
      branch: attempt.branch,
      baseCommit: attempt.baseCommit,
      active: false,
      source: 'attempt',
      at: attempt.sourceCreatedAt,
    });
  }

  for (const slot of input.slots) {
    const path = slot.worktreePath ?? slot.workDir;
    const key = path ? `path:${path}` : `slot:${slot.slotId}`;
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, {
        ...existing,
        agentId: slot.slotId,
        attemptId: slot.attemptId ?? existing.attemptId,
        worktreePath: slot.worktreePath ?? existing.worktreePath,
        workDir: slot.workDir ?? existing.workDir,
        branch: slot.branch ?? existing.branch,
        baseCommit: slot.baseCommit ?? existing.baseCommit,
        active: slot.active,
        source: slot.active ? 'slot' : existing.source,
        at: slot.updatedAt,
      });
      continue;
    }
    byKey.set(key, {
      id: key,
      repoId: input.repoId,
      agentId: slot.slotId,
      attemptId: slot.attemptId,
      worktreePath: slot.worktreePath,
      workDir: slot.workDir,
      branch: slot.branch,
      baseCommit: slot.baseCommit,
      active: slot.active,
      source: 'slot',
      at: slot.updatedAt,
    });
  }

  return [...byKey.values()].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0);
  });
}
