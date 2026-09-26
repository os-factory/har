// #256: slot occupancy written inside an externally-owned worktree must survive
// a later sync from the canonical checkout (which reports that slot idle).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { resolveSyncSourcePaths, mergeSlotStatuses } from '../src/core/sync-sources';
import { collectEnvironmentStatus } from '../src/core/slot-status';
import { syncRepoWithControl } from '../src/core/control-sync';

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

const realFetch = global.fetch;
const tmpDirs: string[] = [];

function git(cwd: string, args: string): string {
  return execSync(
    `git -c user.email=har@example.com -c user.name=har -c commit.gpgsign=false ${args}`,
    { cwd, encoding: 'utf8' },
  ).trim();
}

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return dir;
}

function writeHarness(repoPath: string): void {
  const harDir = path.join(repoPath, '.har');
  fs.mkdirSync(harDir, { recursive: true });
  fs.writeFileSync(
    path.join(harDir, 'manifest.json'),
    JSON.stringify({ version: '1', generatorVersion: '0.1.0', profile: 'cli' }),
  );
  fs.writeFileSync(
    path.join(harDir, 'stages.json'),
    JSON.stringify({
      version: '1',
      artifactsDir: 'artifacts',
      logsDir: 'logs',
      agentSlots: { min: 1, max: 1 },
      verificationStages: [],
      stages: [],
    }),
  );
  fs.writeFileSync(
    path.join(harDir, 'harness.env'),
    'export HARNESS_PROJECT_NAME="test-project"\nexport HARNESS_AGENT_SLOT_MIN=1\nexport HARNESS_AGENT_SLOT_MAX=1\n',
  );
}

function writeActiveSlot(repoPath: string, workDir: string): void {
  const slots = path.join(repoPath, '.har', 'slots');
  fs.mkdirSync(slots, { recursive: true });
  fs.writeFileSync(
    path.join(slots, 'agent-1.json'),
    JSON.stringify({
      version: 1,
      agentId: 1,
      projectName: 'test-project',
      mode: 'external',
      workDir,
      worktreePath: workDir,
      createdAt: '2026-09-01T12:00:00.000Z',
      status: 'active',
      attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
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
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeRepoWithExternalWorkspace(): { canonical: string; workspace: string } {
  const canonical = tmpDir('har-slot-canon-');
  git(canonical, 'init -q -b main');
  writeHarness(canonical);
  fs.writeFileSync(path.join(canonical, 'tracked.txt'), 'x\n');
  git(canonical, 'add tracked.txt .har');
  git(canonical, 'commit -qm init');

  const workspace = path.join(tmpDir('har-slot-ws-'), 'ext');
  git(canonical, `worktree add -q -b ext ${workspace}`);
  writeActiveSlot(workspace, workspace);
  return { canonical, workspace };
}

describe('slot sync from a linked external worktree (#256)', () => {
  it('discovers the workspace as a source even when sync runs from canonical', () => {
    const { canonical, workspace } = makeRepoWithExternalWorkspace();
    const sources = resolveSyncSourcePaths(canonical);
    expect(sources.map((s) => path.resolve(s))).toEqual(
      expect.arrayContaining([path.resolve(canonical), path.resolve(workspace)]),
    );
  });

  it('does not treat a HAR-owned worktree with only a copied manifest as a source', () => {
    const { canonical } = makeRepoWithExternalWorkspace();
    const owned = path.join(tmpDir('har-slot-owned-'), 'wt');
    git(canonical, `worktree add -q -b owned ${owned}`);
    // worktree add copies tracked `.har/manifest.json`, but no slots/runs.
    const sources = resolveSyncSourcePaths(canonical);
    expect(sources.map((s) => path.resolve(s))).not.toContain(path.resolve(owned));
  });

  it('merged status keeps the external occupancy over canonical idle', () => {
    const { canonical, workspace } = makeRepoWithExternalWorkspace();
    const merged = mergeSlotStatuses([
      collectEnvironmentStatus(canonical).slots,
      collectEnvironmentStatus(workspace).slots,
    ]);
    const slot = merged.find((s) => s.agentId === 1);
    expect(slot?.active).toBe(true);
    expect(slot?.workDir).toBe(workspace);
    expect(slot?.mode).toBe('external');
  });

  it('posts the live external slot when syncing from the main checkout', async () => {
    const { canonical, workspace } = makeRepoWithExternalWorkspace();
    const captured: Captured[] = [];
    mockFetch(captured);

    await syncRepoWithControl({ repoPath: canonical, apiUrl: 'http://control.test' });

    const register = captured.find((c) => c.url.endsWith('/api/repos'));
    expect(register?.body.path).toBe(path.resolve(canonical));

    const slotsPost = captured.find((c) => c.url.includes('/slots') && !c.url.endsWith('/api/repos'));
    const slots = slotsPost?.body.slots as Array<{ agentId: number; active: boolean; workDir?: string }> | undefined;
    const slot1 = slots?.find((s) => s.agentId === 1);
    expect(slot1?.active).toBe(true);
    expect(slot1?.workDir).toBe(workspace);
  });
});
