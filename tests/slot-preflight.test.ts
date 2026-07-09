import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { inspectSlotReadiness } from '../src/core/slot-preflight';
import { allocateAppPorts, isPortInUse } from '../src/core/slot-ports';

const tmpDirs: string[] = [];

function makeHarness(options: { pm2?: boolean; infraDb?: boolean } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-preflight-'));
  tmpDirs.push(dir);
  const harDir = path.join(dir, '.har');
  fs.mkdirSync(harDir, { recursive: true });
  const lines = [
    'export HARNESS_PROJECT_NAME=test-project',
    'export HARNESS_FE_BASE_PORT=3000',
    'export HARNESS_API_BASE_PORT=8000',
    'export HARNESS_PORT_STEP=10',
    'export HARNESS_AGENT_SLOT_MIN=1',
    'export HARNESS_AGENT_SLOT_MAX=3',
  ];
  if (options.infraDb) {
    lines.push('export HARNESS_INFRA_SERVICES="db"');
    lines.push('export HARNESS_DB_PORT_DEFAULT=15432');
  }
  fs.writeFileSync(path.join(harDir, 'harness.env'), lines.join('\n') + '\n');
  if (options.pm2) {
    fs.writeFileSync(
      path.join(harDir, 'ecosystem.agent.template.cjs'),
      'module.exports = { apps: [] };',
    );
  }
  return dir;
}

function writeOccupiedSlot(repo: string, agentId: number, dirty = false): void {
  const worktree = path.join(repo, 'worktree');
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.env.agent.' + agentId), 'AGENT_ID=' + agentId + '\n');
  if (dirty) {
    fs.writeFileSync(path.join(worktree, 'dirty.txt'), 'x\n');
  }
  fs.mkdirSync(path.join(repo, '.har', 'slots'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.har', 'slots', `agent-${agentId}.json`),
    JSON.stringify({
      version: 1,
      agentId,
      projectName: 'test-project',
      mode: 'worktree',
      workDir: worktree,
      worktreePath: worktree,
      createdAt: new Date().toISOString(),
      status: 'active',
    }),
  );
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('inspectSlotReadiness', () => {
  it('returns ready for an empty cli harness slot', () => {
    const repo = makeHarness();
    const readiness = inspectSlotReadiness(repo, 1);
    expect(readiness.canLaunch).toBe(true);
    expect(readiness.verdict).toBe('ready');
    expect(readiness.blockers).toHaveLength(0);
  });

  it('blocks when slot is occupied without confirmReplace', () => {
    const repo = makeHarness();
    writeOccupiedSlot(repo, 1);
    const readiness = inspectSlotReadiness(repo, 1);
    expect(readiness.canLaunch).toBe(false);
    expect(readiness.blockers.some((b) => b.code === 'slot_occupied')).toBe(true);
  });

  it('allows occupied slot when confirmReplace is set', () => {
    const repo = makeHarness();
    writeOccupiedSlot(repo, 1);
    const readiness = inspectSlotReadiness(repo, 1, { confirmReplace: true });
    expect(readiness.canLaunch).toBe(true);
  });

  it('allocates app ports for PM2 harnesses', () => {
    const repo = makeHarness({ pm2: true });
    const readiness = inspectSlotReadiness(repo, 2);
    expect(readiness.canLaunch).toBe(true);
    expect(readiness.ports?.frontend).toBe(3020);
    expect(readiness.ports?.api).toBe(8020);
  });
});

describe('allocateAppPorts', () => {
  it('returns defaults when ports are free', () => {
    const repo = makeHarness({ pm2: true });
    const ports = allocateAppPorts(repo, 1);
    expect('error' in ports).toBe(false);
    if (!('error' in ports)) {
      expect(ports.frontend).toBe(3010);
      expect(ports.api).toBe(8010);
      expect(ports.allocated).toBe(false);
    }
  });
});

describe('isPortInUse', () => {
  it('returns false for a high ephemeral port unlikely to be bound', () => {
    expect(isPortInUse(59999)).toBe(false);
  });
});
