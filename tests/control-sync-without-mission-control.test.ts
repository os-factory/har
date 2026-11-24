// #369: the HQ sync does not need Mission Control. With Mission Control
// disabled or not running, a repo connected to HAR HQ still sends what it reads
// locally (runs, validations, work records, bindings, slots), says in one line
// that Mission Control was skipped, and leaves out what only Mission Control
// stores until it is back. A repo without an HQ connection sends nothing.
jest.mock('../src/core/control-repo-path', () => ({
  canonicalizeControlRepoPath: (p: string) => p,
  resolveMainWorkingTree: (p: string) => p,
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
  isTelemetryEnabled: jest.fn(() => false),
  isPortalTrajectoryEnabled: () => false,
  getTelemetryLevel: () => 'standard',
  getTelemetrySignals: () => ({ metrics: true, logs: true, prompts: true, traces: true }),
  readTelemetryPreference: () => ({ enabled: false, signals: {}, portalTrajectory: false }),
}));
jest.mock('../src/harness/manifest', () => ({
  readManifest: () => ({ version: 1 }),
  resolveHarnessRoot: (p: string) => p,
}));
jest.mock('../src/harness/stages', () => ({ readStageRegistry: () => null }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  syncAllKnownReposWithControl,
  syncRepoWithControlAsync,
  syncReposWithControl,
} from '../src/core/control-sync';
import { listRuns } from '../src/core/runs';
import { isTelemetryEnabled } from '../src/core/telemetry-config';
import type { RunRecord } from '../src/harness/schema';

// The registry keeps only repos that exist on disk.
const repoParent = fs.mkdtempSync(path.join(os.tmpdir(), 'har-sync-no-mc-repo-'));
const REPO = path.join(repoParent, 'connected');
fs.mkdirSync(REPO);
afterAll(() => fs.rmSync(repoParent, { recursive: true, force: true }));
const MC = 'http://mc.test';
const PORTAL = 'https://portal.example.com';
const realFetch = global.fetch;
const mockedListRuns = listRuns as jest.MockedFunction<typeof listRuns>;
const mockedTelemetry = isTelemetryEnabled as jest.MockedFunction<typeof isTelemetryEnabled>;

const run: RunRecord = {
  runId: '00000000-0000-4000-8000-000000000001',
  repoPath: REPO,
  stageId: 'verify',
  status: 'pass',
  startedAt: '2026-01-01T00:00:00.000Z',
  trigger: 'cli',
};

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

describe('HQ sync without Mission Control', () => {
  const requests: { method: string; url: string }[] = [];
  let missionControlUp = false;
  let stateDir: string;
  let stderr: jest.SpyInstance;
  const saved = { ...process.env };

  const portalSyncs = () => requests.filter((r) => r.method === 'POST' && r.url === `${PORTAL}/api/sync`);
  const missionControlCalls = () =>
    requests.filter((r) => r.url.startsWith(MC) && !r.url.endsWith('/api/health'));
  const lines = () => stderr.mock.calls.map(([chunk]) => String(chunk));

  beforeEach(() => {
    requests.length = 0;
    missionControlUp = false;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-sync-no-mc-'));
    const registryPath = path.join(stateDir, 'repos.json');
    fs.writeFileSync(registryPath, JSON.stringify({ repos: [REPO] }));
    process.env.HAR_CONTROL_REGISTRY_PATH = registryPath;
    process.env.HAR_CONTROL_SYNC_SELECTION_PATH = path.join(stateDir, 'selection.json');
    process.env.HAR_PORTAL_SYNC_STATE_PATH = path.join(stateDir, 'state.json');
    // No saved HQ connection: only the HAR_PORTAL_* pair below connects.
    process.env.HAR_PORTAL_TARGETS_PATH = path.join(stateDir, 'portal-targets.json');
    process.env.HAR_CREDENTIALS_PATH = path.join(stateDir, 'credentials.json');
    process.env.HAR_CONTROL_API_URL = MC;
    process.env.HAR_PORTAL_URL = PORTAL;
    process.env.HAR_PORTAL_TOKEN = 'har_ingest_test';
    delete process.env.HAR_CONTROL_DISABLED;
    mockedListRuns.mockReturnValue([run]);
    mockedTelemetry.mockReturnValue(false);
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        requests.push({ method, url: String(url) });
        if (String(url).startsWith(MC)) {
          if (!missionControlUp) throw new TypeError('fetch failed');
          if (String(url).endsWith('/api/repos') && method === 'POST') return jsonResponse({ id: 'mc-1' });
          if (String(url).endsWith('/api/repos')) return jsonResponse([{ id: 'mc-1', path: REPO }]);
          return jsonResponse({});
        }
        return jsonResponse({ repositoryId: 'hq-1' });
      },
    );
  });

  afterEach(() => {
    process.env = { ...saved };
    stderr.mockRestore();
    (global as unknown as { fetch: unknown }).fetch = realFetch;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('still syncs a connected repo with HQ when Mission Control is not reachable', async () => {
    const result = await syncAllKnownReposWithControl();

    expect(result).toEqual({ synced: 1, failed: 0, repoPaths: [REPO] });
    expect(portalSyncs()).toHaveLength(1);
    expect(missionControlCalls()).toHaveLength(0);
    expect(lines()).toEqual([
      expect.stringContaining(`Mission Control is not reachable at ${MC}: syncing connected with HAR HQ only`),
    ]);
  });

  it('still syncs a connected repo with HQ when Mission Control is disabled', async () => {
    process.env.HAR_CONTROL_DISABLED = 'true';

    const result = await syncAllKnownReposWithControl();

    expect(result.synced).toBe(1);
    expect(portalSyncs()).toHaveLength(1);
    // Disabled means not even a health check.
    expect(requests.filter((r) => r.url.startsWith(MC))).toHaveLength(0);
    expect(lines()).toEqual([expect.stringContaining('Mission Control is disabled')]);
  });

  it('sends nothing, and says nothing, for a repo without an HQ connection', async () => {
    delete process.env.HAR_PORTAL_URL;
    delete process.env.HAR_PORTAL_TOKEN;

    const result = await syncAllKnownReposWithControl();

    expect(result).toEqual({ synced: 0, failed: 0, repoPaths: [] });
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
    expect(lines()).toEqual([]);
  });

  it('leaves out what only Mission Control stores, and names it', async () => {
    mockedTelemetry.mockReturnValue(true);

    await syncAllKnownReposWithControl();

    expect(portalSyncs()).toHaveLength(1);
    // No usage, events, verification runs or trajectory read from a Mission
    // Control that is down (each would be a read failure).
    expect(missionControlCalls()).toHaveLength(0);
    expect(lines()).toEqual([
      expect.stringContaining(
        'without agent usage, verification runs and trajectory, which are read from Mission Control — run `har control up`',
      ),
    ]);
  });

  describe('end-of-command sync', () => {
    beforeEach(() => {
      // The end-of-command sync is off under jest; this suite exercises it.
      process.env.NODE_ENV = 'development';
    });

    it('syncs with HQ alone and says why when Mission Control is down', async () => {
      await syncRepoWithControlAsync(REPO);

      expect(portalSyncs()).toHaveLength(1);
      expect(lines()).toEqual([expect.stringContaining('syncing connected with HAR HQ only')]);
    });

    it('stays quiet without an HQ connection, as before', async () => {
      delete process.env.HAR_PORTAL_URL;
      delete process.env.HAR_PORTAL_TOKEN;

      await syncRepoWithControlAsync(REPO);

      expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
      expect(lines()).toEqual([]);
    });

    it('sends HQ one sync, not two, when Mission Control is up', async () => {
      missionControlUp = true;

      await syncRepoWithControlAsync(REPO);

      expect(portalSyncs()).toHaveLength(1);
      expect(requests.some((r) => r.method === 'POST' && r.url === `${MC}/api/repos`)).toBe(true);
      expect(lines()).toEqual([]);
    });
  });

  it('an explicit sync says HQ completed when only Mission Control failed', async () => {
    mockedTelemetry.mockReturnValue(true);

    const result = await syncReposWithControl({ repoPaths: [REPO] });

    expect(portalSyncs()).toHaveLength(1);
    expect(result.results[0].ok).toBe(false);
    expect(result.results[0].error).toMatch(
      /^Mission Control: .*fetch failed.* \(HQ sync completed without agent usage, verification runs and trajectory/,
    );
    // The HQ leg did not read usage, verification runs or trajectory from it.
    expect(
      missionControlCalls().filter((r) => !(r.method === 'POST' && r.url === `${MC}/api/repos`)),
    ).toHaveLength(0);
  });
});
