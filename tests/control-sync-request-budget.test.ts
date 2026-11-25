// har-portal refuses a request body over 8 MiB, or a collection over 20,000
// rows, with HTTP 413. A full sync of a repository with a long history used to
// send its first request as the metadata, every record, a usage share and a
// runs share together, each share capped on its own, so the request as a whole
// went over. The budget is now per request, and a request the portal still
// refuses as too large is split and sent again.
jest.mock('../src/core/control-repo-path', () => ({
  canonicalizeControlRepoPath: (p: string) => p,
  listLinkedWorktrees: () => [],
}));
jest.mock('../src/core/portal-credentials', () => ({ readPortalCredentials: jest.fn(() => null) }));
jest.mock('../src/core/runs', () => ({ listRuns: jest.fn(() => []) }));
jest.mock('../src/core/slot-status', () => ({
  collectEnvironmentStatus: () => ({ slots: [], generatedAt: '2026-01-01T00:00:00.000Z' }),
}));
jest.mock('../src/core/validations', () => ({ listValidations: jest.fn(() => []) }));
jest.mock('../src/core/work-units', () => ({
  listWorkUnits: jest.fn(() => []),
  listWorkAttempts: jest.fn(() => []),
  listValidationBindings: () => [],
}));
jest.mock('../src/core/usage-harvest', () => ({
  harvestUsageForSlot: () => [],
  harvestEventsForSlot: () => [],
}));
jest.mock('../src/core/telemetry-config', () => ({
  isTelemetryEnabled: () => false,
  isPortalTrajectoryEnabled: () => false,
  readTelemetryPreference: () => ({ enabled: false, signals: {}, portalTrajectory: false }),
}));
jest.mock('../src/harness/manifest', () => ({
  readManifest: () => null,
  resolveHarnessRoot: (p: string) => p,
}));
jest.mock('../src/harness/stages', () => ({ readStageRegistry: () => null }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { syncReposWithControl } from '../src/core/control-sync';
import { packSyncBodies, type SyncUnit } from '../src/core/sync-batches';
import { listRuns } from '../src/core/runs';
import { listValidations } from '../src/core/validations';
import { listWorkAttempts, listWorkUnits } from '../src/core/work-units';
import type { RunRecord } from '../src/harness/schema';

const realFetch = global.fetch;
const mockedListRuns = listRuns as jest.MockedFunction<typeof listRuns>;
const mockedListValidations = listValidations as unknown as jest.Mock;
const mockedListWorkUnits = listWorkUnits as unknown as jest.Mock;
const mockedListWorkAttempts = listWorkAttempts as unknown as jest.Mock;

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

function makeRuns(count: number, bytesEach: number): RunRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    runId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    repoPath: '/repos/big',
    stageId: 'verify',
    status: 'pass' as const,
    startedAt: `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
    trigger: 'cli' as const,
    blob: 'x'.repeat(bytesEach),
  }));
}

const guid = (n: number, tag: string): string =>
  `00000000-0000-4000-8${tag}-${String(n).padStart(12, '0')}`;

function makeWorkUnits(count: number, bytesEach: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    workUnitId: `WU-${i}`,
    title: 'w'.repeat(Math.min(bytesEach, 256)),
    blob: 'w'.repeat(bytesEach),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }));
}

function makeAttempts(count: number, bytesEach: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    attemptId: guid(i, '001'),
    workUnitId: `WU-${i}`,
    agentId: 1,
    workDir: 'a'.repeat(bytesEach),
    createdAt: '2026-01-01T00:00:00.000Z',
  }));
}

function makeValidations(count: number, bytesEach: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    validationId: guid(i, '002'),
    treeHash: 'a'.repeat(40),
    workDir: 'v'.repeat(bytesEach),
    harnessRoot: '/repos/big',
    status: 'pass',
    full: true,
    changedFiles: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }));
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Payload Too Large',
    text: async () => (status === 413 ? '{"statusCode":413,"message":"request entity too large"}' : ''),
    json: async () => body,
  } as unknown as Response;
}

describe('packSyncBodies', () => {
  const unit = (key: string, ...rows: string[]): SyncUnit => ({ key, rows });

  it('keeps everything in the head body when it fits', () => {
    const packed = packSyncBodies({ path: '/r', slots: [] }, { path: '/r' }, [unit('runs', 'a'), unit('usage', 'b')], 1_000);
    expect(packed).toHaveLength(1);
    expect(packed[0].body).toEqual({ path: '/r', slots: [], runs: ['a'], usage: ['b'] });
  });

  it('keeps every body under the byte budget, in order, losing nothing', () => {
    const rows = Array.from({ length: 40 }, (_, i) => `row-${i}-${'z'.repeat(40)}`);
    const units = [
      ...rows.slice(0, 20).map((r) => unit('validations', r)),
      ...rows.slice(20).map((r) => unit('runs', r)),
    ];
    const head = { path: '/r', slots: [], blob: 'h'.repeat(300) };
    const packed = packSyncBodies(head, { path: '/r' }, units, 600);

    expect(packed.length).toBeGreaterThan(1);
    expect(packed[0].body.blob).toBe(head.blob);
    for (const { body } of packed.slice(1)) expect(Object.keys(body)).not.toContain('slots');
    for (const { body } of packed) expect(bytes(body)).toBeLessThanOrEqual(600);
    const sent = packed.flatMap(({ body }) => [
      ...((body.validations as string[]) ?? []),
      ...((body.runs as string[]) ?? []),
    ]);
    expect(sent).toEqual(rows);
  });

  it('never splits a unit, and sends one larger than the budget alone', () => {
    const session = Array.from({ length: 5 }, (_, i) => `s${i}-${'u'.repeat(50)}`);
    const packed = packSyncBodies({ path: '/r' }, { path: '/r' }, [unit('runs', 'a'), unit('usage', ...session), unit('runs', 'b')], 100);
    const holding = packed.filter(({ body }) => Array.isArray(body.usage));
    expect(holding).toHaveLength(1);
    expect(holding[0].body.usage).toEqual(session);
    expect(holding[0].units).toHaveLength(1);
  });

  it('caps the rows of any one collection per request', () => {
    const units = Array.from({ length: 7 }, (_, i) => unit('runs', `r${i}`));
    const packed = packSyncBodies({ path: '/r' }, { path: '/r' }, units, 1_000_000, 3);
    expect(packed.map(({ body }) => (body.runs as string[]).length)).toEqual([3, 3, 1]);
  });
});

describe('portal sync request budget', () => {
  const portalSyncBodies: Record<string, unknown>[] = [];
  let stateDir: string;
  /** Bodies above this many bytes get HTTP 413, like har-service's RequestBodyLimit. */
  let portalLimit: number;

  beforeEach(() => {
    portalSyncBodies.length = 0;
    portalLimit = Number.POSITIVE_INFINITY;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-sync-budget-'));
    process.env.HAR_PORTAL_SYNC_STATE_PATH = path.join(stateDir, 'state.json');
    process.env.HAR_PORTAL_URL = 'https://portal.example.com';
    process.env.HAR_PORTAL_TOKEN = 'har_ingest_test';
    process.env.HAR_SYNC_OVERLAP_MS = '0';

    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (String(url) === 'https://portal.example.com/api/sync') {
          const raw = String(init?.body ?? '');
          if (Buffer.byteLength(raw, 'utf8') > portalLimit) return jsonResponse({}, 413);
          portalSyncBodies.push(JSON.parse(raw));
          return jsonResponse({ repositoryId: 'portal-repo-1' });
        }
        if (String(url).endsWith('/api/repos') && method === 'POST') return jsonResponse({ id: 'local-repo-1' });
        if (String(url).endsWith('/api/repos') && method === 'GET') return jsonResponse([]);
        return jsonResponse({});
      },
    );
  });

  afterEach(() => {
    delete process.env.HAR_PORTAL_SYNC_STATE_PATH;
    delete process.env.HAR_PORTAL_URL;
    delete process.env.HAR_PORTAL_TOKEN;
    delete process.env.HAR_SYNC_MAX_BATCH_BYTES;
    delete process.env.HAR_SYNC_OVERLAP_MS;
    fs.rmSync(stateDir, { recursive: true, force: true });
    mockedListRuns.mockReturnValue([]);
    mockedListValidations.mockReturnValue([]);
    mockedListWorkUnits.mockReturnValue([]);
    mockedListWorkAttempts.mockReturnValue([]);
    (global as unknown as { fetch: unknown }).fetch = realFetch;
  });

  const field = (key: string): Record<string, unknown>[] =>
    portalSyncBodies.flatMap((body) => (body[key] as Record<string, unknown>[]) ?? []);

  it('keeps the whole request under the budget when records and runs together exceed it', async () => {
    process.env.HAR_SYNC_MAX_BATCH_BYTES = '4000';
    const runs = makeRuns(10, 300); // ~3.5 KB: under the budget on its own
    const validations = makeValidations(10, 300); // ~3.5 KB: under it on its own too
    mockedListRuns.mockReturnValue(runs);
    mockedListValidations.mockReturnValue(validations);

    const result = await syncReposWithControl({ repoPaths: ['/repos/big'] });
    expect(result.failed).toBe(0);

    expect(portalSyncBodies.length).toBeGreaterThan(1);
    for (const body of portalSyncBodies) expect(bytes(body)).toBeLessThanOrEqual(4000);
    expect(portalSyncBodies[0]).toHaveProperty('slots');
    expect(field('validations').map((v) => v.validationId)).toEqual(validations.map((v) => v.validationId));
    expect(field('runs').map((r) => r.runId)).toEqual(runs.map((r) => r.runId));
  });

  it('sends work units before the attempts that point at them', async () => {
    process.env.HAR_SYNC_MAX_BATCH_BYTES = '1500';
    mockedListWorkUnits.mockReturnValue(makeWorkUnits(6, 300));
    mockedListWorkAttempts.mockReturnValue(makeAttempts(6, 300));

    await syncReposWithControl({ repoPaths: ['/repos/big'] });

    const lastWorkUnitRequest = Math.max(...portalSyncBodies.map((b, i) => (b.workUnits ? i : -1)));
    const firstAttemptRequest = portalSyncBodies.findIndex((b) => b.attempts);
    expect(firstAttemptRequest).toBeGreaterThanOrEqual(lastWorkUnitRequest);
    expect(field('workUnits')).toHaveLength(6);
    expect(field('attempts')).toHaveLength(6);
  });

  it('splits a request the portal refuses as too large and sends every row', async () => {
    const runs = makeRuns(20, 300);
    mockedListRuns.mockReturnValue(runs);
    mockedListValidations.mockReturnValue(makeValidations(10, 300));
    portalLimit = 2_500; // far below our default 4 MiB budget

    const result = await syncReposWithControl({ repoPaths: ['/repos/big'] });
    expect(result.failed).toBe(0);

    expect(portalSyncBodies.length).toBeGreaterThan(2);
    for (const body of portalSyncBodies) expect(bytes(body)).toBeLessThanOrEqual(2_500);
    expect(portalSyncBodies[0]).toHaveProperty('slots');
    expect(field('runs').map((r) => r.runId)).toEqual(runs.map((r) => r.runId));
    expect(field('validations')).toHaveLength(10);

    // The runs watermark advanced: a second sync has no runs left to send.
    portalSyncBodies.length = 0;
    await syncReposWithControl({ repoPaths: ['/repos/big'] });
    expect(field('runs')).toEqual([]);
  });

  it('fails with a clear message when one record alone is over the portal limit', async () => {
    mockedListRuns.mockReturnValue(makeRuns(1, 5_000));
    portalLimit = 2_500;

    const result = await syncReposWithControl({ repoPaths: ['/repos/big'] });
    expect(result.failed).toBe(1);
    expect(result.results[0].error).toContain('HTTP 413');
    expect(result.results[0].error).toContain('cannot be split further');
  });
});
