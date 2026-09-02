import { describe, expect, it } from 'vitest';
import { buildWorkUnitWorktreeRows } from './work-unit-evidence';

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
