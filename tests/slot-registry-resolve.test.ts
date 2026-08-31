import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  getSlotRegistryPath,
  resolveSlotRegistryContext,
} from '../src/core/slot-registry';

const FIXTURE = path.join(__dirname, 'fixtures/minimal-harness');

function sh(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-slot-registry-'));
  fs.cpSync(path.join(FIXTURE, '.har'), path.join(dir, '.har'), { recursive: true });
  for (const name of ['runs', 'slots', 'work-units', 'work-attempts', 'validation-bindings']) {
    fs.rmSync(path.join(dir, '.har', name), { recursive: true, force: true });
  }
  sh(dir, 'git init -q -b main');
  sh(dir, 'git config user.email har@test.local');
  sh(dir, 'git config user.name har');
  fs.writeFileSync(path.join(dir, 'app.txt'), 'v1\n');
  sh(dir, 'git add -A');
  sh(dir, 'git commit -q -m init');
  return dir;
}

function writeActiveSlot(
  repoPath: string,
  agentId: number,
  extra: Record<string, unknown> = {},
): void {
  const file = getSlotRegistryPath(repoPath, agentId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      agentId,
      projectName: 'minimal',
      mode: 'worktree',
      workDir: repoPath,
      worktreePath: repoPath,
      branch: 'session-branch',
      createdAt: new Date().toISOString(),
      status: 'active',
      ...extra,
    }),
  );
}

function addWorktree(main: string, branch = 'session-branch'): string {
  const worktree = path.join(path.dirname(main), `${path.basename(main)}-wt`);
  sh(main, `git worktree add -q "${worktree}" -b ${branch}`);
  return worktree;
}

describe('resolveSlotRegistryContext (#331)', () => {
  it('reads the registry from the main checkout when cwd is a session worktree', () => {
    const main = initRepo();
    const worktree = addWorktree(main);
    writeActiveSlot(main, 2, { workDir: worktree, worktreePath: worktree });

    const ctx = resolveSlotRegistryContext(worktree, 2);

    expect(ctx).toBeDefined();
    expect(ctx!.harnessRoot).toBe(path.resolve(main));
    expect(ctx!.session.workDir).toBe(path.resolve(worktree));
  });

  it('prefers a registry colocated with cwd when present', () => {
    const main = initRepo();
    writeActiveSlot(main, 1);

    const ctx = resolveSlotRegistryContext(main, 1);

    expect(ctx).toEqual({
      harnessRoot: path.resolve(main),
      session: expect.objectContaining({ agentId: 1, status: 'active' }),
    });
  });

  it('returns undefined when no registry exists on main or cwd', () => {
    const main = initRepo();
    const worktree = addWorktree(main);

    expect(resolveSlotRegistryContext(worktree, 3)).toBeUndefined();
  });
});
