import { describe, expect, it } from 'vitest';
import { matchingCommit } from './handoff';
import { buildTimelineRows } from './slot-timeline';

const t = (iso: string) => new Date(iso);

describe('matchingCommit (#340)', () => {
  it('prefers the newest verified-tree commit', () => {
    const timeline = buildTimelineRows({
      snapshots: [
        {
          validationId: 'v1',
          treeHash: 'tree-1',
          branch: 'feature',
          agentId: 1,
          status: 'pass',
          full: true,
          runId: null,
          changedFiles: [],
          commitSha: 'aaaaaaaaaaaaaaaa',
          committedAt: t('2026-09-01T10:00:00Z'),
          createdAt: t('2026-09-01T10:00:00Z'),
        },
      ],
      commits: [
        {
          commitSha: 'bbbbbbbbbbbbbbbb',
          treeHash: 'tree-2',
          message: 'wip',
          refs: [],
          branch: 'feature',
          agentId: 1,
          at: t('2026-09-01T09:00:00Z'),
        },
      ],
    });
    expect(matchingCommit(timeline)).toEqual({ sha: 'aaaaaaaaaaaaaaaa', branch: 'feature' });
  });

  it('falls back to the newest commit when none is verified', () => {
    const timeline = buildTimelineRows({
      snapshots: [
        {
          validationId: 'v1',
          treeHash: 'tree-1',
          branch: 'wip',
          agentId: 1,
          status: 'fail',
          full: true,
          runId: null,
          changedFiles: [],
          commitSha: 'cccccccccccccccc',
          committedAt: t('2026-09-01T10:00:00Z'),
          createdAt: t('2026-09-01T10:00:00Z'),
        },
      ],
    });
    expect(matchingCommit(timeline)).toEqual({ sha: 'cccccccccccccccc', branch: 'wip' });
  });

  it('returns null when the attempt has no commit', () => {
    expect(matchingCommit([])).toBeNull();
  });
});
