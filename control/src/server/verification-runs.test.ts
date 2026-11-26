import fs from 'fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Verification traces (`har env verify`) are stored as factory runs with their
 * stage results (ADR 0005 section 3), attributed by the Resource checkout
 * path, else by the repository URL; they never reach the agent-session path.
 */

const MAIN = '/home/dev/acme/app';
const OTHER = '/home/dev/other';
const TRACE = 'd3209ae49e3ad07b6bb0ba4414331613';
const RUN_SPAN = '1111111111111111';

const state = vi.hoisted(() => ({ dir: '' }));

vi.mock('@/lib/db', async () => {
  const path = await import('path');
  const { clientFor, pushSchema, tempDirectory } = await import('@/server/testing/sqlite-db');
  state.dir = tempDirectory('mc-verification-');
  const file = path.join(state.dir, 'control.db');
  pushSchema(file);
  return { prisma: clientFor(file) };
});

vi.mock('@/server/git-worktrees', () => ({
  WORKTREE_MISS_REFRESH_MS: 0,
  listLinkedWorktrees: () => ({ worktrees: [] }),
}));

import { prisma } from '@/lib/db';
import { ingestOtelTracesJson } from '@/server/otel-ingest';
import { repositoryUrlKey } from '@/server/verification-runs';

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(state.dir, { recursive: true, force: true });
});

async function runs() {
  return prisma.factoryRun.findMany();
}

async function stages() {
  return prisma.stageResult.findMany({ orderBy: { startTime: 'asc' } });
}

function str(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

function nanos(iso: string): string {
  return `${BigInt(Date.parse(iso)) * 1_000_000n}`;
}

/** The shape `buildVerificationTrace` (src/core/verification-spans.ts) produces. */
function verificationPayload(
  resource: Array<ReturnType<typeof str>>,
  options: { stagesOnly?: boolean; policy?: { id: string; digest: string } } = {},
) {
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
      ...(options.policy
        ? [str('factory.policy.id', options.policy.id), str('factory.policy.digest', options.policy.digest)]
        : []),
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

beforeEach(async () => {
  await prisma.stageResult.deleteMany();
  await prisma.factoryRun.deleteMany();
  await prisma.agentSlot.deleteMany();
  await prisma.attempt.deleteMany();
  await prisma.repository.deleteMany();
  await prisma.repository.createMany({
    data: [
      { id: 'repo-app', path: MAIN, gitRemote: 'git@github.com:acme/app.git' },
      { id: 'repo-other', path: OTHER, gitRemote: 'https://github.com/acme/other' },
    ],
  });
});

describe('verification trace ingest', () => {
  it('stores the run and its stages, attributed by the checkout path', async () => {
    const result = await ingestOtelTracesJson(
      verificationPayload([...correlation, str('factory.local.checkout_path', `${MAIN}/control`)]),
    );
    expect(result).toEqual({ accepted: 3, dropped: 0, reasons: [] });
    expect(await prisma.agentSessionSpan.count()).toBe(0);
    const stored = await runs();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      repositoryId: 'repo-app',
      repositoryKey: 'github.com/acme/app',
      factoryRunId: 'validation-1',
      traceId: TRACE,
      spanId: RUN_SPAN,
      pipelineName: 'har verify --full',
      status: 'failure',
      verdict: 'fail',
      full: true,
      tree: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      attestationDigest: 'sha256:' + 'c'.repeat(64),
      workUnitId: 'FE-42',
      attemptId: 'attempt-1',
      branch: 'feat/x-har-agent-2',
      startedAt: new Date('2026-11-23T10:00:00Z'),
      finishedAt: new Date('2026-11-23T10:00:03Z'),
      stageIds: ['build', 'unit-tests'],
    });
    expect((await stages()).map((stage) => [stage.stageId, stage.status, stage.kind, stage.factoryRunId, stage.durationMs])).toEqual([
      ['build', 'passed', 'build', 'validation-1', 1000],
      ['unit-tests', 'failed', 'test', 'validation-1', 2000],
    ]);
    // No policy attributes on the run span: nothing is inferred from the pipeline name.
    expect(stored[0]).toMatchObject({ policyId: null, policyDigest: null });
    expect((await stages()).map((stage) => stage.addedBy)).toEqual(['policy', 'policy']);
  });

  it('keeps the policy id and digest when the run span carries them', async () => {
    await ingestOtelTracesJson(
      verificationPayload([...correlation, str('factory.local.checkout_path', MAIN)], {
        policy: { id: 'har-verify-full', digest: 'sha256:' + 'd'.repeat(64) },
      }),
    );
    expect((await runs())[0]).toMatchObject({ policyId: 'har-verify-full', policyDigest: 'sha256:' + 'd'.repeat(64) });
  });

  it('attributes a copy without a local path by its repository URL', async () => {
    const result = await ingestOtelTracesJson(verificationPayload(correlation));
    expect(result.accepted).toBe(3);
    expect((await runs())[0].repositoryId).toBe('repo-app');
  });

  it('attributes a copy with neither a local path nor a registered remote to the factory run its records created', async () => {
    // A trace the CLI spooled while Mission Control was down: local paths stripped,
    // the repository registered by its checkout only, the factory run already stored from v2 records.
    await prisma.repository.update({ where: { id: 'repo-app' }, data: { gitRemote: null } });
    await prisma.factoryRun.create({
      data: { factoryRunId: 'validation-1', repositoryKey: 'github.com/acme/app', tree: 'a'.repeat(40), startedAt: new Date('2026-11-23T10:00:00Z') },
    });
    const result = await ingestOtelTracesJson(verificationPayload(correlation));
    expect(result).toEqual({ accepted: 3, dropped: 0, reasons: [] });
    expect(await runs()).toHaveLength(1);
    expect((await runs())[0]).toMatchObject({ repositoryKey: 'github.com/acme/app', traceId: TRACE, spanId: RUN_SPAN });
    expect(await stages()).toHaveLength(2);
  });

  it('is idempotent: a re-delivered trace is stored once', async () => {
    const payload = verificationPayload([...correlation, str('factory.local.checkout_path', MAIN)]);
    await ingestOtelTracesJson(payload);
    await ingestOtelTracesJson(payload);
    expect(await runs()).toHaveLength(1);
    expect(await stages()).toHaveLength(2);
  });

  it('links stages that arrive after their run', async () => {
    await ingestOtelTracesJson(verificationPayload([...correlation, str('factory.local.checkout_path', MAIN)]));
    await prisma.stageResult.deleteMany();
    const later = await ingestOtelTracesJson(verificationPayload(correlation, { stagesOnly: true }));
    expect(later.accepted).toBe(2);
    expect((await stages()).every((stage) => stage.factoryRunId === 'validation-1')).toBe(true);
  });

  it('only fills what a v2 FactoryRun record already set', async () => {
    await prisma.factoryRun.create({
      data: {
        factoryRunId: 'validation-1',
        repositoryId: 'repo-app',
        tree: 'a'.repeat(40),
        verdict: 'pass',
        status: 'pass',
        full: true,
        policyId: 'har-verify-full',
        policyRequired: ['build'],
        attemptId: 'attempt-from-record',
        startedAt: new Date('2026-11-23T09:59:00Z'),
        finishedAt: new Date('2026-11-23T10:00:05Z'),
      },
    });
    await ingestOtelTracesJson(verificationPayload([...correlation, str('factory.local.checkout_path', MAIN)]));
    expect((await runs())[0]).toMatchObject({
      verdict: 'pass',
      attemptId: 'attempt-from-record',
      traceId: TRACE,
      pipelineName: 'har verify --full',
      headSha: 'b'.repeat(40),
      finishedAt: new Date('2026-11-23T10:00:05Z'),
    });
  });

  it('keeps what a v2 StageResult record set: its span adds the timing only', async () => {
    await prisma.stageResult.create({
      data: {
        factoryRunId: 'validation-1',
        stageId: 'build',
        status: 'passed',
        addedBy: 'agent',
        kind: 'custom',
        durationMs: 900,
        logDigest: 'e'.repeat(64),
        artifacts: [],
      },
    });
    await ingestOtelTracesJson(verificationPayload([...correlation, str('factory.local.checkout_path', MAIN)]));
    const build = (await stages()).find((stage) => stage.stageId === 'build');
    expect(build).toMatchObject({
      status: 'passed',
      addedBy: 'agent',
      kind: 'custom',
      durationMs: 900,
      logDigest: 'e'.repeat(64),
      spanId: '2222222222222222',
      startTime: new Date('2026-11-23T10:00:00Z'),
    });
  });

  it('drops a run whose repository is unknown, and its stages', async () => {
    const result = await ingestOtelTracesJson(
      verificationPayload([str('vcs.repository.url.full', 'https://github.com/acme/unknown.git')]),
    );
    expect(result.accepted).toBe(0);
    expect(result.dropped).toBe(3);
    expect(result.reasons[0]).toMatch(/unknown repository/);
    expect(await runs()).toHaveLength(0);
  });

  it('disambiguates clones of one remote by the attempt', async () => {
    await prisma.repository.create({ data: { id: 'repo-app-clone', path: '/home/dev/acme/app-v2', gitRemote: 'https://github.com/acme/app' } });
    await prisma.attempt.create({
      data: { attemptId: 'attempt-1', repositoryId: 'repo-app-clone', slotId: '2', startedAt: new Date('2026-11-23T09:00:00Z') },
    });
    await ingestOtelTracesJson(verificationPayload(correlation));
    expect((await runs())[0].repositoryId).toBe('repo-app-clone');
  });

  it('normalizes remotes across https, ssh and credentials', () => {
    expect(repositoryUrlKey('git@github.com:Acme/App.git')).toBe('github.com/acme/app');
    expect(repositoryUrlKey('https://github.com/acme/app.git')).toBe('github.com/acme/app');
    expect(repositoryUrlKey('https://token@github.com/acme/app')).toBe('github.com/acme/app');
    expect(repositoryUrlKey(null)).toBeNull();
  });
});
