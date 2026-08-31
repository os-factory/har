// #255 end-to-end: a work unit and run written inside an externally-owned
// workspace must reach Mission Control, while the repository stays canonical
// (one row per repo, not one per worktree).
const canonicalFor = new Map<string, string>();

jest.mock('../src/core/control-repo-path', () => ({
  canonicalizeControlRepoPath: (p: string) => canonicalFor.get(p) ?? p,
}));
jest.mock('../src/core/telemetry-config', () => ({
  isTelemetryEnabled: () => false,
  isPortalTrajectoryEnabled: () => false,
  readTelemetryPreference: () => ({ enabled: false, signals: {}, portalTrajectory: false }),
  getTelemetrySignals: () => ({ prompts: false }),
}));
jest.mock('../src/core/control-registry', () => ({
  isRepoPortalSyncEnabled: () => false,
  recordRepoForControlSync: () => undefined,
  removeRegisteredRepo: () => undefined,
  listRegisteredRepos: () => [],
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

function writeRun(repo: string, runId: string): void {
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
      startedAt: '2026-08-31T11:00:00.000Z',
      finishedAt: '2026-08-31T11:00:01.000Z',
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
      json: async () => ({ id: 'repo-1' }),
      text: async () => '',
    } as unknown as Response;
  });
}

afterEach(() => {
  (global as unknown as { fetch: unknown }).fetch = realFetch;
  canonicalFor.clear();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('sync from an externally-owned workspace (#255)', () => {
  it('sends workspace work-units while registering the canonical repo path', async () => {
    const canonical = makeHarness('har-e2e-canon-');
    const workspace = makeHarness('har-e2e-ws-');
    canonicalFor.set(workspace, canonical);
    canonicalFor.set(path.resolve(workspace), canonical);

    writeWorkUnit(workspace, 'demo');
    writeRun(workspace, '55555555-5555-4555-8555-555555555555');

    const captured: Captured[] = [];
    mockFetch(captured);

    await syncRepoWithControl({ repoPath: workspace, apiUrl: 'http://control.test' });

    // Identity stays canonical — no duplicate repository row per worktree.
    const register = captured.find((c) => c.url.endsWith('/api/repos'));
    expect(register?.body.path).toBe(canonical);

    // Evidence written in the workspace now reaches Mission Control.
    const workUnits = captured.find((c) => c.url.includes('/work-units'));
    expect(
      (workUnits?.body.workUnits as { workUnitId: string }[] | undefined)?.map((u) => u.workUnitId),
    ).toEqual(['demo']);

    const runs = captured.find((c) => c.url.endsWith('/runs'));
    expect((runs?.body.runs as { runId: string }[] | undefined)?.map((r) => r.runId)).toEqual([
      '55555555-5555-4555-8555-555555555555',
    ]);
  });

  it('is unchanged when the workspace is the canonical checkout', async () => {
    const canonical = makeHarness('har-e2e-same-');
    writeWorkUnit(canonical, 'main-1');

    const captured: Captured[] = [];
    mockFetch(captured);

    await syncRepoWithControl({ repoPath: canonical, apiUrl: 'http://control.test' });

    const workUnits = captured.find((c) => c.url.includes('/work-units'));
    expect(
      (workUnits?.body.workUnits as { workUnitId: string }[] | undefined)?.map((u) => u.workUnitId),
    ).toEqual(['main-1']);
  });
});
