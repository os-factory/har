import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  GIT_EXCLUDE_PATTERNS,
  buildSessionName,
  createSessionWorktree,
  generateSessionSuffix,
  isToolchainReady,
  joinWorkDir,
  removeSessionWorktree,
  resolveResumeSession,
  sanitizeSessionBranch,
  seedGitExclude,
} from '../src/runtime/worktree';

const tmpDirs: string[] = [];

function git(cwd: string, args: string): string {
  return execSync(
    `git -c user.email=har@example.com -c user.name=har -c commit.gpgsign=false ${args}`,
    { cwd, encoding: 'utf8' },
  ).trim();
}

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function makeRepo(branch = 'main'): string {
  const repo = tmpDir('har-runtime-worktree-');
  git(repo, `init -q -b ${branch}`);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'x\n');
  git(repo, 'add tracked.txt');
  git(repo, 'commit -qm init');
  return repo;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('session naming', () => {
  it('replaces every slash in the base branch', () => {
    expect(sanitizeSessionBranch('feat/x/y')).toBe('feat-x-y');
  });

  it('builds <base>-<sha4>-har-agent-<id>-<rand4>', () => {
    expect(buildSessionName('feat/login', 'ab12', 3, '9xk2')).toBe(
      'feat-login-ab12-har-agent-3-9xk2',
    );
  });

  it('generates 4-char [a-z0-9] suffixes', () => {
    for (let i = 0; i < 20; i++) {
      expect(generateSessionSuffix()).toMatch(/^[a-z0-9]{4}$/);
    }
  });

  it('joins work dir like the bash ${VAR%/} trims', () => {
    expect(joinWorkDir('/w/tree', '')).toBe('/w/tree');
    expect(joinWorkDir('/w/tree/', '')).toBe('/w/tree');
    expect(joinWorkDir('/w/tree', 'apps/web/')).toBe('/w/tree/apps/web');
  });
});

describe('createSessionWorktree', () => {
  it('creates the suffixed worktree and branch from HEAD', () => {
    const repo = makeRepo('main');
    const home = tmpDir('har-home-');
    const session = createSessionWorktree({
      repoRoot: repo,
      agentId: 2,
      homeDir: home,
      suffix: 'ab3z',
    });

    const sha4 = git(repo, 'rev-parse --short=4 HEAD');
    expect(session.sessionName).toBe(`main-${sha4}-har-agent-2-ab3z`);
    expect(session.branch).toBe(session.sessionName);
    expect(session.worktreeDir).toBe(path.join(home, 'worktrees', session.sessionName));
    expect(session.workDir).toBe(session.worktreeDir);
    expect(session.baseBranch).toBe('main');
    expect(session.baseCommit).toBe(git(repo, 'rev-parse HEAD'));
    expect(fs.existsSync(path.join(session.worktreeDir, 'tracked.txt'))).toBe(true);
    expect(git(session.worktreeDir, 'rev-parse --abbrev-ref HEAD')).toBe(session.branch);
  });

  it('sanitizes slashed branches into the session name', () => {
    const repo = makeRepo('main');
    git(repo, 'checkout -q -b feat/nested/thing');
    const home = tmpDir('har-home-');
    const session = createSessionWorktree({
      repoRoot: repo,
      agentId: 1,
      homeDir: home,
      suffix: 'q1w2',
    });
    expect(session.sessionName).toMatch(/^feat-nested-thing-[0-9a-f]{4,}-har-agent-1-q1w2$/);
    expect(session.baseBranch).toBe('feat/nested/thing');
  });

  it('appends the monorepo prefix to the work dir', () => {
    const repo = makeRepo('main');
    fs.mkdirSync(path.join(repo, 'apps', 'web'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'apps', 'web', 'a.txt'), 'a\n');
    git(repo, 'add apps');
    git(repo, 'commit -qm sub');
    const home = tmpDir('har-home-');
    const session = createSessionWorktree({
      repoRoot: path.join(repo, 'apps', 'web'),
      agentId: 4,
      homeDir: home,
      suffix: 'zz11',
    });
    expect(session.relPrefix).toBe('apps/web/');
    expect(session.workDir).toBe(path.join(session.worktreeDir, 'apps/web'));
  });
});

describe('seedGitExclude', () => {
  it('appends missing patterns exactly once', () => {
    const repo = makeRepo();
    seedGitExclude(repo);
    seedGitExclude(repo);
    const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
    for (const pattern of GIT_EXCLUDE_PATTERNS) {
      const occurrences = exclude.split('\n').filter((l) => l === pattern).length;
      expect(occurrences).toBe(1);
    }
  });

  it('keeps pre-existing exact lines without duplicating them', () => {
    const repo = makeRepo();
    const excludeFile = path.join(repo, '.git', 'info', 'exclude');
    fs.appendFileSync(excludeFile, '.env.agent.*\n');
    seedGitExclude(repo);
    const lines = fs.readFileSync(excludeFile, 'utf8').split('\n');
    expect(lines.filter((l) => l === '.env.agent.*')).toHaveLength(1);
    expect(lines).toContain('.har/venv');
  });
});

describe('resolveResumeSession', () => {
  function writeHarness(repo: string): void {
    const harDir = path.join(repo, '.har');
    fs.mkdirSync(harDir, { recursive: true });
    fs.writeFileSync(
      path.join(harDir, 'manifest.json'),
      JSON.stringify({ version: '1', generatorVersion: '0.1.0', profile: 'cli' }),
    );
  }

  function writeRegistry(repo: string, entry: Record<string, unknown>): void {
    const slots = path.join(repo, '.har', 'slots');
    fs.mkdirSync(slots, { recursive: true });
    fs.writeFileSync(
      path.join(slots, `agent-${entry.agentId}.json`),
      JSON.stringify(entry, null, 2),
    );
  }

  it('rejects non-resumable statuses', () => {
    const repo = makeRepo();
    writeHarness(repo);
    writeRegistry(repo, {
      version: 1,
      agentId: 1,
      projectName: 'p',
      mode: 'worktree',
      workDir: repo,
      createdAt: new Date().toISOString(),
      status: 'active',
    });
    const result = resolveResumeSession(repo, 1);
    expect(result).toMatchObject({ ok: false, code: 'not-resumable' });
    if (!result.ok) expect(result.message).toContain('status=active');
  });

  it('rejects a missing registry entry as not resumable (status=none)', () => {
    const repo = makeRepo();
    writeHarness(repo);
    const result = resolveResumeSession(repo, 1);
    expect(result).toMatchObject({ ok: false, code: 'not-resumable' });
    if (!result.ok) expect(result.message).toContain('status=none');
  });

  it('rejects a missing work dir', () => {
    const repo = makeRepo();
    writeHarness(repo);
    writeRegistry(repo, {
      version: 1,
      agentId: 1,
      projectName: 'p',
      mode: 'worktree',
      workDir: path.join(repo, 'gone'),
      createdAt: new Date().toISOString(),
      status: 'failed',
    });
    expect(resolveResumeSession(repo, 1)).toMatchObject({
      ok: false,
      code: 'missing-work-dir',
    });
  });

  it('rejects a missing env file', () => {
    const repo = makeRepo();
    writeHarness(repo);
    writeRegistry(repo, {
      version: 1,
      agentId: 1,
      projectName: 'p',
      mode: 'worktree',
      workDir: repo,
      createdAt: new Date().toISOString(),
      status: 'failed',
    });
    expect(resolveResumeSession(repo, 1)).toMatchObject({
      ok: false,
      code: 'missing-env-file',
    });
  });

  it('returns the typed session for a resumable slot', () => {
    const repo = makeRepo();
    writeHarness(repo);
    fs.writeFileSync(path.join(repo, '.env.agent.1'), 'AGENT_ID=1\n');
    writeRegistry(repo, {
      version: 1,
      agentId: 1,
      projectName: 'p',
      mode: 'worktree',
      workDir: repo,
      worktreePath: repo,
      branch: 'main-ab12-har-agent-1-zz99',
      suffix: 'zz99',
      baseBranch: 'main',
      baseCommit: 'deadbeef',
      createdAt: new Date().toISOString(),
      status: 'starting',
    });
    const result = resolveResumeSession(repo, 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session).toEqual({
        workDir: repo,
        worktreeDir: repo,
        branch: 'main-ab12-har-agent-1-zz99',
        suffix: 'zz99',
        baseBranch: 'main',
        baseCommit: 'deadbeef',
        useWorktree: true,
        envFile: path.join(repo, '.env.agent.1'),
      });
    }
  });
});

describe('isToolchainReady', () => {
  it('detects node and venv toolchains', () => {
    const dir = tmpDir('har-toolchain-');
    expect(isToolchainReady(dir)).toBe(false);
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    expect(isToolchainReady(dir)).toBe(false);
    fs.mkdirSync(path.join(dir, 'node_modules'));
    expect(isToolchainReady(dir)).toBe(true);

    const venvDir = tmpDir('har-toolchain-venv-');
    fs.mkdirSync(path.join(venvDir, '.har', 'venv'), { recursive: true });
    expect(isToolchainReady(venvDir)).toBe(true);
  });
});

describe('removeSessionWorktree', () => {
  it('removes the worktree, prunes, and keeps the branch by default', () => {
    const repo = makeRepo();
    const home = tmpDir('har-home-');
    const session = createSessionWorktree({
      repoRoot: repo,
      agentId: 3,
      homeDir: home,
      suffix: 'rm01',
    });
    fs.writeFileSync(path.join(session.worktreeDir, '.env.agent.3'), 'x\n');
    fs.writeFileSync(path.join(session.worktreeDir, 'ecosystem.agent.3.config.cjs'), 'x\n');

    const result = removeSessionWorktree({
      repoRoot: repo,
      agentId: 3,
      worktreePath: session.worktreeDir,
      branch: session.branch,
    });

    expect(result.removedWorktree).toBe(session.worktreeDir);
    expect(result.keptBranch).toBe(session.branch);
    expect(fs.existsSync(session.worktreeDir)).toBe(false);
    expect(git(repo, `branch --list ${session.branch}`)).toContain(session.branch);
  });

  it('deletes the branch with deleteBranch', () => {
    const repo = makeRepo();
    const home = tmpDir('har-home-');
    const session = createSessionWorktree({
      repoRoot: repo,
      agentId: 5,
      homeDir: home,
      suffix: 'rm02',
    });
    const result = removeSessionWorktree({
      repoRoot: repo,
      agentId: 5,
      worktreePath: session.worktreeDir,
      branch: session.branch,
      deleteBranch: true,
    });
    expect(result.deletedBranch).toBe(session.branch);
    expect(git(repo, `branch --list ${session.branch}`)).toBe('');
  });

  it('falls back to the legacy fixed path from the project name', () => {
    const repo = makeRepo();
    const home = tmpDir('har-home-');
    const legacy = path.join(home, 'worktrees', 'proj-agent-7');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, '.env.agent.7'), 'x\n');

    const result = removeSessionWorktree({
      repoRoot: repo,
      agentId: 7,
      projectName: 'proj',
      homeDir: home,
    });
    expect(result.removedWorktree).toBe(legacy);
    expect(fs.existsSync(legacy)).toBe(false);
  });
});
