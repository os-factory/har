// Bounding the sync payload: a large run history must be chunked under a size
// cap (no single oversized request), land with no loss/reorder, and — when a
// request does fail at the socket level — surface the real cause, not a bare
// `fetch failed`. Collectors are mocked (covered by their own suites); we drive
// listRuns + fetch to exercise the batching and error-surfacing seams.
jest.mock('../src/core/control-repo-path', () => ({
  canonicalizeControlRepoPath: (p: string) => p,
}));
jest.mock('../src/core/portal-credentials', () => ({ readPortalCredentials: jest.fn(() => null) }));
jest.mock('../src/core/runs', () => ({ listRuns: jest.fn(() => []) }));
jest.mock('../src/core/slot-status', () => ({
  collectEnvironmentStatus: () => ({ slots: [], generatedAt: '2026-01-01T00:00:00.000Z' }),
}));
jest.mock('../src/core/validations', () => ({ listValidations: () => [] }));
jest.mock('../src/core/work-units', () => ({
  listWorkUnits: () => [],
  listWorkAttempts: () => [],
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
import { chunkBySerializedSize, syncReposWithControl } from '../src/core/control-sync';
import { listRuns } from '../src/core/runs';
import type { RunRecord } from '../src/harness/schema';

const realFetch = global.fetch;
const mockedListRuns = listRuns as jest.MockedFunction<typeof listRuns>;

function makeRuns(count: number, bytesEach: number): RunRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    runId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    repoPath: '/repos/big',
    stageId: 'verify',
    status: 'unknown' as const,
    startedAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
    trigger: 'cli' as const,
    blob: 'x'.repeat(bytesEach),
  }));
}

const newerRun: RunRecord = {
  runId: '00000000-0000-4000-8000-000000000099',
  repoPath: '/repos/big',
  stageId: 'verify',
  status: 'pass',
  startedAt: '2026-02-01T00:00:00.000Z',
  finishedAt: '2026-02-01T00:00:05.000Z',
  trigger: 'cli',
};

describe('chunkBySerializedSize', () => {
  it('returns [] for empty input', () => {
    expect(chunkBySerializedSize([], 1000)).toEqual([]);
  });

  it('keeps everything in one batch when it fits under the cap', () => {
    const items = [{ a: 1 }, { b: 2 }, { c: 3 }];
    expect(chunkBySerializedSize(items, 1_000)).toEqual([items]);
  });

  it('splits under the cap while preserving order and losing nothing', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ i, pad: 'y'.repeat(80) }));
    const batches = chunkBySerializedSize(items, 200);

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(items); // order preserved, no loss
    for (const batch of batches) {
      // Every batch of >1 item stays under the cap.
      if (batch.length > 1) {
        expect(Buffer.byteLength(JSON.stringify(batch), 'utf8')).toBeLessThanOrEqual(200 + 2);
      }
    }
  });

  it('isolates a single item larger than the cap into its own batch', () => {
    const items = [{ small: 1 }, { big: 'z'.repeat(500) }, { small: 2 }];
    const batches = chunkBySerializedSize(items, 100);
    expect(batches.flat()).toEqual(items);
    // The oversized item is alone in a batch — it cannot be split further.
    const bigBatch = batches.find((b) => b.some((x) => 'big' in x));
    expect(bigBatch).toHaveLength(1);
  });
});

describe('sync payload batching', () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let stateDir: string;

  beforeEach(() => {
    calls.length = 0;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-sync-state-'));
    process.env.HAR_PORTAL_SYNC_STATE_PATH = path.join(stateDir, 'state.json');
    process.env.HAR_PORTAL_URL = 'https://portal.example.com';
    process.env.HAR_PORTAL_TOKEN = 'har_ingest_test';
    process.env.HAR_SYNC_MAX_BATCH_BYTES = '2000';

    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (method === 'POST') calls.push({ url: String(url), body });

        if (String(url).endsWith('/api/repos') && method === 'POST') {
          return jsonResponse({ id: 'local-repo-1' });
        }
        if (String(url).endsWith('/api/repos') && method === 'GET') {
          return jsonResponse([]);
        }
        return jsonResponse({});
      }
    );
  });

  afterEach(() => {
    delete process.env.HAR_PORTAL_SYNC_STATE_PATH;
    fs.rmSync(stateDir, { recursive: true, force: true });
    delete process.env.HAR_PORTAL_URL;
    delete process.env.HAR_PORTAL_TOKEN;
    delete process.env.HAR_SYNC_MAX_BATCH_BYTES;
    mockedListRuns.mockReturnValue([]);
    (global as unknown as { fetch: unknown }).fetch = realFetch;
  });

  it('splits a large run history into multiple bounded requests on both targets', async () => {
    const runs = makeRuns(12, 500);
    mockedListRuns.mockReturnValue(runs);

    const result = await syncReposWithControl({ repoPaths: ['/repos/big'] });
    expect(result.failed).toBe(0);

    const runIds = runs.map((r) => r.runId);

    // Local Mission Control: POST /api/repos/{id}/runs, chunked, reassembles whole.
    const localRunCalls = calls.filter((c) => c.url.endsWith('/api/repos/local-repo-1/runs'));
    expect(localRunCalls.length).toBeGreaterThan(1);
    expect(localRunCalls.flatMap((c) => (c.body.runs as RunRecord[]).map((r) => r.runId))).toEqual(
      runIds
    );

    // Portal: POST /api/sync, first request carries metadata + first runs batch,
    // follow-ups are runs-only. All runs reassemble in order.
    const syncCalls = calls.filter((c) => c.url === 'https://portal.example.com/api/sync');
    expect(syncCalls.length).toBeGreaterThan(1);
    expect(syncCalls[0].body).toHaveProperty('slots'); // metadata rides the first
    expect(syncCalls.slice(1).every((c) => Object.keys(c.body).sort().join() === 'path,runs')).toBe(
      true
    );
    expect(syncCalls.flatMap((c) => (c.body.runs as RunRecord[]).map((r) => r.runId))).toEqual(
      runIds
    );

    // No runs-only request exceeds the cap.
    for (const c of syncCalls.slice(1)) {
      expect(Buffer.byteLength(JSON.stringify(c.body), 'utf8')).toBeLessThanOrEqual(2000 + 200);
    }
  });

  it('sends a small history in a single request per target', async () => {
    mockedListRuns.mockReturnValue(makeRuns(2, 100));

    await syncReposWithControl({ repoPaths: ['/repos/small'] });

    expect(calls.filter((c) => c.url.endsWith('/api/repos/local-repo-1/runs'))).toHaveLength(1);
    expect(calls.filter((c) => c.url === 'https://portal.example.com/api/sync')).toHaveLength(1);
  });
});

describe('incremental runs sync', () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let stateDir: string;

  const localRunIdsSince = (from: number): string[] =>
    calls
      .slice(from)
      .filter((c) => c.url.endsWith('/api/repos/local-repo-1/runs'))
      .flatMap((c) => (c.body.runs as RunRecord[]).map((r) => r.runId));

  beforeEach(() => {
    calls.length = 0;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-sync-state-'));
    process.env.HAR_PORTAL_SYNC_STATE_PATH = path.join(stateDir, 'state.json');
    process.env.HAR_SYNC_OVERLAP_MS = '0'; // test pure watermark semantics
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (method === 'POST') calls.push({ url: String(url), body });
        if (String(url).endsWith('/api/repos') && method === 'POST') {
          return jsonResponse({ id: 'local-repo-1' });
        }
        if (String(url).endsWith('/api/repos') && method === 'GET') return jsonResponse([]);
        return jsonResponse({});
      }
    );
  });

  afterEach(() => {
    delete process.env.HAR_PORTAL_SYNC_STATE_PATH;
    delete process.env.HAR_SYNC_MAX_BATCH_BYTES;
    delete process.env.HAR_SYNC_OVERLAP_MS;
    fs.rmSync(stateDir, { recursive: true, force: true });
    mockedListRuns.mockReturnValue([]);
    (global as unknown as { fetch: unknown }).fetch = realFetch;
  });

  it('resumes from the last landed batch when a sync is cut short mid-history', async () => {
    process.env.HAR_SYNC_MAX_BATCH_BYTES = '400'; // ~2 runs/batch
    const runs = makeRuns(9, 100); // ascending startedAt 00:00:00 … 00:00:08
    mockedListRuns.mockReturnValue(runs);

    // The batch carrying run #4 always throws (every retry), so the two batches
    // before it land and the rest abort — a cut-short sync.
    let failMidBatch = true;
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (String(url).endsWith('/api/repos') && method === 'POST') {
          return jsonResponse({ id: 'local-repo-1' });
        }
        if (String(url).endsWith('/api/repos') && method === 'GET') return jsonResponse([]);
        if (String(url).endsWith('/local-repo-1/runs') && method === 'POST') {
          const ids = (body.runs as RunRecord[]).map((r) => r.runId);
          if (failMidBatch && ids.some((id) => id.endsWith('000000000004'))) {
            throw Object.assign(new TypeError('fetch failed'), {
              cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' },
            });
          }
          calls.push({ url: String(url), body });
        }
        return jsonResponse({});
      }
    );

    const first = await syncReposWithControl({ repoPaths: ['/repos/big'] });
    expect(first.failed).toBe(1);
    expect(localRunIdsSince(0)).toEqual([
      runs[0].runId,
      runs[1].runId,
      runs[2].runId,
      runs[3].runId,
    ]); // only the batches before the failure landed

    failMidBatch = false;
    const mark = calls.length;
    const second = await syncReposWithControl({ repoPaths: ['/repos/big'] });
    expect(second.failed).toBe(0);
    expect(localRunIdsSince(mark)).toEqual([
      runs[4].runId,
      runs[5].runId,
      runs[6].runId,
      runs[7].runId,
      runs[8].runId,
    ]); // resumes at the watermark — no re-send of 0–3
  });

  it('sends everything first, then nothing new when the history is unchanged', async () => {
    const runs = makeRuns(4, 100);
    mockedListRuns.mockReturnValue(runs);

    await syncReposWithControl({ repoPaths: ['/repos/big'] });
    expect(localRunIdsSince(0)).toEqual(runs.map((r) => r.runId)); // first sync: all

    const mark = calls.length;
    await syncReposWithControl({ repoPaths: ['/repos/big'] });
    expect(localRunIdsSince(mark)).toEqual([]); // second sync: nothing re-sent
  });

  it('sends only runs newer than the watermark on a later sync', async () => {
    const runs = makeRuns(4, 100);
    mockedListRuns.mockReturnValue(runs);
    await syncReposWithControl({ repoPaths: ['/repos/big'] });

    mockedListRuns.mockReturnValue([...runs, newerRun]);

    const mark = calls.length;
    await syncReposWithControl({ repoPaths: ['/repos/big'] });
    expect(localRunIdsSince(mark)).toEqual([newerRun.runId]); // only the new run
  });

  it('--full resends the whole history despite the watermark', async () => {
    const runs = makeRuns(4, 100);
    mockedListRuns.mockReturnValue(runs);
    await syncReposWithControl({ repoPaths: ['/repos/big'] });

    const mark = calls.length;
    await syncReposWithControl({ repoPaths: ['/repos/big'], full: true });
    expect(localRunIdsSince(mark)).toEqual(runs.map((r) => r.runId));
  });

  it('re-sends a recent window (overlap) so a boundary run is not dropped', async () => {
    process.env.HAR_SYNC_OVERLAP_MS = '600000'; // 10-minute window
    const run = (id: string, startedAt: string): RunRecord => ({
      runId: `00000000-0000-4000-8000-${id}`,
      repoPath: '/repos/big',
      stageId: 'verify',
      status: 'unknown',
      startedAt,
      trigger: 'cli',
    });
    const old = run('000000000001', '2020-01-01T00:00:00.000Z');
    const r0 = run('000000000002', '2026-01-01T00:00:00.000Z');
    const r1 = run('000000000003', '2026-01-01T00:05:00.000Z'); // within 10 min of the watermark
    mockedListRuns.mockReturnValue([old, r0, r1]);

    await syncReposWithControl({ repoPaths: ['/repos/big'] }); // watermark → r1
    const mark = calls.length;
    await syncReposWithControl({ repoPaths: ['/repos/big'] });
    // The overlap re-sends the last 10 min (r0, r1) but not the old run.
    expect(localRunIdsSince(mark)).toEqual([r0.runId, r1.runId]);
  });
});

describe('self-heals on a server wipe (repo id change)', () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let stateDir: string;
  let localRepoId: string;
  let portalRepoId: string;
  let failPortalResend: boolean;
  let omitPortalRepoId: boolean;

  const runIdsSince = (from: number, urlSuffix: string): string[] =>
    calls
      .slice(from)
      .filter((c) => c.url.endsWith(urlSuffix))
      .flatMap((c) => ((c.body.runs as RunRecord[]) ?? []).map((r) => r.runId));

  beforeEach(() => {
    calls.length = 0;
    localRepoId = 'repo-A';
    portalRepoId = 'p-A';
    failPortalResend = false;
    omitPortalRepoId = false;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-sync-state-'));
    process.env.HAR_PORTAL_SYNC_STATE_PATH = path.join(stateDir, 'state.json');
    process.env.HAR_PORTAL_URL = 'https://portal.example.com';
    process.env.HAR_PORTAL_TOKEN = 'har_ingest_test';
    process.env.HAR_SYNC_OVERLAP_MS = '0';
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (method === 'POST') calls.push({ url: String(url), body });
        if (String(url).includes('portal.example.com')) {
          const isResend = String(url).endsWith('/api/sync') && body.slots === undefined;
          if (failPortalResend && isResend) {
            throw Object.assign(new TypeError('fetch failed'), {
              cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' },
            });
          }
          return jsonResponse(omitPortalRepoId ? {} : { repositoryId: portalRepoId });
        }
        if (String(url).endsWith('/api/repos') && method === 'POST') {
          return jsonResponse({ id: localRepoId });
        }
        if (String(url).endsWith('/api/repos') && method === 'GET') return jsonResponse([]);
        return jsonResponse({});
      }
    );
  });

  afterEach(() => {
    delete process.env.HAR_PORTAL_SYNC_STATE_PATH;
    delete process.env.HAR_PORTAL_URL;
    delete process.env.HAR_PORTAL_TOKEN;
    delete process.env.HAR_SYNC_OVERLAP_MS;
    fs.rmSync(stateDir, { recursive: true, force: true });
    mockedListRuns.mockReturnValue([]);
    (global as unknown as { fetch: unknown }).fetch = realFetch;
  });

  it('local: resends the whole history after Mission Control is reset', async () => {
    const runs = makeRuns(4, 100);
    mockedListRuns.mockReturnValue(runs);

    await syncReposWithControl({ repoPaths: ['/repos/big'] }); // id repo-A → all
    const settled = calls.length;
    await syncReposWithControl({ repoPaths: ['/repos/big'] }); // same id → nothing new
    expect(runIdsSince(settled, '/api/repos/repo-A/runs')).toEqual([]);

    localRepoId = 'repo-B'; // Mission Control reset → new repo id
    const mark = calls.length;
    await syncReposWithControl({ repoPaths: ['/repos/big'] });
    expect(runIdsSince(mark, '/api/repos/repo-B/runs')).toEqual(runs.map((r) => r.runId));
  });

  it('portal: resends the whole history after the portal repo is recreated', async () => {
    const runs = makeRuns(4, 100);
    mockedListRuns.mockReturnValue(runs);

    await syncReposWithControl({ repoPaths: ['/repos/big'] }); // portal p-A → all
    const settled = calls.length;
    await syncReposWithControl({ repoPaths: ['/repos/big'] }); // same id → nothing new
    expect(runIdsSince(settled, '/api/sync')).toEqual([]);

    portalRepoId = 'p-B'; // portal repo wiped → new id in the sync response
    const mark = calls.length;
    await syncReposWithControl({ repoPaths: ['/repos/big'] });
    expect(new Set(runIdsSince(mark, '/api/sync'))).toEqual(new Set(runs.map((r) => r.runId)));
  });

  it('portal: a failed resend leaves the wipe detectable on the next sync', async () => {
    const runs = makeRuns(4, 100);
    mockedListRuns.mockReturnValue(runs);
    await syncReposWithControl({ repoPaths: ['/repos/big'] }); // portal p-A → all

    mockedListRuns.mockReturnValue([...runs, newerRun]); // delta pass advances the watermark
    portalRepoId = 'p-B';
    failPortalResend = true;
    const wiped = await syncReposWithControl({ repoPaths: ['/repos/big'] });
    expect(wiped.failed).toBe(1);

    failPortalResend = false;
    const mark = calls.length;
    await syncReposWithControl({ repoPaths: ['/repos/big'] });
    expect(new Set(runIdsSince(mark, '/api/sync'))).toEqual(
      new Set([...runs, newerRun].map((r) => r.runId)),
    );
  });

  it('portal: a response without a repo id does not erase the stored one', async () => {
    const runs = makeRuns(4, 100);
    mockedListRuns.mockReturnValue(runs);
    await syncReposWithControl({ repoPaths: ['/repos/big'] }); // portal p-A → all

    mockedListRuns.mockReturnValue([...runs, newerRun]);
    omitPortalRepoId = true;
    await syncReposWithControl({ repoPaths: ['/repos/big'] });

    omitPortalRepoId = false;
    portalRepoId = 'p-B'; // the wipe must still be detected against p-A
    const mark = calls.length;
    await syncReposWithControl({ repoPaths: ['/repos/big'] });
    expect(new Set(runIdsSince(mark, '/api/sync'))).toEqual(
      new Set([...runs, newerRun].map((r) => r.runId)),
    );
  });
});

describe('sync error surfacing', () => {
  beforeEach(() => {
    mockedListRuns.mockReturnValue([]);
    delete process.env.HAR_PORTAL_URL;
    delete process.env.HAR_PORTAL_TOKEN;
  });

  afterEach(() => {
    mockedListRuns.mockReturnValue([]);
    (global as unknown as { fetch: unknown }).fetch = realFetch;
  });

  it('reports the underlying undici cause instead of a bare "fetch failed"', async () => {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (String(url).endsWith('/api/repos') && method === 'POST') {
          return jsonResponse({ id: 'local-repo-1' });
        }
        if (String(url).endsWith('/runs') && method === 'POST') {
          // Mirror undici: a bare TypeError whose real reason hides in `cause`.
          const err = new TypeError('fetch failed');
          (err as { cause?: unknown }).cause = {
            code: 'UND_ERR_SOCKET',
            message: 'other side closed',
          };
          throw err;
        }
        return jsonResponse({});
      }
    );

    const result = await syncReposWithControl({ repoPaths: ['/repos/big'] });
    expect(result.failed).toBe(1);
    const error = result.results[0].error ?? '';
    expect(error).toContain('UND_ERR_SOCKET');
    expect(error).toContain('other side closed');
    expect(error).toContain('/runs');
  });
});

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => '',
    json: async () => body,
  } as unknown as Response;
}
