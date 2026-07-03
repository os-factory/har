import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listSlotRegistryEntries, readSlotRegistry } from '../src/core/slot-registry';
import { resolveAgentWorkDir } from '../src/core/runs';
import { collectEnvironmentStatus } from '../src/core/slot-status';

function writeHarness(repoPath: string): string {
  const harDir = path.join(repoPath, '.har');
  fs.mkdirSync(harDir, { recursive: true });
  fs.writeFileSync(
    path.join(harDir, 'manifest.json'),
    JSON.stringify({ version: '1', generatorVersion: '0.1.0', profile: 'cli' }),
  );
  fs.writeFileSync(
    path.join(harDir, 'stages.json'),
    JSON.stringify({ version: '1', agentSlots: { min: 1, max: 2 }, stages: [] }),
  );
  fs.writeFileSync(
    path.join(harDir, 'harness.env'),
    'export HARNESS_PROJECT_NAME="test-project"\nexport HARNESS_AGENT_SLOT_MIN=1\nexport HARNESS_AGENT_SLOT_MAX=2\n',
  );
  return harDir;
}

function writeRegistryEntry(
  harDir: string,
  agentId: number,
  overrides: Record<string, unknown> = {},
): void {
  const slotsDir = path.join(harDir, 'slots');
  fs.mkdirSync(slotsDir, { recursive: true });
  fs.writeFileSync(
    path.join(slotsDir, `agent-${agentId}.json`),
    JSON.stringify({
      version: 1,
      agentId,
      projectName: 'test-project',
      mode: 'worktree',
      workDir: '/tmp/nonexistent',
      createdAt: new Date().toISOString(),
      status: 'active',
      ...overrides,
    }),
  );
}

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf8' }).trim();
}

describe('slot registry', () => {
  it('reads and lists registry entries', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-slot-registry-'));
    const harDir = writeHarness(repoPath);
    writeRegistryEntry(harDir, 1, { branch: 'main-abcd-har-agent-1-x7k2', suffix: 'x7k2' });

    const entry = readSlotRegistry(repoPath, 1);
    expect(entry?.agentId).toBe(1);
    expect(entry?.branch).toBe('main-abcd-har-agent-1-x7k2');
    expect(readSlotRegistry(repoPath, 2)).toBeUndefined();
    expect(listSlotRegistryEntries(repoPath).length).toBe(1);
  });

  it('returns undefined for invalid entries', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-slot-registry-'));
    const harDir = writeHarness(repoPath);
    const slotsDir = path.join(harDir, 'slots');
    fs.mkdirSync(slotsDir, { recursive: true });
    fs.writeFileSync(path.join(slotsDir, 'agent-1.json'), 'not json');
    expect(readSlotRegistry(repoPath, 1)).toBeUndefined();
  });

  it('resolveAgentWorkDir prefers the registry workDir', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-slot-registry-'));
    const harDir = writeHarness(repoPath);
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-workdir-'));
    writeRegistryEntry(harDir, 1, { workDir });
    expect(resolveAgentWorkDir(repoPath, 1)).toBe(workDir);
  });

  it('slot status surfaces session fields and drift from a real worktree', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-slot-drift-'));
    const harDir = writeHarness(repoPath);

    git(repoPath, 'init -b main');
    git(repoPath, 'config user.email test@example.com');
    git(repoPath, 'config user.name Test');
    fs.writeFileSync(path.join(repoPath, 'file.txt'), 'one\n');
    git(repoPath, 'add -A');
    git(repoPath, 'commit -m one');
    const baseCommit = git(repoPath, 'rev-parse HEAD');

    const worktreePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'har-worktrees-')),
      'session-worktree',
    );
    git(repoPath, `worktree add ${worktreePath} -b main-abcd-har-agent-1-x7k2`);
    writeRegistryEntry(harDir, 1, {
      workDir: worktreePath,
      worktreePath,
      branch: 'main-abcd-har-agent-1-x7k2',
      baseBranch: 'main',
      baseCommit,
      suffix: 'x7k2',
    });

    // main gains a commit after launch → the session is stale
    fs.writeFileSync(path.join(repoPath, 'file.txt'), 'two\n');
    git(repoPath, 'add -A');
    git(repoPath, 'commit -m two');
    // uncommitted edit inside the worktree → dirty
    fs.writeFileSync(path.join(worktreePath, 'wip.txt'), 'wip\n');

    const status = collectEnvironmentStatus(repoPath);
    const slot = status.slots[0];
    expect(slot.active).toBe(true);
    expect(slot.workDir).toBe(worktreePath);
    expect(slot.worktreePath).toBe(worktreePath);
    expect(slot.branch).toBe('main-abcd-har-agent-1-x7k2');
    expect(slot.baseBranch).toBe('main');
    expect(slot.baseCommit).toBe(baseCommit);
    expect(slot.detachedHead).toBe(false);
    expect(slot.dirty).toBe(true);
    expect(slot.ahead).toBe(0);
    expect(slot.behind).toBe(1);
    expect(slot.stale).toBe(true);

    // slot 2 has no session
    expect(status.slots[1].active).toBe(false);
    expect(status.slots[1].worktreePath).toBeUndefined();
  });
});
