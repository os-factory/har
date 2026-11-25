// 2.0 added the `verificationRuns` collection to the HQ /api/sync body. It
// rode in the first request whole, outside the per-request budget, so a large
// set could push that request over the portal's 8 MiB / 20,000-row limits.
// It is now packed under the same budget as the other records.
jest.mock('../src/core/control-repo-path', () => ({
  canonicalizeControlRepoPath: (p: string) => p,
  listLinkedWorktrees: () => [],
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
  isTelemetryEnabled: () => true,
  isPortalTrajectoryEnabled: () => false,
  getTelemetryLevel: () => 'standard',
  getTelemetrySignals: () => ({ metrics: true, logs: true, prompts: true, traces: false }),
  readTelemetryPreference: () => ({ enabled: true, signals: {}, portalTrajectory: false }),
}));
jest.mock('../src/core/control-persisted-usage', () => ({
  fetchPersistedPortalTelemetry: async () => ({
    attributedUsage: [],
    usage: [],
    events: [],
    maxSyncedAt: null,
    failures: [],
    truncated: [],
  }),
}));
jest.mock('../src/core/control-persisted-verification', () => ({
  fetchPersistedVerificationRuns: jest.fn(),
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
import {
  fetchPersistedVerificationRuns,
  type PortalVerificationRun,
} from '../src/core/control-persisted-verification';

const realFetch = global.fetch;
const mockedVerificationRuns = fetchPersistedVerificationRuns as jest.MockedFunction<
  typeof fetchPersistedVerificationRuns
>;
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

function makeVerificationRuns(count: number, bytesEach: number): PortalVerificationRun[] {
  return Array.from({ length: count }, (_, i) => ({
    runId: `00000000-0000-4000-8003-${String(i).padStart(12, '0')}`,
    traceId: String(i).padStart(32, '0'),
    spanId: String(i).padStart(16, '0'),
    pipelineName: 'har verify',
    result: 'success',
    branch: 'b'.repeat(bytesEach),
    startTime: '2026-01-01T00:00:00.000Z',
    stages: [],
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

describe('verification runs in the HQ sync request budget', () => {
  const portalSyncBodies: Record<string, unknown>[] = [];
  let stateDir: string;
  /** Bodies above this many bytes get HTTP 413, like the portal does. */
  let portalLimit: number;

  const sentVerificationRuns = (): string[] =>
    portalSyncBodies.flatMap((body) =>
      ((body.verificationRuns as PortalVerificationRun[] | undefined) ?? []).map((run) => run.runId),
    );

  beforeEach(() => {
    portalSyncBodies.length = 0;
    portalLimit = Number.POSITIVE_INFINITY;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-sync-verification-budget-'));
    process.env.HAR_PORTAL_SYNC_STATE_PATH = path.join(stateDir, 'state.json');
    process.env.HAR_PORTAL_URL = 'https://portal.example.com';
    process.env.HAR_PORTAL_TOKEN = 'har_ingest_test';

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
    delete process.env.HAR_SYNC_MAX_BATCH_ROWS;
    mockedVerificationRuns.mockReset();
    fs.rmSync(stateDir, { recursive: true, force: true });
    (global as unknown as { fetch: unknown }).fetch = realFetch;
  });

  it('splits a large verificationRuns set under the byte budget, in order, losing none', async () => {
    process.env.HAR_SYNC_MAX_BATCH_BYTES = '4000';
    const runs = makeVerificationRuns(30, 300); // ~13 KB, over three times the budget
    mockedVerificationRuns.mockResolvedValue({
      runs,
      maxSyncedAt: '2026-01-02T00:00:00.000Z',
      failures: [],
      truncated: [],
    });

    const result = await syncReposWithControl({ repoPaths: ['/repos/big'] });
    expect(result.failed).toBe(0);

    expect(portalSyncBodies.length).toBeGreaterThan(3);
    for (const body of portalSyncBodies) expect(bytes(body)).toBeLessThanOrEqual(4000);
    expect(portalSyncBodies[0]).toHaveProperty('slots');
    expect(sentVerificationRuns()).toEqual(runs.map((run) => run.runId));

    // Its watermark advanced once every request carrying it landed.
    mockedVerificationRuns.mockClear();
    mockedVerificationRuns.mockResolvedValue({ runs: [], maxSyncedAt: null, failures: [], truncated: [] });
    await syncReposWithControl({ repoPaths: ['/repos/big'] });
    expect(mockedVerificationRuns).toHaveBeenCalledWith(
      '/repos/big',
      expect.any(String),
      '2026-01-02T00:00:00.000Z',
    );
  });

  it('caps the verificationRuns rows of each request', async () => {
    process.env.HAR_SYNC_MAX_BATCH_ROWS = '10';
    mockedVerificationRuns.mockResolvedValue({
      runs: makeVerificationRuns(25, 0),
      maxSyncedAt: null,
      failures: [],
      truncated: [],
    });

    await syncReposWithControl({ repoPaths: ['/repos/big'] });

    const perRequest = portalSyncBodies
      .map((body) => (body.verificationRuns as unknown[] | undefined)?.length ?? 0)
      .filter((n) => n > 0);
    expect(perRequest).toEqual([10, 10, 5]);
  });

  it('splits a request the portal refuses as too large and sends every verification run', async () => {
    const runs = makeVerificationRuns(20, 300);
    mockedVerificationRuns.mockResolvedValue({ runs, maxSyncedAt: null, failures: [], truncated: [] });
    portalLimit = 2_500; // far below our default 4 MiB budget

    const result = await syncReposWithControl({ repoPaths: ['/repos/big'] });
    expect(result.failed).toBe(0);

    for (const body of portalSyncBodies) expect(bytes(body)).toBeLessThanOrEqual(2_500);
    expect(sentVerificationRuns()).toEqual(runs.map((run) => run.runId));
  });
});
