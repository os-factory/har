import { describe, expect, it } from 'vitest';
import { buildTimelineRows, describeSession, describeTimeline, formatDurationShort, pickDefaultSession, summarizeTimeline } from './slot-timeline';

const t = (iso: string) => new Date(iso);

describe('buildTimelineRows', () => {
  it('merges every event source newest-first with a shared row shape', () => {
    const rows = buildTimelineRows({
      occupancies: [
        {
          id: 'occ-1',
          agentId: 3,
          title: 'Session started in slot 3',
          at: t('2026-09-01T09:00:00Z'),
          branch: 'main-abc-har-agent-3',
          baseCommit: 'bb336915b50503f2f8586f092589f0c4ef2a1562',
          worktreePath: '/wt/main-abc',
          attemptId: 'att-1',
        },
      ],
      sessions: [
        {
          sessionKey: 'sess-1',
          agentTool: 'claude_code',
          agentId: 3,
          models: ['claude-fable-5-1'],
          tokensTotal: 12_500,
          costUsd: 0.42,
          sources: ['otel'],
          firstSeenAt: t('2026-09-01T09:05:00Z'),
          lastSeenAt: t('2026-09-01T09:35:00Z'),
          firstPrompt: 'Fix the flaky   test\nin CI',
        },
      ],
      runs: [
        {
          runId: 'run-1',
          stageId: 'verify',
          kind: 'verify',
          status: 'fail',
          trigger: 'cli',
          durationMs: 4200,
          agentId: 3,
          startedAt: t('2026-09-01T09:20:00Z'),
          stages: [
            { name: 'typecheck', pass: true, ms: 100 },
            { name: 'lint', pass: false, ms: 50 },
          ],
        },
      ],
      snapshots: [
        {
          validationId: 'val-1',
          treeHash: 'deadbeefcafebabe0123',
          branch: 'main-abc-har-agent-3',
          agentId: 3,
          status: 'pass',
          full: true,
          runId: 'run-2',
          changedFiles: [{ status: 'M', path: 'src/a.ts' }],
          commitSha: 'c0ffee1234567890',
          committedAt: t('2026-09-01T09:40:00Z'),
          createdAt: t('2026-09-01T09:30:00Z'),
        },
      ],
    });

    expect(rows.map((row) => row.kind)).toEqual(['commit', 'snapshot', 'run', 'session', 'occupancy']);

    const commit = rows[0];
    expect(commit.id).toBe('commit:c0ffee1234567890');
    expect(commit.title).toBe('Commit c0ffee1');
    expect(commit.status).toBe('Verified tree');

    const snapshot = rows[1];
    expect(snapshot.status).toBe('Verified');
    expect(snapshot.tone).toBe('pass');
    expect(snapshot.detail).toBe('1 changed file');

    const run = rows[2];
    expect(run.title).toBe('Verify');
    expect(run.status).toBe('Failed');
    expect(run.tone).toBe('fail');
    expect(run.detail).toBe('failed: lint');

    const session = rows[3];
    expect(session.title).toBe('Fix the flaky test in CI');
    expect(session.detail).toBe('claude-fable-5-1 · 12.5k tokens · $0.42');
    expect(session.session?.durationMs).toBe(30 * 60 * 1000);

    const occupancy = rows[4];
    expect(occupancy.detail).toBe('main-abc-har-agent-3 · from bb33691');
  });

  it('prefers a commit binding over the snapshot-derived commit row for the same sha', () => {
    const rows = buildTimelineRows({
      snapshots: [
        {
          validationId: 'val-1',
          treeHash: 'tree-1',
          branch: 'b',
          agentId: 1,
          status: 'pass',
          full: true,
          runId: null,
          changedFiles: [],
          commitSha: 'abc123456789',
          committedAt: null,
          createdAt: t('2026-09-01T09:30:00Z'),
        },
      ],
      commits: [
        {
          commitSha: 'abc123456789',
          treeHash: 'tree-1',
          message: 'feat: land it\n\nbody',
          refs: ['refs/heads/b'],
          branch: 'b',
          agentId: 1,
          at: t('2026-09-01T09:45:00Z'),
        },
      ],
    });
    const commits = rows.filter((row) => row.kind === 'commit');
    expect(commits).toHaveLength(1);
    expect(commits[0].title).toBe('feat: land it');
    expect(commits[0].detail).toBe('abc1234 · b');
  });

  it('labels bypassed and partial results as warnings', () => {
    const rows = buildTimelineRows({
      runs: [
        {
          runId: 'r', stageId: 'verify', kind: 'verify', status: 'bypass_warning', trigger: 'cli',
          durationMs: null, agentId: 1, startedAt: t('2026-09-01T09:00:00Z'), stages: [],
        },
      ],
      snapshots: [
        {
          validationId: 'v', treeHash: 'tree', branch: null, agentId: 1, status: 'pass', full: false,
          runId: null, changedFiles: [], commitSha: null, committedAt: null, createdAt: t('2026-09-01T08:00:00Z'),
        },
      ],
    });
    expect(rows[0]).toMatchObject({ kind: 'run', status: 'Bypassed', tone: 'warn', detail: 'cli' });
    expect(rows[1]).toMatchObject({ kind: 'snapshot', status: 'Partial verify', tone: 'warn' });
  });
});

describe('summarizeTimeline', () => {
  it('counts rows per kind and sums usage', () => {
    const rows = buildTimelineRows({
      sessions: [
        {
          sessionKey: 's1', agentTool: 'cursor', agentId: 1, models: [], tokensTotal: 1000, costUsd: 1.5,
          sources: [], firstSeenAt: t('2026-09-01T09:00:00Z'), lastSeenAt: t('2026-09-01T09:00:00Z'), firstPrompt: null,
        },
        {
          sessionKey: 's2', agentTool: 'codex', agentId: 1, models: [], tokensTotal: 500, costUsd: null,
          sources: [], firstSeenAt: t('2026-09-01T10:00:00Z'), lastSeenAt: t('2026-09-01T10:00:00Z'), firstPrompt: null,
        },
      ],
      runs: [
        { runId: 'a', stageId: 'verify', kind: 'verify', status: 'pass', trigger: 'cli', durationMs: 1, agentId: 1, startedAt: t('2026-09-01T09:10:00Z'), stages: [] },
        { runId: 'b', stageId: 'verify', kind: 'verify', status: 'fail', trigger: 'cli', durationMs: 1, agentId: 1, startedAt: t('2026-09-01T09:20:00Z'), stages: [] },
      ],
    });
    const totals = summarizeTimeline(rows);
    expect(totals).toEqual({
      sessions: 2, runs: 2, verifyPassed: 1, snapshots: 0, commits: 0, tokensTotal: 1500, costUsd: 1.5,
    });
    expect(describeTimeline(totals)).toBe('2 agent sessions · 2 runs (1 passed) · 0 snapshots · 0 commits · 1.5k tokens · $1.50');
  });
});

describe('pickDefaultSession / describeSession (#339)', () => {
  const session = (key: string, at: string, tokens: number, sources: string[] = []) => ({
    sessionKey: key, agentTool: 'cursor', agentId: 1, models: ['gpt-5'], tokensTotal: tokens, costUsd: tokens ? 0.004 : null,
    costSource: tokens ? 'estimated' : null, sources, firstSeenAt: t(at), lastSeenAt: t(at.replace('T10', 'T11')), firstPrompt: null,
  });

  it('prefers the newest session that has content over a metadata-only stub', () => {
    const rows = buildTimelineRows({
      sessions: [session('stub', '2026-09-03T10:00:00Z', 0), session('real', '2026-09-02T10:00:00Z', 900), session('older', '2026-09-01T10:00:00Z', 5)],
    });
    expect(pickDefaultSession(rows)?.session?.sessionKey).toBe('real');
    const trajectoryOnly = buildTimelineRows({ sessions: [session('stub', '2026-09-03T10:00:00Z', 0), session('traj', '2026-09-02T10:00:00Z', 0, ['trajectory'])] });
    expect(pickDefaultSession(trajectoryOnly)?.session?.sessionKey).toBe('traj');
    expect(pickDefaultSession(buildTimelineRows({ sessions: [session('only', '2026-09-03T10:00:00Z', 0)] }))?.session?.sessionKey).toBe('only');
    expect(pickDefaultSession([])).toBeUndefined();
  });

  it('labels a session with model, duration, tokens and cost provenance', () => {
    const [row] = buildTimelineRows({ sessions: [session('real', '2026-09-02T10:00:00Z', 900)] });
    expect(describeSession(row)).toBe('gpt-5 · 1h · 900 tokens · $0.0040 est.');
  });

  it('formats durations without raw milliseconds', () => {
    expect(formatDurationShort(400)).toBe('<1s');
    expect(formatDurationShort(42_000)).toBe('42s');
    expect(formatDurationShort(125_000)).toBe('2m 5s');
    expect(formatDurationShort(3_600_000)).toBe('1h');
  });
});
