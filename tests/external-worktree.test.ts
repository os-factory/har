import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { removeSessionWorktree, resolveResumeSession } from '../src/runtime/worktree';
import { detectInPlaceSlotMode, resolveWorktreeRoot } from '../src/core/worktree-ownership';

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

/** A repo plus a linked worktree standing in for an external orchestrator's. */
function makeRepoWithExternalWorktree(): { repo: string; external: string } {
  const repo = tmpDir('har-external-');
  git(repo, 'init -q -b main');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'x\n');
  git(repo, 'add tracked.txt');
  git(repo, 'commit -qm init');

  const external = path.join(tmpDir('har-external-ws-'), 'ext');
  git(repo, `worktree add -q -b ext ${external}`);
  return { repo, external };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('detectInPlaceSlotMode', () => {
  it('reports root for the main checkout', () => {
    const { repo } = makeRepoWithExternalWorktree();
    expect(detectInPlaceSlotMode(repo)).toBe('root');
  });

  it('reports external for a worktree HAR did not create', () => {
    const { external } = makeRepoWithExternalWorktree();
    expect(detectInPlaceSlotMode(external)).toBe('external');
  });

  it('reports root outside a git work tree', () => {
    expect(detectInPlaceSlotMode(tmpDir('har-nogit-'))).toBe('root');
  });

  it('resolves the worktree checkout root', () => {
    const { external } = makeRepoWithExternalWorktree();
    expect(resolveWorktreeRoot(external)).toBe(fs.realpathSync(external));
  });
});

describe('removeSessionWorktree ownership guard (#254)', () => {
  it('never removes an externally-owned worktree', () => {
    const { repo, external } = makeRepoWithExternalWorktree();
    fs.writeFileSync(path.join(external, 'uncommitted.txt'), 'precious\n');

    const result = removeSessionWorktree({
      repoRoot: repo,
      agentId: 1,
      worktreePath: external,
      mode: 'external',
      branch: 'ext',
    });

    expect(fs.existsSync(external)).toBe(true);
    expect(fs.existsSync(path.join(external, 'uncommitted.txt'))).toBe(true);
    expect(result.removedWorktree).toBeUndefined();
    expect(result.preservedWorktree).toBe(external);
    // Branch handling is unchanged — kept by default.
    expect(result.keptBranch).toBe('ext');
  });

  it('does not act on the legacy guessed path in root mode', () => {
    const { repo } = makeRepoWithExternalWorktree();
    const home = tmpDir('har-home-');
    const guessed = path.join(home, 'worktrees', 'proj-agent-1');
    fs.mkdirSync(guessed, { recursive: true });

    const result = removeSessionWorktree({
      repoRoot: repo,
      agentId: 1,
      projectName: 'proj',
      mode: 'root',
      homeDir: home,
    });

    expect(fs.existsSync(guessed)).toBe(true);
    expect(result.removedWorktree).toBeUndefined();
  });

  it('still removes a worktree HAR created', () => {
    const repo = tmpDir('har-owned-');
    git(repo, 'init -q -b main');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'x\n');
    git(repo, 'add tracked.txt');
    git(repo, 'commit -qm init');
    const owned = path.join(tmpDir('har-owned-wt-'), 'session');
    git(repo, `worktree add -q -b session ${owned}`);

    const result = removeSessionWorktree({
      repoRoot: repo,
      agentId: 1,
      worktreePath: owned,
      mode: 'worktree',
      branch: 'session',
    });

    expect(fs.existsSync(owned)).toBe(false);
    expect(result.removedWorktree).toBe(owned);
  });

  it('keeps legacy guess-and-remove when the registry has no mode', () => {
    const repo = tmpDir('har-legacy-');
    git(repo, 'init -q -b main');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'x\n');
    git(repo, 'add tracked.txt');
    git(repo, 'commit -qm init');
    const home = tmpDir('har-legacy-home-');
    const guessed = path.join(home, 'worktrees', 'proj-agent-1');
    fs.mkdirSync(guessed, { recursive: true });

    const result = removeSessionWorktree({
      repoRoot: repo,
      agentId: 1,
      projectName: 'proj',
      homeDir: home,
    });

    expect(result.removedWorktree).toBe(guessed);
    expect(fs.existsSync(guessed)).toBe(false);
  });
});

describe('resume preserves ownership (#254)', () => {
  it('does not downgrade an external slot to root', () => {
    const { external } = makeRepoWithExternalWorktree();
    const harDir = path.join(external, '.har');
    fs.mkdirSync(path.join(harDir, 'slots'), { recursive: true });
    fs.writeFileSync(
      path.join(harDir, 'manifest.json'),
      JSON.stringify({ version: '1', generatorVersion: '0.1.0', profile: 'cli' }),
    );
    fs.writeFileSync(path.join(external, '.env.agent.1'), 'AGENT_ID=1\n');
    fs.writeFileSync(
      path.join(harDir, 'slots', 'agent-1.json'),
      JSON.stringify({
        version: 1,
        agentId: 1,
        projectName: 'p',
        mode: 'external',
        workDir: external,
        worktreePath: external,
        createdAt: new Date().toISOString(),
        status: 'starting',
      }),
    );

    const result = resolveResumeSession(external, 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.mode).toBe('external');
      // A resumed external slot must stay non-owned, so teardown keeps it.
      expect(result.session.useWorktree).toBe(false);
    }
  });
});
