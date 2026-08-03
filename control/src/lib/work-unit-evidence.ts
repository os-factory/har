export type WorkUnitEvidenceKind = 'attempt' | 'run' | 'validation';

export interface WorkUnitEvidenceRow {
  id: string;
  kind: WorkUnitEvidenceKind;
  at: Date;
  title: string;
  detail: string;
  state: string;
  agentId: number | null;
}

export interface WorkUnitEvidenceInput {
  attempts: Array<{
    attemptId: string;
    agentId: number;
    branch: string | null;
    sourceCreatedAt: Date;
  }>;
  runs: Array<{
    id: string;
    stageId: string;
    status: string;
    durationMs: number | null;
    agentId: number | null;
    startedAt: Date;
  }>;
  validationBindings: Array<{
    bindingId: string;
    validationId: string;
    treeHash: string;
    sourceCreatedAt: Date;
  }>;
  validations: Array<{
    validationId: string;
    status: string;
    full: boolean;
  }>;
}

export function buildWorkUnitEvidenceRows(input: WorkUnitEvidenceInput): WorkUnitEvidenceRow[] {
  const rows: WorkUnitEvidenceRow[] = [
    ...input.attempts.map((attempt) => ({
      id: `attempt:${attempt.attemptId}`,
      kind: 'attempt' as const,
      at: attempt.sourceCreatedAt,
      title: `Attempt ${attempt.attemptId.slice(0, 8)}`,
      detail: `slot ${attempt.agentId}${attempt.branch ? ` · ${attempt.branch}` : ''}`,
      state: 'attempt',
      agentId: attempt.agentId,
    })),
    ...input.runs.map((run) => ({
      id: `run:${run.id}`,
      kind: 'run' as const,
      at: run.startedAt,
      title: run.stageId,
      detail: `${run.status}${run.durationMs != null ? ` · ${run.durationMs}ms` : ''}`,
      state: run.status,
      agentId: run.agentId,
    })),
    ...input.validationBindings.map((binding) => {
      const validation = input.validations.find(
        (candidate) => candidate.validationId === binding.validationId,
      );
      const state =
        validation?.status === 'pass' && validation.full
          ? 'verified'
          : (validation?.status ?? 'validation');
      return {
        id: `validation:${binding.bindingId}`,
        kind: 'validation' as const,
        at: binding.sourceCreatedAt,
        title: 'Exact-tree validation',
        detail: binding.treeHash,
        state,
        agentId: null,
      };
    }),
  ];

  return rows.sort((a, b) => b.at.getTime() - a.at.getTime());
}

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
