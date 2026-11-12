// A HAR-owned session worktree of a repo whose `.har/` is not committed holds
// mirrored validations but no `stages.json` / `harness.env`. Sync must not pull
// it in as a source on validations alone, and a secondary source whose slot
// config cannot be read must not abort the repo's sync.
const linkedWorktrees: string[] = [];
const brokenSources = new Set<string>();

jest.mock('../src/core/control-repo-path', () => ({
  canonicalizeControlRepoPath: (p: string) => p,
  listLinkedWorktrees: () => linkedWorktrees,
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
const statusCalls: string[] = [];
jest.mock('../src/core/slot-status', () => {
  const nodePath = jest.requireActual<typeof import('path')>('path');
  return {
    collectEnvironmentStatus: (repoPath: string) => {
      const resolved = nodePath.resolve(repoPath);
      statusCalls.push(resolved);
      if (brokenSources.has(resolved)) {
        throw new Error(
          'Configure agent slot limits in .har/stages.json (agentSlots) or .har/harness.env (HARNESS_AGENT_SLOT_MIN/MAX)',
        );
      }
      return {
        repoPath: resolved,
        harnessRoot: resolved,
        slots: [{ agentId: 1, active: true, harnessUsage: 'cli' }],
        generatedAt: '2026-01-01T00:00:00.000Z',
      };
    },
  };
});
jest.mock('../src/utils/logging', () => ({
  ...jest.requireActual('../src/utils/logging'),
  warn: jest.fn(),
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { syncRepoWithControl } from '../src/core/control-sync';
import { warn } from '../src/utils/logging';

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
    JSON.stringify({ version: '1', generatorVersion: '0.1.0', profile: 'default' }),
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

/** A session worktree with no committed `.har/`: only what HAR wrote into it. */
function makeBareWorktree(prefix: string, subdir: 'validations' | 'runs'): string {
  const worktree = tmpDir(prefix);
  const dir = path.join(worktree, '.har', subdir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'record.json'), '{}\n');
  return worktree;
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
  linkedWorktrees.splice(0);
  brokenSources.clear();
  statusCalls.splice(0);
  (warn as jest.Mock).mockClear();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('sync with a session worktree that lacks slot config', () => {
  it('does not read a worktree that only holds mirrored validations', async () => {
    const canonical = makeHarness('har-wt-canon-');
    const worktree = makeBareWorktree('har-wt-val-', 'validations');
    linkedWorktrees.push(worktree);
    brokenSources.add(path.resolve(worktree));

    const captured: Captured[] = [];
    mockFetch(captured);

    await syncRepoWithControl({ repoPath: canonical, apiUrl: 'http://control.test' });

    expect(statusCalls).not.toContain(path.resolve(worktree));
    const slots = captured.find((c) => c.url.endsWith('/slots'));
    expect((slots?.body.slots as { agentId: number }[] | undefined)?.map((s) => s.agentId)).toEqual([1]);
  });

  it('skips a secondary source whose slot config cannot be read and still syncs', async () => {
    const canonical = makeHarness('har-wt-canon-');
    const worktree = makeBareWorktree('har-wt-runs-', 'runs');
    linkedWorktrees.push(worktree);
    brokenSources.add(path.resolve(worktree));

    const captured: Captured[] = [];
    mockFetch(captured);

    await syncRepoWithControl({ repoPath: canonical, apiUrl: 'http://control.test' });

    expect(statusCalls).toContain(path.resolve(worktree));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`Skipping slot status from ${worktree}`));
    const slots = captured.find((c) => c.url.endsWith('/slots'));
    expect((slots?.body.slots as { agentId: number }[] | undefined)?.map((s) => s.agentId)).toEqual([1]);
  });

  it('still fails when the canonical checkout itself has no slot config', async () => {
    const canonical = makeHarness('har-wt-canon-');
    brokenSources.add(path.resolve(canonical));
    mockFetch([]);

    await expect(
      syncRepoWithControl({ repoPath: canonical, apiUrl: 'http://control.test' }),
    ).rejects.toThrow('Configure agent slot limits');
  });
});
