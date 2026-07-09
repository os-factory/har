import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkLaunchGuard } from '../src/core/slot-launch-guard-occupied';
import { isSlotResumable, readSlotRegistry } from '../src/core/slot-registry';
import { collectEnvironmentStatus } from '../src/core/slot-status';
import { inspectSlotReadiness } from '../src/core/slot-preflight';

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

describe('slot resume', () => {
  it('isSlotResumable accepts failed and starting only', () => {
    expect(isSlotResumable({ status: 'failed' } as never)).toBe(true);
    expect(isSlotResumable({ status: 'starting' } as never)).toBe(true);
    expect(isSlotResumable({ status: 'active' } as never)).toBe(false);
    expect(isSlotResumable(undefined)).toBe(false);
  });

  it('blocks normal launch for failed slots with resume remediation', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-resume-'));
    const harDir = writeHarness(repoPath);
    writeRegistryEntry(harDir, 1, {
      status: 'failed',
      lastError: 'launch.sh exited with code 1',
      workDir: '/tmp/work',
    });

    const guard = checkLaunchGuard(repoPath, 1, {});
    expect(guard.allowed).toBe(false);
    expect(guard.reason).toContain('--resume');

    const readiness = inspectSlotReadiness(repoPath, 1);
    expect(readiness.canLaunch).toBe(false);
    expect(readiness.blockers[0]?.code).toBe('slot_resumable');
    expect(readiness.blockers[0]?.remediation).toContain('--resume');
  });

  it('allows resume launch for failed slots', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-resume-'));
    const harDir = writeHarness(repoPath);
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-workdir-'));
    writeRegistryEntry(harDir, 1, {
      status: 'failed',
      workDir,
      worktreePath: workDir,
    });
    fs.writeFileSync(path.join(workDir, '.env.agent.1'), 'AGENT_ID=1\n');

    const guard = checkLaunchGuard(repoPath, 1, { resume: true });
    expect(guard.allowed).toBe(true);
  });

  it('rejects resume when session is active', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-resume-'));
    const harDir = writeHarness(repoPath);
    writeRegistryEntry(harDir, 1, { status: 'active' });

    const guard = checkLaunchGuard(repoPath, 1, { resume: true });
    expect(guard.allowed).toBe(false);
    expect(guard.reason).toContain('not resumable');
  });

  it('status surfaces resumeHint for failed sessions', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-resume-'));
    const harDir = writeHarness(repoPath);
    writeRegistryEntry(harDir, 1, {
      status: 'failed',
      lastError: 'port conflict',
    });

    const slot = collectEnvironmentStatus(repoPath).slots[0];
    expect(slot.sessionStatus).toBe('failed');
    expect(slot.resumeHint).toContain('--resume');
    expect(readSlotRegistry(repoPath, 1)?.status).toBe('failed');
  });
});
