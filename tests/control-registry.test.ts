import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getControlRegistryPath,
  listRegisteredRepos,
  recordRepoForControlSync,
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
});
