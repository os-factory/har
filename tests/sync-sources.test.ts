import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  collectRunsForSync,
  collectWorkUnitsForSync,
  resolveSyncSourcePaths,
} from '../src/core/sync-sources';

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
