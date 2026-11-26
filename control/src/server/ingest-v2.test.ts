import fs from 'fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  GENAI_PRICES_LABEL,
  INGEST_V2_CONTRACT_CHECKS,
  INGEST_V2_FIXTURE_ATTEMPT_ID,
  INGEST_V2_FIXTURE_BLOBS,
  INGEST_V2_FIXTURE_COMMIT_SHA,
  INGEST_V2_FIXTURE_ENVELOPE,
  INGEST_V2_FIXTURE_REPOSITORY_URL,
  INGEST_V2_FIXTURE_RUNS,
  INGEST_V2_FIXTURE_SESSION_ID,
  INGEST_V2_FIXTURE_STATEMENT_DIGEST,
  INGEST_V2_FIXTURE_WORK_UNIT_ID,
  formatIngestV2ContractReport,
  ingestV2FixtureRecords,
  runIngestV2Contract,
} from '@har/schemas';

/**
 * Mission Control is the reference ingest v2 receiver (ADR 0005): the shared
 * contract checks pass against its route handlers, on a real SQLite database,
 * and the work unit view returns the fixture story from the joins.
 */

const state = vi.hoisted(() => ({ dir: '' }));

vi.mock('@/lib/db', async () => {
  const path = await import('path');
  const { clientFor, pushSchema, tempDirectory } = await import('@/server/testing/sqlite-db');
  state.dir = tempDirectory('mc-ingest-v2-');
  const file = path.join(state.dir, 'control.db');
  pushSchema(file);
  process.env.HAR_CONTROL_EVIDENCE_DIR = path.join(state.dir, 'evidence');
  return { prisma: clientFor(file) };
});

vi.mock('@/server/git-worktrees', () => ({
  WORKTREE_MISS_REFRESH_MS: 0,
  listLinkedWorktrees: () => ({ worktrees: [] }),
}));

import { prisma } from '@/lib/db';
import * as capabilitiesRoute from '@/app/api/v2/capabilities/route';
import * as recordsRoute from '@/app/api/v2/records/route';
import * as proofsRoute from '@/app/api/v2/proofs/route';
import * as missingRoute from '@/app/api/v2/evidence/missing/route';
import * as evidenceRoute from '@/app/api/v2/evidence/[sha256]/route';
import * as workUnitRoute from '@/app/api/v2/work-units/[workUnitId]/route';
import * as factoryRunRoute from '@/app/api/v2/factory-runs/[factoryRunId]/route';
import * as proofRoute from '@/app/api/v2/proofs/[digest]/route';
import { countV2Records } from '@/server/ingest-v2';
import { recordObservations } from '@/server/session-attribution';
import { ingestOtelMetricsJson } from '@/server/otel-ingest';
import type { WorkUnitView } from '@/server/work-unit-view';

const BASE = 'http://mission-control.test/api';

/** Route a contract request to the Next route handler that serves its path. */
async function receiver(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input);
  const request = new Request(url, init);
  const route = url.pathname.replace(/^\/api\//, '');
  const params = <T>(value: T) => ({ params: Promise.resolve(value) });
  if (route === 'v2/capabilities') return capabilitiesRoute.GET();
  if (route === 'v2/records') return recordsRoute.POST(request);
  if (route === 'v2/proofs') return proofsRoute.POST(request);
  if (route === 'v2/evidence/missing') return missingRoute.POST(request);
  let match = route.match(/^v2\/evidence\/([^/]+)$/);
  if (match) {
    return request.method === 'PUT'
      ? evidenceRoute.PUT(request, params({ sha256: match[1] }))
      : evidenceRoute.GET(request, params({ sha256: match[1] }));
  }
  match = route.match(/^v2\/work-units\/([^/]+)$/);
  if (match) return workUnitRoute.GET(request, params({ workUnitId: match[1] }));
  match = route.match(/^v2\/factory-runs\/([^/]+)$/);
  if (match) return factoryRunRoute.GET(request, params({ factoryRunId: match[1] }));
  match = route.match(/^v2\/proofs\/([^/]+)$/);
  if (match) return proofRoute.GET(request, params({ digest: match[1] }));
  return new Response('not found', { status: 404 });
}

async function get<T>(route: string): Promise<{ status: number; body: T }> {
  const response = await receiver(`${BASE}/${route}`);
  return { status: response.status, body: (await response.json()) as T };
}

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(state.dir, { recursive: true, force: true });
});

describe('ingest v2 contract against Mission Control', () => {
  it('passes every contract check, twice in a row', async () => {
    for (let round = 0; round < 2; round += 1) {
      const results = await runIngestV2Contract({
        baseUrl: BASE,
        fetch: receiver,
        countRecords: (record) => countV2Records(record),
      });
      const report = formatIngestV2ContractReport(results);
      expect(results.map((result) => result.check)).toEqual([...INGEST_V2_CONTRACT_CHECKS]);
      expect(results.filter((result) => !result.pass || result.skipped), report).toEqual([]);
    }
  });

  it('rejects an attestation record whose envelope does not hash to its digest', async () => {
    const [attestation] = ingestV2FixtureRecords().filter((record) => record.type === 'Attestation');
    const response = await receiver(`${BASE}/v2/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ records: [{ ...attestation, statementDigest: `sha256:${'0'.repeat(64)}` }] }),
    });
    expect(response.status).toBe(422);
  });

  it('answers a body that is not JSON with 400', async () => {
    const response = await receiver(`${BASE}/v2/records`, { method: 'POST', body: '{not json' });
    expect(response.status).toBe(400);
  });
});

describe('work unit view', () => {
  beforeAll(async () => {
    // The contract uploads one blob; a CLI uploads every one it lists.
    for (const blob of Object.values(INGEST_V2_FIXTURE_BLOBS)) {
      await receiver(`${BASE}/v2/evidence/${blob.sha256}`, {
        method: 'PUT',
        headers: { 'content-type': blob.mediaType },
        body: new TextEncoder().encode(blob.content),
      });
    }
    // Usage stamped with the fixture attempt, in an unregistered-by-remote repository.
    await prisma.repository.create({ data: { id: 'repo-usage', path: '/home/dev/example-repo', gitRemote: null } });
    const observation = (key: string, at: string, costUsd: number | null) => ({
      agentTool: 'claude_code',
      sessionId: INGEST_V2_FIXTURE_SESSION_ID,
      observationKey: key,
      observedAt: new Date(at),
      granularity: 'request',
      source: 'otel' as const,
      producer: 'claude.api_request',
      model: 'claude-sonnet-4-5',
      tokensInput: 1000,
      tokensOutput: 500,
      costUsd,
      attemptId: INGEST_V2_FIXTURE_ATTEMPT_ID,
    });
    await recordObservations('repo-usage', [
      observation('req-1', '2026-11-25T10:32:00.000Z', 0.25),
      observation('req-2', '2026-11-25T10:50:00.000Z', null),
      // After the passing run finished: only the whole attempt counts it.
      observation('req-3', '2026-11-25T11:20:00.000Z', null),
    ]);
  });

  it('prices at ingest: a reported cost is kept, an estimate records the genai-prices release', async () => {
    const rows = await prisma.usageObservation.findMany({ orderBy: { observationKey: 'asc' } });
    expect(rows.map((row) => [row.observationKey, row.costSource, row.pricedWith])).toEqual([
      ['req-1', 'reported', null],
      ['req-2', 'estimated', GENAI_PRICES_LABEL],
      ['req-3', 'estimated', GENAI_PRICES_LABEL],
    ]);
    expect(Number(rows[0].costUsd)).toBe(0.25);
    expect(Number(rows[1].costUsd)).toBeGreaterThan(0);
  });

  it('joins work unit, attempts, factory runs, stages, evidence, proof, commits and usage', async () => {
    const { status, body } = await get<WorkUnitView>(`v2/work-units/${INGEST_V2_FIXTURE_WORK_UNIT_ID}`);
    expect(status).toBe(200);
    expect(body.workUnit).toMatchObject({
      workUnitId: INGEST_V2_FIXTURE_WORK_UNIT_ID,
      repositoryUrl: INGEST_V2_FIXTURE_REPOSITORY_URL,
      title: 'Ingest v2 contract fixture',
    });
    expect(body.attempts).toHaveLength(1);
    const [attempt] = body.attempts;
    expect(attempt).toMatchObject({ attemptId: INGEST_V2_FIXTURE_ATTEMPT_ID, slotId: '3' });
    expect(attempt.sessions).toEqual([
      expect.objectContaining({ agentTool: 'claude_code', sessionId: INGEST_V2_FIXTURE_SESSION_ID, reason: 'launch' }),
    ]);
    expect(attempt.factoryRuns.map((run) => [run.factoryRunId, run.verdict])).toEqual([
      [INGEST_V2_FIXTURE_RUNS.failing.id, 'fail'],
      [INGEST_V2_FIXTURE_RUNS.passing.id, 'pass'],
    ]);

    const [failing, passing] = attempt.factoryRuns;
    expect(failing.stages.map((stage) => [stage.stageId, stage.status])).toEqual([
      ['typecheck', 'passed'],
      ['unit-tests', 'failed'],
    ]);
    expect(failing.stages[1].log).toMatchObject({
      sha256: INGEST_V2_FIXTURE_BLOBS.failingUnitTestsLog.sha256,
      stored: true,
      href: `/api/v2/evidence/${INGEST_V2_FIXTURE_BLOBS.failingUnitTestsLog.sha256}`,
    });
    expect(failing.proof).toBeNull();
    expect(passing.stages[1].artifacts.map((artifact) => [artifact.name, artifact.sha256, artifact.stored])).toEqual([
      ['unit-tests.log', INGEST_V2_FIXTURE_BLOBS.passingUnitTestsLog.sha256, true],
      ['unit-tests/report.json', INGEST_V2_FIXTURE_BLOBS.passingReport.sha256, true],
    ]);
    expect(passing.proof).toMatchObject({
      statementDigest: INGEST_V2_FIXTURE_STATEMENT_DIGEST,
      verdict: 'pass',
      trust: 'self-reported',
      received: true,
    });
    expect(passing.commits).toEqual([
      expect.objectContaining({ commitSha: INGEST_V2_FIXTURE_COMMIT_SHA, proofDigest: INGEST_V2_FIXTURE_STATEMENT_DIGEST }),
    ]);

    // Usage by `factory.attempt.id`, up to each run's finishedAt.
    expect(failing.usage.byModel.map((model) => model.observations)).toEqual([1]);
    expect(passing.usage.byModel).toEqual([
      expect.objectContaining({
        model: 'claude-sonnet-4-5',
        observations: 2,
        tokensTotal: 3000,
        costSource: 'mixed',
        pricedWith: [GENAI_PRICES_LABEL],
      }),
    ]);
    expect(attempt.usage.byModel[0].observations).toBe(3);
  });

  it('serves the stored evidence bytes for a stage log', async () => {
    const blob = INGEST_V2_FIXTURE_BLOBS.failingUnitTestsLog;
    const response = await receiver(`${BASE}/v2/evidence/${blob.sha256}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(blob.content);
  });

  it('reads a factory run by id and a proof by digest', async () => {
    const run = await get<{ factoryRunId: string; traceId: string; proof: { statementDigest: string } }>(
      `v2/factory-runs/${INGEST_V2_FIXTURE_RUNS.passing.id}`,
    );
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({
      factoryRunId: INGEST_V2_FIXTURE_RUNS.passing.id,
      traceId: INGEST_V2_FIXTURE_RUNS.passing.traceId,
      proof: { statementDigest: INGEST_V2_FIXTURE_STATEMENT_DIGEST },
    });

    const proof = await get<{ statementDigest: string; factoryRunId: string; statement: { predicate: { verdict: string } }; envelope: unknown }>(
      `v2/proofs/${INGEST_V2_FIXTURE_STATEMENT_DIGEST}`,
    );
    expect(proof.status).toBe(200);
    expect(proof.body).toMatchObject({
      statementDigest: INGEST_V2_FIXTURE_STATEMENT_DIGEST,
      factoryRunId: INGEST_V2_FIXTURE_RUNS.passing.id,
      statement: { predicate: { verdict: 'pass' } },
    });
    expect(proof.body.envelope).toEqual(INGEST_V2_FIXTURE_ENVELOPE);
    expect((await get(`v2/factory-runs/unknown-run`)).status).toBe(404);
  });

  it('asks for the repository when two repositories use one work unit id', async () => {
    await receiver(`${BASE}/v2/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        records: [{ type: 'WorkUnit', workUnitId: INGEST_V2_FIXTURE_WORK_UNIT_ID, repositoryUrl: 'https://github.com/other/repo', links: [] }],
      }),
    });
    const ambiguous = await get<{ repositories: string[] }>(`v2/work-units/${INGEST_V2_FIXTURE_WORK_UNIT_ID}`);
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.repositories.sort()).toEqual([INGEST_V2_FIXTURE_REPOSITORY_URL, 'https://github.com/other/repo'].sort());
    const scoped = await get<WorkUnitView>(
      `v2/work-units/${INGEST_V2_FIXTURE_WORK_UNIT_ID}?repository=${encodeURIComponent(INGEST_V2_FIXTURE_REPOSITORY_URL)}`,
    );
    expect(scoped.status).toBe(200);
    expect(scoped.body.attempts).toHaveLength(1);
  });
});

describe('OTLP metrics from otel-hook', () => {
  const str = (key: string, value: string) => ({ key, value: { stringValue: value } });
  const payload = (provider: string, points: Array<{ value: number; at: string }>) => ({
    resourceMetrics: [
      {
        resource: { attributes: [str('otelhook.provider.id', provider), str('service.name', 'otel-hook')] },
        scopeMetrics: [
          {
            metrics: [
              {
                name: 'gen_ai.client.token.usage',
                unit: '{token}',
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: points.map((point) => ({
                    asInt: String(point.value),
                    timeUnixNano: `${BigInt(Date.parse(point.at)) * 1_000_000n}`,
                    attributes: [
                      str('gen_ai.token.type', 'input'),
                      str('session.id', 'codex-session-1'),
                      str('factory.attempt.id', INGEST_V2_FIXTURE_ATTEMPT_ID),
                    ],
                  })),
                },
              },
            ],
          },
        ],
      },
    ],
  });

  it('keeps the latest value of a running total, never the sum, and ignores an older point delivered late', async () => {
    await ingestOtelMetricsJson(
      payload('codex', [
        { value: 100, at: '2026-11-25T10:00:00.000Z' },
        { value: 250, at: '2026-11-25T10:05:00.000Z' },
      ]),
    );
    await ingestOtelMetricsJson(payload('codex', [{ value: 180, at: '2026-11-25T10:03:00.000Z' }]));
    const series = await prisma.metricSeries.findMany({ where: { providerId: 'codex' } });
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({
      name: 'gen_ai.client.token.usage',
      value: 250,
      temporality: 'cumulative',
      unit: '{token}',
      sessionId: 'codex-session-1',
      attemptId: INGEST_V2_FIXTURE_ATTEMPT_ID,
    });

    await ingestOtelMetricsJson(payload('codex', [{ value: 400, at: '2026-11-25T10:09:00.000Z' }]));
    expect((await prisma.metricSeries.findFirstOrThrow({ where: { providerId: 'codex' } })).value).toBe(400);
  });

  it('drops otel-hook metrics for Claude Code, whose usage comes from its native telemetry', async () => {
    const result = await ingestOtelMetricsJson(payload('claude-code', [{ value: 999, at: '2026-11-25T10:00:00.000Z' }]));
    expect(result.accepted).toBe(0);
    expect(result.dropped).toBe(1);
    expect(await prisma.metricSeries.count({ where: { providerId: 'claude-code' } })).toBe(0);
  });
});
