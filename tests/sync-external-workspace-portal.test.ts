// #255 (portal): the har-portal path had the same canonical-only read gap as
// local Mission Control — evidence written inside an externally-owned workspace
// never reached it. Identity must stay canonical; evidence must be the union.
const canonicalFor = new Map<string, string>();

jest.mock('../src/core/control-repo-path', () => ({
  canonicalizeControlRepoPath: (p: string) => canonicalFor.get(p) ?? p,
}));
jest.mock('../src/core/control-registry', () => ({
  isRepoPortalSyncEnabled: () => true,
  recordRepoForControlSync: () => undefined,
  removeRegisteredRepo: () => undefined,
  listRegisteredRepos: () => [],
}));
jest.mock('../src/core/telemetry-config', () => ({
  isTelemetryEnabled: () => false,
  isPortalTrajectoryEnabled: () => false,
  readTelemetryPreference: () => ({ enabled: false, signals: {}, portalTrajectory: false }),
  getTelemetrySignals: () => ({ prompts: false }),
}));
jest.mock('../src/core/slot-status', () => ({
  collectEnvironmentStatus: () => ({ slots: [], generatedAt: '2026-01-01T00:00:00.000Z' }),
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { syncRepoWithControl } from '../src/core/control-sync';

const realFetch = global.fetch;
const tmpDirs: string[] = [];
const statePath = path.join(os.tmpdir(), `har-portal-ext-state-${process.pid}.json`);

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function makeHarness(prefix: string): string {
  const repo = tmpDir(prefix);
  fs.mkdirSync(path.join(repo, '.har'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.har', 'manifest.json'),
    JSON.stringify({ version: '1', generatorVersion: '0.1.0', profile: 'cli' }),
  );
  fs.writeFileSync(
    path.join(repo, '.har', 'stages.json'),
    JSON.stringify({
      version: '1',
      artifactsDir: 'artifacts',
      logsDir: 'logs',
      agentSlots: { min: 1, max: 3 },
      verificationStages: [],
      stages: [],
    }),
  );
  return repo;
}

function writeWorkUnit(repo: string, workUnitId: string): void {
  const dir = path.join(repo, '.har', 'work-units');
  fs.mkdirSync(dir, { recursive: true });
  const now = '2026-08-31T11:00:00.000Z';
  fs.writeFileSync(
    path.join(dir, `${workUnitId}.json`),
    JSON.stringify({ version: 1, workUnitId, createdAt: now, updatedAt: now }),
  );
}

function writeRun(repo: string, runId: string, startedAt: string): void {
  const dir = path.join(repo, '.har', 'runs', '2026-08-31');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${runId}.json`),
    JSON.stringify({
      version: 1,
      runId,
      repoPath: repo,
      stageId: 'verify',
      status: 'pass',
      startedAt,
      finishedAt: startedAt,
      exitCode: 0,
    }),
  );
}

type Captured = { url: string; body: Record<string, unknown> };

function mockFetch(captured: Captured[]): void {
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    captured.push({ url: String(url), body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'repo-1', repositoryId: 'repo-1' }),
      text: async () => '',
    } as unknown as Response;
  });
}

beforeEach(() => {
  process.env.HAR_PORTAL_URL = 'https://portal.example.com';
  process.env.HAR_PORTAL_TOKEN = 'har_ingest_test';
  process.env.HAR_PORTAL_SYNC_STATE_PATH = statePath;
  fs.rmSync(statePath, { force: true });
});

afterEach(() => {
  (global as unknown as { fetch: unknown }).fetch = realFetch;
  delete process.env.HAR_PORTAL_URL;
  delete process.env.HAR_PORTAL_TOKEN;
  delete process.env.HAR_PORTAL_SYNC_STATE_PATH;
  fs.rmSync(statePath, { force: true });
  canonicalFor.clear();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function portalSync(captured: Captured[]): Captured | undefined {
  return captured.find((c) => c.url.includes('portal.example.com') && c.url.endsWith('/api/sync'));
}

describe('portal sync from an externally-owned workspace (#255)', () => {
  it('sends workspace work-units and runs to the portal, under the canonical path', async () => {
    const canonical = makeHarness('har-portal-canon-');
    const workspace = makeHarness('har-portal-ws-');
    canonicalFor.set(workspace, canonical);
    canonicalFor.set(path.resolve(workspace), canonical);

    writeWorkUnit(workspace, 'demo');
    writeRun(workspace, '99999999-9999-4999-8999-999999999999', '2026-08-31T11:00:00.000Z');

    const captured: Captured[] = [];
    mockFetch(captured);

    await syncRepoWithControl({ repoPath: workspace, apiUrl: 'http://control.test' });

    const sync = portalSync(captured);
    expect(sync).toBeDefined();
    // Identity: the portal still sees one repository, the canonical one.
    expect(sync?.body.path).toBe(canonical);
    // Evidence: written in the workspace, now forwarded.
    expect(
      (sync?.body.workUnits as { workUnitId: string }[] | undefined)?.map((u) => u.workUnitId),
    ).toEqual(['demo']);
    expect((sync?.body.runs as { runId: string }[] | undefined)?.map((r) => r.runId)).toEqual([
      '99999999-9999-4999-8999-999999999999',
    ]);
  });

  it('sends workspace runs older than an existing canonical watermark', async () => {
    const canonical = makeHarness('har-portal-canon-');
    const workspace = makeHarness('har-portal-ws-');
    canonicalFor.set(workspace, canonical);
    canonicalFor.set(path.resolve(workspace), canonical);

    // A watermark that predates nothing in the workspace but postdates its run.
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        states: [
          {
            repoPath: canonical,
            portalUrl: 'https://portal.example.com',
            lastSyncedAt: '2026-08-31T12:00:00.000Z',
          },
        ],
      }),
    );
    writeRun(workspace, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-08-31T09:00:00.000Z');

    const captured: Captured[] = [];
    mockFetch(captured);

    await syncRepoWithControl({ repoPath: workspace, apiUrl: 'http://control.test' });

    const sync = portalSync(captured);
    expect((sync?.body.runs as { runId: string }[] | undefined)?.map((r) => r.runId)).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ]);
  });
});
