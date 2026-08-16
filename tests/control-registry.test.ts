import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  clearRegisteredRepos,
  getControlRegistryPath,
  isRepoPortalSyncEnabled,
  listRegisteredRepos,
  recordRepoForControlSync,
  removeRegisteredRepo,
  setRepoPortalSync,
} from '../src/core/control-registry';
import { canonicalizeControlRepoPath } from '../src/core/control-repo-path';

const FIXTURE = path.join(__dirname, 'fixtures/minimal-harness');
/** Mission Control identity is the main checkout path, even from a session worktree. */
const FIXTURE_CANONICAL = canonicalizeControlRepoPath(FIXTURE);

describe('control registry', () => {
  let tempHome: string;
  let registryPath: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'har-control-registry-'));
    registryPath = path.join(tempHome, 'repos.json');
    process.env.HAR_CONTROL_REGISTRY_PATH = registryPath;
  });

  afterEach(() => {
    delete process.env.HAR_CONTROL_REGISTRY_PATH;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('records a repo with a harness manifest', () => {
    recordRepoForControlSync(FIXTURE);
    expect(listRegisteredRepos()).toEqual([FIXTURE_CANONICAL]);
    expect(fs.existsSync(getControlRegistryPath())).toBe(true);
  });

  it('deduplicates repo paths', () => {
    recordRepoForControlSync(FIXTURE);
    recordRepoForControlSync(FIXTURE);
    expect(listRegisteredRepos()).toHaveLength(1);
  });

  it('ignores repos without a manifest', () => {
    recordRepoForControlSync(__dirname);
    expect(listRegisteredRepos()).toEqual([]);
  });

  it('ignores a manifest that is not inside a git repo', () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'har-non-git-'));
    fs.mkdirSync(path.join(nonGit, '.har'), { recursive: true });
    fs.copyFileSync(
      path.join(FIXTURE, '.har', 'manifest.json'),
      path.join(nonGit, '.har', 'manifest.json'),
    );
    try {
      recordRepoForControlSync(nonGit);
      expect(listRegisteredRepos()).toEqual([]);
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it('does not write when HAR_CONTROL_DISABLED is set', () => {
    process.env.HAR_CONTROL_DISABLED = 'true';
    recordRepoForControlSync(FIXTURE);
    expect(fs.existsSync(getControlRegistryPath())).toBe(false);
    delete process.env.HAR_CONTROL_DISABLED;
  });

  it('prunes missing repos from the registry', () => {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(
      registryPath,
      JSON.stringify({ repos: [path.resolve(FIXTURE), '/tmp/missing-har-repo'] }, null, 2),
    );

    expect(listRegisteredRepos()).toEqual([FIXTURE_CANONICAL]);
    expect(JSON.parse(fs.readFileSync(registryPath, 'utf8')).repos).toEqual([FIXTURE_CANONICAL]);
  });

  it('removes a registered repo from the registry', () => {
    recordRepoForControlSync(FIXTURE);
    expect(removeRegisteredRepo(FIXTURE)).toBe(true);
    expect(listRegisteredRepos()).toEqual([]);
    expect(removeRegisteredRepo(FIXTURE)).toBe(false);
  });

  it('clears every registered repo', () => {
    recordRepoForControlSync(FIXTURE);
    expect(clearRegisteredRepos()).toBe(1);
    expect(listRegisteredRepos()).toEqual([]);
    expect(clearRegisteredRepos()).toBe(0);
  });

  it('defaults portal sync to enabled', () => {
    recordRepoForControlSync(FIXTURE);
    expect(isRepoPortalSyncEnabled(FIXTURE)).toBe(true);
  });

  it('persists portal opt-out and re-enable', () => {
    recordRepoForControlSync(FIXTURE);
    setRepoPortalSync(FIXTURE, false);
    expect(isRepoPortalSyncEnabled(FIXTURE)).toBe(false);
    expect(JSON.parse(fs.readFileSync(registryPath, 'utf8')).portalOptOut).toEqual([
      FIXTURE_CANONICAL,
    ]);

    setRepoPortalSync(FIXTURE, true);
    expect(isRepoPortalSyncEnabled(FIXTURE)).toBe(true);
    expect(JSON.parse(fs.readFileSync(registryPath, 'utf8')).portalOptOut).toBeUndefined();
  });

  it('recordRepoForControlSync does not clear an existing portal opt-out', () => {
    recordRepoForControlSync(FIXTURE);
    setRepoPortalSync(FIXTURE, false);
    recordRepoForControlSync(FIXTURE);
    expect(isRepoPortalSyncEnabled(FIXTURE)).toBe(false);
  });

  it('removeRegisteredRepo drops portal opt-out for that path', () => {
    recordRepoForControlSync(FIXTURE);
    setRepoPortalSync(FIXTURE, false);
    removeRegisteredRepo(FIXTURE);
    expect(JSON.parse(fs.readFileSync(registryPath, 'utf8')).portalOptOut).toBeUndefined();
  });

  it('listRegisteredRepos prunes portal opt-out for missing repos', () => {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(
      registryPath,
      JSON.stringify(
        {
          repos: [path.resolve(FIXTURE), '/tmp/missing-har-repo'],
          portalOptOut: ['/tmp/missing-har-repo', path.resolve(FIXTURE)],
        },
        null,
        2,
      ),
    );

    expect(listRegisteredRepos()).toEqual([FIXTURE_CANONICAL]);
    expect(JSON.parse(fs.readFileSync(registryPath, 'utf8')).portalOptOut).toEqual([
      FIXTURE_CANONICAL,
    ]);
  });

  it('clearRegisteredRepos clears portal opt-out', () => {
    recordRepoForControlSync(FIXTURE);
    setRepoPortalSync(FIXTURE, false);
    clearRegisteredRepos();
    expect(JSON.parse(fs.readFileSync(registryPath, 'utf8'))).toEqual({ repos: [] });
  });
});
