import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { checkLaunchGuard } from '../src/core/slot-launch-guard';

function writeSlotRegistry(harDir: string, agentId: number, worktreePath: string): void {
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
        status: 'active',
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(worktreePath, '.env.agent.1'), 'AGENT_ID=1\n');
}

describe('slot launch guard', () => {
  it('allows launch when the slot is free', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-guard-free-'));
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

    const result = checkLaunchGuard(repoPath, 1, {});
    expect(result.allowed).toBe(true);
  });

  it('blocks launch when slot is occupied without confirmReplace', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-guard-block-'));
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

    execSync('git init -q', { cwd: repoPath });
    execSync('git commit --allow-empty -q -m init', { cwd: repoPath });
    const worktreePath = path.join(os.tmpdir(), `har-guard-wt-${Date.now()}`);
    execSync(`git worktree add -b session-branch ${worktreePath}`, { cwd: repoPath });
    writeSlotRegistry(harDir, 1, worktreePath);

    const result = checkLaunchGuard(repoPath, 1, {});
    expect(result.allowed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.slot?.worktreePath).toBe(worktreePath);
    expect(result.reason).toContain('already in use');
  });

  it('requires force when replacing a dirty occupied slot', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-guard-dirty-'));
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

    execSync('git init -q', { cwd: repoPath });
    execSync('git commit --allow-empty -q -m init', { cwd: repoPath });
    const worktreePath = path.join(os.tmpdir(), `har-guard-dirty-wt-${Date.now()}`);
    execSync(`git worktree add -b session-branch ${worktreePath}`, { cwd: repoPath });
    fs.writeFileSync(path.join(worktreePath, 'dirty.txt'), 'change');
    writeSlotRegistry(harDir, 1, worktreePath);

    const blocked = checkLaunchGuard(repoPath, 1, { confirmReplace: true });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain('uncommitted changes');

    const allowed = checkLaunchGuard(repoPath, 1, { confirmReplace: true, force: true });
    expect(allowed.allowed).toBe(true);
  });
});
