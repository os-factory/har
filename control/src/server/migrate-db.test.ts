import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repositoryUrlKey } from '@/server/repository-key';
import { timelinePointKey } from '@/server/timeline-points';
import { clientFor, pushSchema, tempDirectory, V1_SCHEMA } from '@/server/testing/sqlite-db';

/**
 * Mission Control 2.0 migrates a 1.x database in place to the v2 data model
 * (ADR 0005 sections 3 and 7): a database seeded in the 1.x shape comes out
 * with every row in the v2 tables, the replaced tables gone and a backup kept.
 */

const migrate = createRequire(__filename)('../../scripts/migrate-db.cjs') as {
  migrateDatabase: (file: string, args: string[]) => Promise<{ migrated: boolean; backup: string | null }>;
  repositoryUrlKey: (remote: string | null) => string | null;
};

const REMOTE = 'git@github.com:Acme/App.git';
const T = (minute: number) => Date.parse('2026-11-20T10:00:00.000Z') + minute * 60_000;
const VALIDATION = '11111111-1111-4111-8111-111111111111';
const TREE = 'a'.repeat(40);
const ATTEMPT = 'attempt-1';
const ATTESTATION = `sha256:${'d'.repeat(64)}`;

let dir: string;
let file: string;

async function seedV1(): Promise<void> {
  pushSchema(file, V1_SCHEMA);
  const db = clientFor(file);
  const run = (sql: string) => db.$executeRawUnsafe(sql);
  try {
    await run(`INSERT INTO Repository (id, path, gitRemote, createdAt, updatedAt) VALUES ('repo-1', '/home/dev/app', '${REMOTE}', ${T(0)}, ${T(0)})`);
    await run(`INSERT INTO Repository (id, path, gitRemote, createdAt, updatedAt) VALUES ('repo-2', '/home/dev/local', NULL, ${T(0)}, ${T(0)})`);
    await run(`INSERT INTO WorkUnit (id, repositoryId, workUnitId, source, sourceUrl, title, relatedLinks, sourceCreatedAt, sourceUpdatedAt, createdAt, updatedAt)
      VALUES ('wu-1', 'repo-1', 'ISSUE-7', 'github', 'https://github.com/acme/app/issues/7', 'Fix totals', '[{"source":"github","url":"https://github.com/acme/app/pull/8"}]', ${T(0)}, ${T(1)}, ${T(0)}, ${T(1)})`);
    await run(`INSERT INTO WorkUnit (id, repositoryId, workUnitId, sourceCreatedAt, sourceUpdatedAt, createdAt, updatedAt)
      VALUES ('wu-2', 'repo-2', 'ISSUE-7', ${T(0)}, ${T(0)}, ${T(0)}, ${T(0)})`);
    await run(`INSERT INTO WorkAttempt (id, repositoryId, workUnitDbId, attemptId, agentId, workDir, branch, baseCommit, sourceCreatedAt, createdAt, updatedAt)
      VALUES ('wa-1', 'repo-1', 'wu-1', '${ATTEMPT}', 2, '/wt/app-2', 'main-har-agent-2', '${'0'.repeat(40)}', ${T(2)}, ${T(2)}, ${T(2)})`);
    await run(`INSERT INTO ValidationBinding (id, repositoryId, bindingId, workUnitDbId, attemptDbId, validationId, treeHash, sourceCreatedAt, createdAt)
      VALUES ('vb-1', 'repo-1', 'binding-1', 'wu-1', 'wa-1', '${VALIDATION}', '${TREE}', ${T(10)}, ${T(10)})`);
    await run(`INSERT INTO ChangeBatch (id, repositoryId, validationId, treeHash, headSha, branch, workDir, agentId, status, full, runId, changedFiles, occupancyKey, createdAt, updatedAt)
      VALUES ('cb-1', 'repo-1', '${VALIDATION}', '${TREE}', '${'b'.repeat(40)}', 'main-har-agent-2', '/wt/app-2', 2, 'pass', 1, 'run-verify-1', '[{"path":"src/a.ts","status":"M"}]', 'attempt::${ATTEMPT}', ${T(10)}, ${T(10)})`);
    // Two verifies of one tree: the later one is the factory run's.
    for (const [id, span, start, verdict, result] of [
      ['vr-1', '1111111111111111', 9, 'fail', 'failure'],
      ['vr-2', '2222222222222222', 11, 'pass', 'success'],
    ] as const) {
      await run(`INSERT INTO VerificationRun (id, repositoryId, runId, traceId, spanId, pipelineName, result, verdict, treeHash, attestationDigest, policyId, attemptId, producerVersion, startTime, endTime, createdAt, updatedAt)
        VALUES ('${id}', 'repo-1', '${VALIDATION}', '${'c'.repeat(32)}', '${span}', 'har verify', '${result}', '${verdict}', '${TREE}', ${verdict === 'pass' ? `'${ATTESTATION}'` : 'NULL'}, 'har-verify-full', '${ATTEMPT}', '2.0.0', ${T(start)}, ${T(start + 1)}, ${T(start)}, ${T(start)})`);
      await run(`INSERT INTO VerificationStage (id, verificationRunId, traceId, spanId, name, result, taskType, addedBy, startTime, endTime, createdAt)
        VALUES ('${id}-s', '${id}', '${'c'.repeat(32)}', '${span.replace(/1|2/g, '9')}${id}', 'unit-tests', '${result}', 'test', 'policy', ${T(start)}, ${T(start) + 4000}, ${T(start)})`);
    }
    await run(`INSERT INTO ValidationCommitBinding (id, repositoryId, bindingId, validationId, treeHash, commitSha, parents, refs, message, sourceCreatedAt, createdAt)
      VALUES ('vcb-1', 'repo-1', 'cbind-1', '${VALIDATION}', '${TREE}', '${'e'.repeat(40)}', '[]', '["main"]', 'fix totals', ${T(12)}, ${T(12)})`);
    await run(`INSERT INTO SessionSlotBinding (id, repositoryId, agentTool, sessionId, subagentId, kind, slotId, occupancyKey, branch, at, origin, createdAt)
      VALUES ('sb-1', 'repo-1', 'claude_code', 'sess-1', '', 'launch', 2, 'attempt::${ATTEMPT}', 'main-har-agent-2', ${T(3)}, 'sync', ${T(3)})`);
    await run(`INSERT INTO UsageObservation (id, repositoryId, agentTool, sessionId, subagentId, observationKey, observedAt, granularity, source, producer, model, tokensInput, tokensOutput, costUsd, createdAt, updatedAt)
      VALUES ('uo-1', 'repo-1', 'claude_code', 'sess-1', '', 'req-1', ${T(4)}, 'request', 'otel', 'claude.api_request', 'claude-sonnet-4-5', 100, 50, '0.0125', ${T(4)}, ${T(4)})`);
    await run(`INSERT INTO Run (id, runId, repositoryId, stageId, status, trigger, startedAt, createdAt)
      VALUES ('run-1', 'run-verify-1', 'repo-1', 'verify', 'pass', 'cli', ${T(10)}, ${T(10)})`);
  } finally {
    await db.$disconnect();
  }
}

describe('scripts/migrate-db.cjs: 1.x database to the v2 data model', () => {
  let result: { migrated: boolean; backup: string | null };

  beforeAll(async () => {
    dir = tempDirectory('mc-migrate-');
    file = path.join(dir, 'control.db');
    await seedV1();
    result = await migrate.migrateDatabase(file, ['--skip-generate']);
  }, 120_000);

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('migrates in place and keeps a backup of the 1.x database', async () => {
    expect(result.migrated).toBe(true);
    expect(result.backup && fs.existsSync(result.backup)).toBe(true);
    const db = clientFor(file);
    try {
      const tables = (await db.$queryRawUnsafe<Array<{ name: string }>>(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      )).map((row) => row.name);
      for (const replaced of ['ChangeBatch', 'VerificationRun', 'VerificationStage', 'ValidationBinding', 'ValidationCommitBinding', 'WorkAttempt', 'SessionSlotBinding']) {
        expect(tables).not.toContain(replaced);
      }
      expect(await db.repository.count()).toBe(2);
      expect(await db.run.count()).toBe(1);
    } finally {
      await db.$disconnect();
    }
  });

  it('scopes work units to their repository URL, and a remote-less repository to itself', async () => {
    expect(migrate.repositoryUrlKey(REMOTE)).toBe(repositoryUrlKey(REMOTE));
    const db = clientFor(file);
    try {
      const units = await db.workUnit.findMany({ orderBy: { repositoryKey: 'asc' } });
      expect(units.map((unit) => [unit.repositoryKey, unit.workUnitId, unit.repositoryUrl])).toEqual([
        ['github.com/acme/app', 'ISSUE-7', 'https://github.com/Acme/App'],
        ['repo:repo-2', 'ISSUE-7', null],
      ]);
      const attempt = await db.attempt.findUniqueOrThrow({ where: { attemptId: ATTEMPT } });
      expect(attempt).toMatchObject({ workUnitId: 'ISSUE-7', repositoryKey: 'github.com/acme/app', slotId: '2', agentId: 2 });
      expect(attempt.startedAt.getTime()).toBe(T(2));
    } finally {
      await db.$disconnect();
    }
  });

  it('merges the change batch, the latest verify and the validation binding into one factory run', async () => {
    const db = clientFor(file);
    try {
      const runs = await db.factoryRun.findMany();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        factoryRunId: VALIDATION,
        tree: TREE,
        attemptId: ATTEMPT,
        workUnitId: 'ISSUE-7',
        status: 'pass',
        verdict: 'pass',
        full: true,
        spanId: '2222222222222222',
        attestationDigest: ATTESTATION,
        runId: 'run-verify-1',
        stageIds: ['unit-tests'],
      });
      expect(runs[0].startedAt.getTime()).toBe(T(10));
      expect(runs[0].finishedAt?.getTime()).toBe(T(12));
      const stages = await db.stageResult.findMany();
      expect(stages.map((stage) => [stage.stageId, stage.status, stage.durationMs])).toEqual([['unit-tests', 'passed', 4000]]);
      const commit = await db.commitBinding.findUniqueOrThrow({ where: { commitSha: 'e'.repeat(40) } });
      expect(commit).toMatchObject({ tree: TREE, factoryRunId: VALIDATION, proofDigest: ATTESTATION, branch: 'main-har-agent-2' });
    } finally {
      await db.$disconnect();
    }
  });

  it('keeps the ADR 0003 timeline as session segments the app finds by key', async () => {
    const db = clientFor(file);
    try {
      const [segment] = await db.sessionSegment.findMany();
      expect(segment).toMatchObject({ kind: 'launch', slotId: 2, origin: 'sync', to: null });
      expect(segment.segmentKey).toBe(
        timelinePointKey({
          repositoryId: 'repo-1',
          agentTool: 'claude_code',
          sessionId: 'sess-1',
          subagentId: '',
          kind: 'launch',
          slotId: 2,
          at: new Date(T(3)),
        }),
      );
      const observation = await db.usageObservation.findUniqueOrThrow({ where: { id: 'uo-1' } });
      expect(observation).toMatchObject({ costSource: 'reported', pricedWith: null });
    } finally {
      await db.$disconnect();
    }
  });

  it('is a plain schema push on a database that is already v2', async () => {
    const again = await migrate.migrateDatabase(file, ['--skip-generate']);
    expect(again).toEqual({ migrated: false, backup: null });
  }, 60_000);

  it('drops the retired CloudConfig table even when it holds a row', async () => {
    const db = clientFor(file);
    try {
      await db.$executeRawUnsafe('CREATE TABLE "CloudConfig" (id TEXT PRIMARY KEY, apiKey TEXT, apiUrl TEXT, enabled BOOLEAN)');
      await db.$executeRawUnsafe(`INSERT INTO "CloudConfig" (id, apiKey, enabled) VALUES ('default', 'key', 1)`);
    } finally {
      await db.$disconnect();
    }
    await migrate.migrateDatabase(file, ['--skip-generate']);
    const after = clientFor(file);
    try {
      const rows = await after.$queryRawUnsafe<{ name: string }[]>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'CloudConfig'`);
      expect(rows).toEqual([]);
    } finally {
      await after.$disconnect();
    }
  }, 60_000);
});
