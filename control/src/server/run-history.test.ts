import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Verify runs read from both data models: 1.x `Run` rows of a migrated
 * database still display, and a 2.0 factory run reads as a verify run.
 */

const at = (iso: string) => new Date(iso);
const db = vi.hoisted(() => ({
  runs: [] as Array<Record<string, unknown>>,
  factoryRuns: [] as Array<Record<string, unknown>>,
  stages: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    run: { findMany: async ({ where }: { where: { stageId?: { in: string[] } } }) =>
      db.runs.filter((run) => !where.stageId || where.stageId.in.includes(run.stageId as string)) },
    factoryRun: { findMany: async () => db.factoryRuns },
    stageResult: { findMany: async () => db.stages },
  },
}));

import { latestStageRuns, listRuns, runStatusOf } from './run-history';

function factoryRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fr-row',
    factoryRunId: 'fr-1',
    repositoryId: 'repo-1',
    attemptId: 'att-1',
    workUnitId: 'wu-1',
    agentId: 2,
    workDir: '/wt/slot-2',
    occupancyKey: 'attempt::att-1',
    verdict: 'pass',
    status: 'pass',
    full: true,
    runId: null,
    stageIds: ['typecheck', 'unit-tests'],
    startedAt: at('2026-11-26T10:00:00Z'),
    finishedAt: at('2026-11-26T10:00:42Z'),
    createdAt: at('2026-11-26T10:00:42Z'),
    ...overrides,
  };
}

beforeEach(() => {
  db.runs = [];
  db.factoryRuns = [];
  db.stages = [];
});

describe('listRuns', () => {
  it('reads a v2 factory run as a verify run with its stages, next to 1.x runs, newest first', async () => {
    db.runs = [{ runId: 'legacy-1', stageId: 'verify', status: 'fail', startedAt: at('2026-11-20T10:00:00Z'), result: null }];
    db.factoryRuns = [factoryRun()];
    db.stages = [
      { factoryRunId: 'fr-1', stageId: 'unit-tests', status: 'failed', durationMs: 900 },
      { factoryRunId: 'fr-1', stageId: 'typecheck', status: 'passed', durationMs: 300 },
    ];

    const runs = await listRuns({ repositoryIds: ['repo-1'], stageIds: ['verify'], take: 10 });

    expect(runs.map((run) => run.runId)).toEqual(['fr-1', 'legacy-1']);
    expect(runs[0]).toMatchObject({
      stageId: 'verify',
      status: 'pass',
      agentId: 2,
      workDir: '/wt/slot-2',
      occupancyKey: 'attempt::att-1',
      durationMs: 42_000,
      result: { data: { verification: { stages: [{ name: 'typecheck', pass: true, ms: 300 }, { name: 'unit-tests', pass: false, ms: 900 }] } } },
    });
  });

  it('does not repeat a factory run converted from a 1.x run', async () => {
    db.runs = [{ runId: 'verify-1', stageId: 'verify', status: 'pass', startedAt: at('2026-11-20T10:00:00Z') }];
    db.factoryRuns = [factoryRun({ runId: 'verify-1' })];
    expect((await listRuns({ repositoryIds: ['repo-1'], take: 10 })).map((run) => run.runId)).toEqual(['verify-1']);
  });

  it('contributes no v2 run to a non-verify stage', async () => {
    db.factoryRuns = [factoryRun()];
    expect(await listRuns({ repositoryIds: ['repo-1'], stageIds: ['launch'], take: 10 })).toEqual([]);
  });
});

describe('runStatusOf', () => {
  it('maps verdicts and quick-verify pipeline results', () => {
    expect(runStatusOf({ verdict: 'pass', status: null })).toBe('pass');
    expect(runStatusOf({ verdict: null, status: 'success' })).toBe('pass');
    expect(runStatusOf({ verdict: null, status: 'failure' })).toBe('fail');
    expect(runStatusOf({ verdict: null, status: null })).toBe('unknown');
  });
});

describe('latestStageRuns', () => {
  it('takes the newer of a 1.x stage run and a v2 stage result', async () => {
    db.runs = [{ stageId: 'line-gate', status: 'fail', startedAt: at('2026-11-20T10:00:00Z'), durationMs: 5, agentId: 1 }];
    db.factoryRuns = [factoryRun()];
    db.stages = [{ factoryRunId: 'fr-1', stageId: 'line-gate', status: 'passed', durationMs: 7, startTime: null }];

    const latest = await latestStageRuns('repo-1', ['line-gate']);

    expect(latest.get('line-gate')).toEqual({ status: 'pass', startedAt: at('2026-11-26T10:00:00Z'), durationMs: 7, agentId: 2 });
  });
});
