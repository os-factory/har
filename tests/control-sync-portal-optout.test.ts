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
jest.mock('../src/core/telemetry-config', () => ({ isTelemetryEnabled: () => false }));
jest.mock('../src/harness/manifest', () => ({
  readManifest: () => null,
  resolveHarnessRoot: (p: string) => p,
}));
jest.mock('../src/harness/stages', () => ({ readStageRegistry: () => null }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { syncReposWithControl } from '../src/core/control-sync';
import { setRepoPortalSync } from '../src/core/control-registry';
import { listRuns } from '../src/core/runs';
import type { RunRecord } from '../src/harness/schema';

const realFetch = global.fetch;
const mockedListRuns = listRuns as jest.MockedFunction<typeof listRuns>;

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

describe('portal opt-out during sync', () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let stateDir: string;
  let registryPath: string;

  beforeEach(() => {
    calls.length = 0;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-portal-optout-'));
    registryPath = path.join(stateDir, 'repos.json');
    process.env.HAR_CONTROL_REGISTRY_PATH = registryPath;
    process.env.HAR_PORTAL_SYNC_STATE_PATH = path.join(stateDir, 'state.json');
    process.env.HAR_PORTAL_URL = 'https://portal.example.com';
    process.env.HAR_PORTAL_TOKEN = 'har_ingest_test';

    fs.writeFileSync(registryPath, JSON.stringify({ repos: ['/repos/local-only'] }, null, 2));

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
      },
    );

    mockedListRuns.mockReturnValue([
      {
        runId: '00000000-0000-4000-8000-000000000001',
        repoPath: '/repos/local-only',
        stageId: 'verify',
        status: 'pass',
        startedAt: '2026-01-01T00:00:00.000Z',
        trigger: 'cli',
      } satisfies RunRecord,
    ]);
  });

  afterEach(() => {
    delete process.env.HAR_CONTROL_REGISTRY_PATH;
    delete process.env.HAR_PORTAL_SYNC_STATE_PATH;
    delete process.env.HAR_PORTAL_URL;
    delete process.env.HAR_PORTAL_TOKEN;
    mockedListRuns.mockReturnValue([]);
    (global as unknown as { fetch: unknown }).fetch = realFetch;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('skips portal POSTs when the repo is opted out', async () => {
    setRepoPortalSync('/repos/local-only', false);

    const result = await syncReposWithControl({ repoPaths: ['/repos/local-only'] });
    expect(result.failed).toBe(0);

    expect(calls.some((c) => c.url.endsWith('/api/repos'))).toBe(true);
    expect(calls.filter((c) => c.url === 'https://portal.example.com/api/sync')).toHaveLength(0);
    expect(calls.filter((c) => c.url === 'https://portal.example.com/api/otel')).toHaveLength(0);
  });

  it('sends to the portal again after --portal re-enables sync', async () => {
    setRepoPortalSync('/repos/local-only', false);
    setRepoPortalSync('/repos/local-only', true);

    await syncReposWithControl({ repoPaths: ['/repos/local-only'] });

    expect(calls.filter((c) => c.url === 'https://portal.example.com/api/sync').length).toBeGreaterThan(
      0,
    );
  });
});
