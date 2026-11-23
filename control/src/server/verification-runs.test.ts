import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Verification traces (`har env verify`) are stored as verification runs with
 * their stages, attributed by the Resource checkout path, else by the
 * repository URL; they never reach the agent-session path.
 */

const MAIN = '/home/dev/acme/app';
const OTHER = '/home/dev/other';
const TRACE = 'd3209ae49e3ad07b6bb0ba4414331613';
const RUN_SPAN = '1111111111111111';

type Row = Record<string, unknown> & { id: string };

const state = vi.hoisted(() => ({
  repos: [] as Array<{ id: string; path: string; gitRemote: string | null }>,
  runs: [] as Row[],
  stages: [] as Row[],
  attempts: [] as Array<{ attemptId: string; repositoryId: string }>,
  sessionLookups: 0,
}));

function upsertInto(rows: Row[], prefix: string) {
  return async ({ where, create, update }: { where: { traceId_spanId: { traceId: string; spanId: string } }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
    const key = where.traceId_spanId;
    const existing = rows.find((row) => row.traceId === key.traceId && row.spanId === key.spanId);
    if (existing) {
      Object.assign(existing, update);
      return existing;
    }
    const row = { id: `${prefix}-${rows.length + 1}`, createdAt: new Date('2026-11-23T10:00:05Z'), ...create } as Row;
    rows.push(row);
    return row;
  };
}

vi.mock('@/lib/db', () => ({
  prisma: {
    repository: {
      findMany: async () => state.repos,
      findUnique: async () => null,
    },
    agentSlot: {
      findMany: async () => {
        state.sessionLookups += 1;
        return [];
      },
    },
    workAttempt: {
      findFirst: async ({ where }: { where: { attemptId: string; repositoryId: { in: string[] } } }) =>
        state.attempts.find((a) => a.attemptId === where.attemptId && where.repositoryId.in.includes(a.repositoryId)) ?? null,
      findMany: async () => [],
    },
    verificationRun: {
      upsert: (args: never) => upsertInto(state.runs, 'vr')(args),
      findUnique: async ({ where }: { where: { traceId_spanId: { traceId: string; spanId: string } } }) =>
        state.runs.find((row) => row.traceId === where.traceId_spanId.traceId && row.spanId === where.traceId_spanId.spanId) ??
        null,
    },
    verificationStage: {
      upsert: (args: never) => upsertInto(state.stages, 'vs')(args),
    },
  },
}));

vi.mock('@/server/git-worktrees', () => ({
  WORKTREE_MISS_REFRESH_MS: 0,
  listLinkedWorktrees: () => ({ worktrees: [] }),
}));

import { ingestOtelTracesJson } from '@/server/otel-ingest';
import { repositoryUrlKey, verificationRunJson } from '@/server/verification-runs';

function str(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

function nanos(iso: string): string {
  return `${BigInt(Date.parse(iso)) * 1_000_000n}`;
}

/** The shape `buildVerificationTrace` (src/core/verification-spans.ts) produces. */
function verificationPayload(resource: Array<ReturnType<typeof str>>, options: { stagesOnly?: boolean } = {}) {
  const run = {
    traceId: TRACE,
    spanId: RUN_SPAN,
    name: 'har verify --full',
    kind: 2,
    startTimeUnixNano: nanos('2026-11-23T10:00:00Z'),
    endTimeUnixNano: nanos('2026-11-23T10:00:03Z'),
    attributes: [
      str('cicd.pipeline.name', 'har verify --full'),
      str('cicd.pipeline.run.id', 'validation-1'),
      str('cicd.pipeline.result', 'failure'),
      str('factory.run.id', 'validation-1'),
      str('factory.git.tree', 'a'.repeat(40)),
      str('factory.verdict', 'fail'),
      str('vcs.ref.head.revision', 'b'.repeat(40)),
      str('factory.attestation.digest', 'sha256:' + 'c'.repeat(64)),
    ],
  };
  const stage = (name: string, spanId: string, result: string, start: string, end: string, type?: string) => ({
    traceId: TRACE,
    spanId,
    parentSpanId: RUN_SPAN,
    name,
    kind: 1,
    startTimeUnixNano: nanos(start),
    endTimeUnixNano: nanos(end),
    attributes: [
      str('cicd.pipeline.task.name', name),
      str('cicd.pipeline.task.run.id', `validation-1:${name}`),
      str('cicd.pipeline.task.run.result', result),
      ...(type ? [str('cicd.pipeline.task.type', type)] : []),
      str('factory.stage.added_by', 'policy'),
    ],
  });
  return {
    resourceSpans: [
      {
        resource: { attributes: [str('service.name', 'har'), ...resource] },
        scopeSpans: [
          {
            scope: { name: '@osfactory/har', version: '2.0.0' },
            spans: [
              ...(options.stagesOnly ? [] : [run]),
              stage('build', '2222222222222222', 'success', '2026-11-23T10:00:00Z', '2026-11-23T10:00:01Z', 'build'),
              stage('unit-tests', '3333333333333333', 'failure', '2026-11-23T10:00:01Z', '2026-11-23T10:00:03Z', 'test'),
            ],
          },
        ],
      },
    ],
  };
}

const correlation = [
  str('factory.work_unit.id', 'FE-42'),
  str('factory.attempt.id', 'attempt-1'),
  str('vcs.repository.url.full', 'https://github.com/acme/app.git'),
  str('vcs.ref.head.name', 'feat/x-har-agent-2'),
  str('factory.producer.version', '2.0.0'),
];

beforeEach(() => {
  state.repos = [
    { id: 'repo-app', path: MAIN, gitRemote: 'git@github.com:acme/app.git' },
    { id: 'repo-other', path: OTHER, gitRemote: 'https://github.com/acme/other' },
  ];
  state.runs = [];
  state.stages = [];
  state.attempts = [];
  state.sessionLookups = 0;
});

describe('verification trace ingest', () => {
  it('stores the run and its stages, attributed by the checkout path', async () => {
    const result = await ingestOtelTracesJson(
      verificationPayload([...correlation, str('factory.local.checkout_path', `${MAIN}/control`)]),
    );
    expect(result).toEqual({ accepted: 3, dropped: 0, reasons: [] });
    expect(state.sessionLookups).toBe(0);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({
      repositoryId: 'repo-app',
      runId: 'validation-1',
      traceId: TRACE,
      spanId: RUN_SPAN,
      pipelineName: 'har verify --full',
      result: 'failure',
      verdict: 'fail',
      treeHash: 'a'.repeat(40),
      headRevision: 'b'.repeat(40),
      attestationDigest: 'sha256:' + 'c'.repeat(64),
      workUnitId: 'FE-42',
      attemptId: 'attempt-1',
      branch: 'feat/x-har-agent-2',
      startTime: new Date('2026-11-23T10:00:00Z'),
      endTime: new Date('2026-11-23T10:00:03Z'),
    });
    expect(state.stages.map((stage) => [stage.name, stage.result, stage.taskType, stage.verificationRunId])).toEqual([
      ['build', 'success', 'build', 'vr-1'],
      ['unit-tests', 'failure', 'test', 'vr-1'],
    ]);
  });

  it('attributes a copy without a local path by its repository URL', async () => {
    const result = await ingestOtelTracesJson(verificationPayload(correlation));
    expect(result.accepted).toBe(3);
    expect(state.runs[0].repositoryId).toBe('repo-app');
  });

  it('is idempotent: a re-delivered trace is stored once', async () => {
    const payload = verificationPayload([...correlation, str('factory.local.checkout_path', MAIN)]);
    await ingestOtelTracesJson(payload);
    await ingestOtelTracesJson(payload);
    expect(state.runs).toHaveLength(1);
    expect(state.stages).toHaveLength(2);
  });

  it('links stages that arrive after their run', async () => {
    await ingestOtelTracesJson(verificationPayload([...correlation, str('factory.local.checkout_path', MAIN)]));
    state.stages = [];
    const later = await ingestOtelTracesJson(verificationPayload(correlation, { stagesOnly: true }));
    expect(later.accepted).toBe(2);
    expect(state.stages.every((stage) => stage.verificationRunId === 'vr-1')).toBe(true);
  });

  it('drops a run whose repository is unknown, and its stages', async () => {
    const result = await ingestOtelTracesJson(
      verificationPayload([str('vcs.repository.url.full', 'https://github.com/acme/unknown.git')]),
    );
    expect(result.accepted).toBe(0);
    expect(result.dropped).toBe(3);
    expect(result.reasons[0]).toMatch(/unknown repository/);
    expect(state.runs).toHaveLength(0);
  });

  it('disambiguates clones of one remote by the attempt', async () => {
    state.repos.push({ id: 'repo-app-clone', path: '/home/dev/acme/app-v2', gitRemote: 'https://github.com/acme/app' });
    state.attempts.push({ attemptId: 'attempt-1', repositoryId: 'repo-app-clone' });
    await ingestOtelTracesJson(verificationPayload(correlation));
    expect(state.runs[0].repositoryId).toBe('repo-app-clone');
  });

  it('normalizes remotes across https, ssh and credentials', () => {
    expect(repositoryUrlKey('git@github.com:Acme/App.git')).toBe('github.com/acme/app');
    expect(repositoryUrlKey('https://github.com/acme/app.git')).toBe('github.com/acme/app');
    expect(repositoryUrlKey('https://token@github.com/acme/app')).toBe('github.com/acme/app');
    expect(repositoryUrlKey(null)).toBeNull();
  });
});

describe('verificationRunJson', () => {
  it('serializes a run with its stages for the sync', () => {
    const at = new Date('2026-11-23T10:00:00Z');
    const json = verificationRunJson({
      id: 'vr-1',
      repositoryId: 'repo-app',
      runId: 'validation-1',
      traceId: TRACE,
      spanId: RUN_SPAN,
      pipelineName: 'har verify --full',
      result: 'success',
      verdict: 'pass',
      treeHash: 'a'.repeat(40),
      headRevision: null,
      attestationDigest: null,
      workUnitId: 'FE-42',
      attemptId: 'attempt-1',
      branch: 'main',
      producerVersion: '2.0.0',
      startTime: at,
      endTime: at,
      createdAt: at,
      updatedAt: at,
      stages: [
        {
          id: 'vs-1',
          verificationRunId: 'vr-1',
          traceId: TRACE,
          spanId: '2222222222222222',
          name: 'build',
          result: 'success',
          taskType: 'build',
          startTime: at,
          endTime: null,
          createdAt: at,
        },
      ],
    });
    expect(json).toMatchObject({
      runId: 'validation-1',
      traceId: TRACE,
      verdict: 'pass',
      createdAt: at.toISOString(),
      stages: [{ name: 'build', result: 'success', taskType: 'build', startTime: at.toISOString(), endTime: null }],
    });
    expect(JSON.stringify(json)).not.toContain('repositoryId');
  });
});
