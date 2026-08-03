import { describe, expect, it } from 'vitest';
import { buildWorkUnitEvidenceRows, buildWorkUnitWorktreeRows } from './work-unit-evidence';

describe('buildWorkUnitEvidenceRows', () => {
  it('merges attempts, runs, and validations newest-first as table rows', () => {
    const rows = buildWorkUnitEvidenceRows({
      attempts: [
        {
          attemptId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          agentId: 2,
          branch: 'feat/x',
          sourceCreatedAt: new Date('2026-08-01T10:00:00.000Z'),
        },
      ],
      runs: [
        {
          id: 'run-1',
          stageId: 'verify',
          status: 'pass',
          durationMs: 1200,
          agentId: 2,
          startedAt: new Date('2026-08-01T11:00:00.000Z'),
        },
      ],
      validationBindings: [
        {
          bindingId: 'bind-1',
          validationId: 'val-1',
          treeHash: 'abc123',
          sourceCreatedAt: new Date('2026-08-01T12:00:00.000Z'),
        },
      ],
      validations: [{ validationId: 'val-1', status: 'pass', full: true }],
    });

    expect(rows.map((row) => row.kind)).toEqual(['validation', 'run', 'attempt']);
    expect(rows[0]).toMatchObject({
      title: 'Exact-tree validation',
      detail: 'abc123',
      state: 'verified',
    });
    expect(rows[1]).toMatchObject({
      title: 'verify',
      detail: 'pass · 1200ms',
      state: 'pass',
      agentId: 2,
    });
    expect(rows[2].title).toContain('Attempt aaaaaaaa');
  });
});

describe('buildWorkUnitWorktreeRows', () => {
  it('merges attempt and slot worktrees by path and prefers active slots', () => {
    const rows = buildWorkUnitWorktreeRows({
      repoId: 'repo-1',
      attempts: [
        {
          attemptId: 'att-1',
          agentId: 1,
          workDir: '/tmp/wt-a/control',
          worktreePath: '/tmp/wt-a',
          branch: 'branch-a',
          baseCommit: 'deadbeef',
          sourceCreatedAt: new Date('2026-08-01T10:00:00.000Z'),
        },
      ],
      slots: [
        {
          slotId: 1,
          active: true,
          workDir: '/tmp/wt-a/control',
          worktreePath: '/tmp/wt-a',
          branch: 'branch-a',
          baseCommit: 'deadbeef',
          attemptId: 'att-1',
          updatedAt: new Date('2026-08-01T12:00:00.000Z'),
        },
        {
          slotId: 3,
          active: false,
          workDir: null,
          worktreePath: '/tmp/wt-b',
          branch: 'branch-b',
          baseCommit: null,
          attemptId: null,
          updatedAt: new Date('2026-08-01T09:00:00.000Z'),
        },
      ],
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      worktreePath: '/tmp/wt-a',
      active: true,
      agentId: 1,
      attemptId: 'att-1',
    });
    expect(rows[1].worktreePath).toBe('/tmp/wt-b');
  });
});
