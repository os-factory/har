import { describe, expect, it } from 'vitest';
import { attentionItems } from './attention';
import type { WorktreeRow } from '@/components/columns/worktree-columns';

function row(overrides: Partial<WorktreeRow>): WorktreeRow {
  return {
    repoId: 'r1', repoPath: '/home/dev/app', syncedAt: new Date(), sessionCreatedAt: null,
    cleanupRecommendation: 'review', cleanupReason: '', slotId: 1, active: true, workDir: null,
    worktreePath: '/wt', branch: 'b', baseBranch: 'main', baseCommit: 'abc', previewUrls: null,
    harnessUsage: 'cli', lastRunAt: null, lastVerifyStatus: 'pass', lastBuildPass: null,
    detachedHead: false, dirty: false, ahead: 0, behind: 0, stale: false, onDisk: true,
    ...overrides,
  };
}

describe('attentionItems', () => {
  it('ignores idle slots', () => {
    expect(attentionItems([row({ active: false, lastVerifyStatus: 'fail', dirty: true })])).toEqual([]);
  });

  it('flags failed verify and missing paths as critical, ahead of warnings', () => {
    const items = attentionItems([
      row({ slotId: 2, dirty: true }),
      row({ slotId: 1, lastVerifyStatus: 'fail' }),
      row({ slotId: 3, onDisk: false, stale: true, behind: 4 }),
    ]);
    expect(items.map((i) => [i.slotId, i.kind])).toEqual([
      [1, 'verify_failed'],
      [3, 'missing'],
      [2, 'dirty'],
      [3, 'stale'],
    ]);
    expect(items[3].message).toBe('4 commits behind main');
  });

  it('turns the bypass hint into a plain sentence', () => {
    expect(attentionItems([row({ harnessUsage: 'bypass_warning' })])[0].message).toBe('No harness activity');
    const twoHours = new Date(Date.now() - 2 * 60 * 60 * 1000);
    expect(attentionItems([row({ harnessUsage: 'bypass_warning', lastRunAt: twoHours })])[0].message).toBe(
      'No harness activity since 2h',
    );
  });
});
