// Exercises the subset push loop end-to-end through the portal path: mock the
// data collectors (covered by their own suites) and drive success/failure via
// the portal fetch, so we only assert the synced/failed/results accounting.
jest.mock('../src/core/control-repo-path', () => ({
  canonicalizeControlRepoPath: (p: string) => p,
}));
jest.mock('../src/core/portal-credentials', () => ({ readPortalCredentials: jest.fn(() => null) }));
jest.mock('../src/core/runs', () => ({ listRuns: () => [] }));
jest.mock('../src/core/slot-status', () => ({
  collectEnvironmentStatus: () => ({ slots: [], generatedAt: '2026-01-01T00:00:00.000Z' }),
}));
jest.mock('../src/core/validations', () => ({ listValidations: () => [] }));
jest.mock('../src/core/work-units', () => ({
  listWorkUnits: () => [],
  listWorkAttempts: () => [],
  listValidationBindings: () => [],
}));
jest.mock('../src/core/usage-harvest', () => {
  const actual = jest.requireActual('../src/core/usage-harvest') as typeof import('../src/core/usage-harvest');
  return {
    ...actual,
    harvestUsageForSlot: () => [],
    harvestEventsForSlot: () => [],
  };
});
jest.mock('../src/core/telemetry-config', () => ({
  isTelemetryEnabled: () => false,
  isPortalTrajectoryEnabled: () => false,
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

const realFetch = global.fetch;
let stateDir: string;

function setPortalEnv(): void {
  process.env.HAR_PORTAL_URL = 'https://portal.example.com';
  process.env.HAR_PORTAL_TOKEN = 'har_ingest_test';
}

function clearPortalEnv(): void {
  delete process.env.HAR_PORTAL_URL;
  delete process.env.HAR_PORTAL_TOKEN;
}

// Portal failures are keyed off repo path; local Mission Control always succeeds.
function mockFetchByRepo(): void {
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as { path?: string }) : {};
    const failed = typeof body.path === 'string' && body.path.includes('fail');

    if (String(url).includes('portal.example.com')) {
      return {
        ok: !failed,
        status: failed ? 500 : 200,
        statusText: failed ? 'Internal Server Error' : 'OK',
        text: async () => (failed ? 'boom' : ''),
        json: async () => ({}),
      };
    }

    if (String(url).endsWith('/api/repos') && method === 'POST') {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '',
        json: async () => ({ id: 'local-repo-1' }),
      };
    }

    if (String(url).endsWith('/api/repos') && method === 'GET') {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '',
        json: async () => [],
      };
    }

    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
      json: async () => ({}),
    };
  });
}

describe('syncReposWithControl', () => {
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-sync-state-'));
    process.env.HAR_PORTAL_SYNC_STATE_PATH = path.join(stateDir, 'state.json');
    setPortalEnv();
    mockFetchByRepo();
  });
  afterEach(() => {
    delete process.env.HAR_PORTAL_SYNC_STATE_PATH;
    fs.rmSync(stateDir, { recursive: true, force: true });
    clearPortalEnv();
    (global as unknown as { fetch: unknown }).fetch = realFetch;
  });

  it('counts every repo as synced when all succeed', async () => {
    const result = await syncReposWithControl({ repoPaths: ['/repos/a', '/repos/b'] });
    expect(result.synced).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.results).toEqual([
      { repoPath: '/repos/a', ok: true },
      { repoPath: '/repos/b', ok: true },
    ]);
  });

  it('records per-repo failures without aborting the loop', async () => {
    const result = await syncReposWithControl({
      repoPaths: ['/repos/ok', '/repos/fail', '/repos/ok2'],
    });
    expect(result.synced).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.results.map((r) => r.ok)).toEqual([true, false, true]);
    const failure = result.results.find((r) => !r.ok);
    expect(failure?.repoPath).toBe('/repos/fail');
    expect(failure?.error).toContain('500');
  });

  it('returns zeroes for an empty selection', async () => {
    const result = await syncReposWithControl({ repoPaths: [] });
    expect(result).toEqual({ synced: 0, failed: 0, results: [] });
  });

  it('makes no network calls in dry-run mode', async () => {
    const result = await syncReposWithControl({ repoPaths: ['/repos/a'], dryRun: true });
    expect(result.synced).toBe(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
