import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  collectRunsBySource,
  collectRunsForSync,
  collectWorkUnitsForSync,
  resolveSyncSourcePaths,
  selectRunsForSync,
} from '../src/core/sync-sources';
import {
  coveredSources,
  readRunsWatermarkEntry,
  writeRunsWatermark,
} from '../src/core/portal-watermark';

const tmpDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function makeHarness(prefix: string): string {
  const repo = tmpDir(prefix);
  const harDir = path.join(repo, '.har');
  fs.mkdirSync(harDir, { recursive: true });
  fs.writeFileSync(
    path.join(harDir, 'manifest.json'),
    JSON.stringify({ version: '1', generatorVersion: '0.1.0', profile: 'cli' }),
  );
  return repo;
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

function writeWorkUnit(repo: string, workUnitId: string, updatedAt: string): void {
  const dir = path.join(repo, '.har', 'work-units');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${workUnitId}.json`),
    JSON.stringify({ version: 1, workUnitId, createdAt: updatedAt, updatedAt }),
  );
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolveSyncSourcePaths (#255)', () => {
  it('is canonical-only when no workspace is given', () => {
    const repo = makeHarness('har-src-');
    expect(resolveSyncSourcePaths(repo)).toEqual([path.resolve(repo)]);
  });

  it('is canonical-only when the workspace is the same checkout', () => {
    const repo = makeHarness('har-src-');
    expect(resolveSyncSourcePaths(repo, repo)).toEqual([path.resolve(repo)]);
  });

  it('collapses a subdirectory onto the same harness root', () => {
    const repo = makeHarness('har-src-');
    const sub = path.join(repo, 'packages', 'thing');
    fs.mkdirSync(sub, { recursive: true });
    expect(resolveSyncSourcePaths(repo, sub)).toEqual([path.resolve(repo)]);
  });

  it('keeps both when the workspace has its own harness root', () => {
    const canonical = makeHarness('har-src-canon-');
    const workspace = makeHarness('har-src-ws-');
    expect(resolveSyncSourcePaths(canonical, workspace)).toEqual([
      path.resolve(canonical),
      path.resolve(workspace),
    ]);
  });
});

describe('collectRunsForSync (#255)', () => {
  it('reads records written only in the workspace', () => {
    const canonical = makeHarness('har-runs-canon-');
    const workspace = makeHarness('har-runs-ws-');
    writeRun(canonical, '11111111-1111-4111-8111-111111111111', '2026-08-31T10:00:00.000Z');
    writeRun(workspace, '22222222-2222-4222-8222-222222222222', '2026-08-31T11:00:00.000Z');

    const runs = collectRunsForSync(resolveSyncSourcePaths(canonical, workspace));
    expect(runs.map((r) => r.runId)).toEqual([
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
    ]);
  });

  it('does not double-count a run present in both sources', () => {
    const canonical = makeHarness('har-runs-canon-');
    const workspace = makeHarness('har-runs-ws-');
    const shared = '33333333-3333-4333-8333-333333333333';
    writeRun(canonical, shared, '2026-08-31T10:00:00.000Z');
    writeRun(workspace, shared, '2026-08-31T10:00:00.000Z');

    const runs = collectRunsForSync(resolveSyncSourcePaths(canonical, workspace));
    expect(runs).toHaveLength(1);
  });

  it('is unchanged for a HAR-owned worktree that holds no records', () => {
    const canonical = makeHarness('har-runs-canon-');
    const workspace = makeHarness('har-runs-ws-');
    writeRun(canonical, '44444444-4444-4444-8444-444444444444', '2026-08-31T10:00:00.000Z');

    const union = collectRunsForSync(resolveSyncSourcePaths(canonical, workspace));
    const canonicalOnly = collectRunsForSync([canonical]);
    expect(union).toEqual(canonicalOnly);
  });
});

describe('collectWorkUnitsForSync (#255)', () => {
  it('surfaces a work unit bound inside the workspace', () => {
    const canonical = makeHarness('har-wu-canon-');
    const workspace = makeHarness('har-wu-ws-');
    writeWorkUnit(canonical, 'main-1', '2026-08-31T10:00:00.000Z');
    writeWorkUnit(workspace, 'demo', '2026-08-31T11:00:00.000Z');

    const { workUnits } = collectWorkUnitsForSync(resolveSyncSourcePaths(canonical, workspace));
    expect(workUnits.map((u) => u.workUnitId)).toEqual(['demo', 'main-1']);
  });

  it('prefers the canonical record on an id collision', () => {
    const canonical = makeHarness('har-wu-canon-');
    const workspace = makeHarness('har-wu-ws-');
    writeWorkUnit(canonical, 'demo', '2026-08-31T10:00:00.000Z');
    writeWorkUnit(workspace, 'demo', '2026-08-31T11:00:00.000Z');

    const { workUnits } = collectWorkUnitsForSync(resolveSyncSourcePaths(canonical, workspace));
    expect(workUnits).toHaveLength(1);
    expect(workUnits[0].updatedAt).toBe('2026-08-31T10:00:00.000Z');
  });
});

describe('selectRunsForSync watermark coverage (#255)', () => {
  const filterSince = (runs: { startedAt: string }[], since: string | null) =>
    since ? runs.filter((r) => r.startedAt > since) : runs;

  it('filters a source the watermark already covers', () => {
    const canonical = makeHarness('har-wm-canon-');
    writeRun(canonical, '66666666-6666-4666-8666-666666666666', '2026-08-31T09:00:00.000Z');

    const selected = selectRunsForSync(
      collectRunsBySource([canonical]),
      '2026-08-31T10:00:00.000Z',
      [canonical],
      filterSince as never,
    );
    expect(selected).toHaveLength(0);
  });

  it('sends everything from a source the watermark has never covered', () => {
    const canonical = makeHarness('har-wm-canon-');
    const workspace = makeHarness('har-wm-ws-');
    // Older than the watermark: without the coverage rule this is stranded.
    writeRun(workspace, '77777777-7777-4777-8777-777777777777', '2026-08-31T09:00:00.000Z');

    const selected = selectRunsForSync(
      collectRunsBySource([canonical, workspace]),
      '2026-08-31T10:00:00.000Z',
      [canonical],
      filterSince as never,
    );
    expect(selected.map((r) => r.runId)).toEqual(['77777777-7777-4777-8777-777777777777']);
  });

  it('filters the workspace once the watermark covers it', () => {
    const canonical = makeHarness('har-wm-canon-');
    const workspace = makeHarness('har-wm-ws-');
    writeRun(workspace, '88888888-8888-4888-8888-888888888888', '2026-08-31T09:00:00.000Z');

    const selected = selectRunsForSync(
      collectRunsBySource([canonical, workspace]),
      '2026-08-31T10:00:00.000Z',
      [canonical, workspace],
      filterSince as never,
    );
    expect(selected).toHaveLength(0);
  });
});

describe('watermark source coverage storage (#255)', () => {
  const statePath = path.join(os.tmpdir(), `har-wm-state-${process.pid}.json`);
  const prev = process.env.HAR_PORTAL_SYNC_STATE_PATH;

  beforeEach(() => {
    process.env.HAR_PORTAL_SYNC_STATE_PATH = statePath;
    fs.rmSync(statePath, { force: true });
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.HAR_PORTAL_SYNC_STATE_PATH;
    else process.env.HAR_PORTAL_SYNC_STATE_PATH = prev;
    fs.rmSync(statePath, { force: true });
  });

  it('treats a legacy entry with no source list as covering canonical only', () => {
    const repo = makeHarness('har-wm-legacy-');
    writeRunsWatermark(repo, 'target', 'repo-1', '2026-08-31T10:00:00.000Z');
    const entry = readRunsWatermarkEntry(repo, 'target');
    expect(entry?.sources).toBeUndefined();
    expect(coveredSources(repo, entry)).toEqual([repo]);
  });

  it('accumulates sources across syncs', () => {
    const repo = makeHarness('har-wm-acc-');
    const workspace = makeHarness('har-wm-acc-ws-');
    writeRunsWatermark(repo, 'target', 'repo-1', '2026-08-31T10:00:00.000Z', [repo, workspace]);
    expect(coveredSources(repo, readRunsWatermarkEntry(repo, 'target')).sort()).toEqual(
      [repo, workspace].sort(),
    );
  });
});
