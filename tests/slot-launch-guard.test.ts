import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { checkLaunchGuard } from '../src/core/slot-launch-guard';

function initGitRepo(repoPath: string): void {
  execSync('git init -q', { cwd: repoPath });
  execSync('git config user.email test@example.com', { cwd: repoPath });
  execSync('git config user.name Test', { cwd: repoPath });
  execSync('git commit --allow-empty -q -m init', { cwd: repoPath });
}

function writeSlotRegistry(
  harDir: string,
  agentId: number,
  worktreePath: string,
  status: 'active' | 'failed' | 'starting' = 'active',
): void {
  const slotsDir = path.join(harDir, 'slots');
  fs.mkdirSync(slotsDir, { recursive: true });
  fs.writeFileSync(
    path.join(slotsDir, `agent-${agentId}.json`),
    JSON.stringify(
      {
        version: 1,
        agentId,
        projectName: 'test',
        mode: 'worktree',
        workDir: worktreePath,
        worktreePath,
        branch: 'session-branch',
        createdAt: '2026-01-01T00:00:00Z',
        status,
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(worktreePath, '.env.agent.1'), 'AGENT_ID=1\n');
}

function setupHarness(prefix: string): { repoPath: string; harDir: string } {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const harDir = path.join(repoPath, '.har');
  fs.mkdirSync(harDir, { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, 'fixtures/minimal-harness/.har/harness.env'),
    path.join(harDir, 'harness.env'),
  );
  fs.copyFileSync(
    path.join(__dirname, 'fixtures/minimal-harness/.har/stages.json'),
    path.join(harDir, 'stages.json'),
  );
  return { repoPath, harDir };
}

describe('slot launch guard', () => {
  it('allows launch when the slot is free', () => {
    const { repoPath } = setupHarness('har-guard-free-');

    const result = checkLaunchGuard(repoPath, 1, {});
    expect(result.allowed).toBe(true);
  });

  it('always blocks launch when the slot is occupied', () => {
    const { repoPath, harDir } = setupHarness('har-guard-block-');

    initGitRepo(repoPath);
    const worktreePath = path.join(os.tmpdir(), `har-guard-wt-${Date.now()}`);
    execSync(`git worktree add -b session-branch ${worktreePath}`, { cwd: repoPath });
    writeSlotRegistry(harDir, 1, worktreePath);
    // Commit the session marker so the worktree reads as clean for this assertion.
    execSync('git add -A && git commit -q -m session', { cwd: worktreePath });

    const result = checkLaunchGuard(repoPath, 1, {});
    expect(result.allowed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.slot?.worktreePath).toBe(worktreePath);
    expect(result.reason).toContain('already in use');
    expect(result.reason).not.toContain('Purpose:');
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();
    const sha = execSync('git rev-parse --short HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();
    expect(result.reason).toContain(`New session will be based on: ${branch} @ ${sha}`);
    expect(result.reason).toContain('har env complete 1');
    expect(result.reason).toContain('har env teardown 1');
    expect(result.reason).toContain('har env launch 1');
    expect(result.reason).not.toContain('--replace');
    expect(result.reason).not.toContain('confirmReplace');
  });

  it('blocks an occupied dirty slot and tells the user to commit or discard first', () => {
    const { repoPath, harDir } = setupHarness('har-guard-dirty-');

    initGitRepo(repoPath);
    const worktreePath = path.join(os.tmpdir(), `har-guard-dirty-wt-${Date.now()}`);
    execSync(`git worktree add -b session-branch ${worktreePath}`, { cwd: repoPath });
    fs.writeFileSync(path.join(worktreePath, 'dirty.txt'), 'change');
    writeSlotRegistry(harDir, 1, worktreePath);

    const result = checkLaunchGuard(repoPath, 1, {});
    expect(result.allowed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('dirty');
    expect(result.reason).toContain('Commit or discard changes in the worktree');
    expect(result.reason).not.toContain('--force');
  });

  it('allows resume when the slot is failed/starting', () => {
    const { repoPath, harDir } = setupHarness('har-guard-resume-ok-');

    initGitRepo(repoPath);
    const worktreePath = path.join(os.tmpdir(), `har-guard-resume-wt-${Date.now()}`);
    execSync(`git worktree add -b session-branch ${worktreePath}`, { cwd: repoPath });
    writeSlotRegistry(harDir, 1, worktreePath, 'failed');

    const result = checkLaunchGuard(repoPath, 1, { resume: true });
    expect(result.allowed).toBe(true);
  });

  it('blocks resume when the slot is not resumable', () => {
    const { repoPath, harDir } = setupHarness('har-guard-resume-block-');

    initGitRepo(repoPath);
    const worktreePath = path.join(os.tmpdir(), `har-guard-resume-block-wt-${Date.now()}`);
    execSync(`git worktree add -b session-branch ${worktreePath}`, { cwd: repoPath });
    writeSlotRegistry(harDir, 1, worktreePath, 'active');

    const result = checkLaunchGuard(repoPath, 1, { resume: true });
    expect(result.allowed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('not resumable');
    expect(result.reason).toContain('har env teardown 1');
  });
});
