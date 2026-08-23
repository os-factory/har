import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getEnvironmentStatus,
  launchEnvironment,
  teardownEnvironment,
} from '../src/core/run-service';
import { createWorkAttempt, findWorkUnit, upsertWorkUnit, decideWorkUnitOutcome } from '../src/core/work-units';
import { getSlotRegistryPath } from '../src/core/slot-registry';

const FIXTURE = path.join(__dirname, 'fixtures/minimal-harness');

function makeTempRepo(): string {
  const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'har-surface-bugs-'));
  fs.cpSync(path.join(FIXTURE, '.har'), path.join(tempRepo, '.har'), { recursive: true });
  // Other suites run stages against the fixture directly and leave run/slot
  // records behind — drop that transient state so assertions see only ours.
  for (const dir of ['runs', 'slots', 'work-units', 'work-attempts', 'validation-bindings']) {
    fs.rmSync(path.join(tempRepo, '.har', dir), { recursive: true, force: true });
  }
  return tempRepo;
}

function readRunRecords(repoPath: string): Array<Record<string, unknown>> {
  const runsDir = path.join(repoPath, '.har', 'runs');
  const records: Array<Record<string, unknown>> = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) {
        records.push(JSON.parse(fs.readFileSync(full, 'utf8')));
      }
    }
  };
  walk(runsDir);
  return records;
}

function writeSlotRegistryEntry(
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
      mode: 'root',
      workDir: repoPath,
      createdAt: new Date().toISOString(),
      status: 'active',
      ...extra,
    }),
  );
}

describe('MCP launch trigger parity (#228)', () => {
  it('records trigger:"mcp" when launch is invoked from MCP', async () => {
    const tempRepo = makeTempRepo();
    const result = await launchEnvironment({
      repoPath: tempRepo,
      agentId: 1,
      capture: true,
      trigger: 'mcp',
    });
    expect(result.code).toBe(0);
    const launches = readRunRecords(tempRepo).filter((r) => r.kind === 'launch');
    expect(launches.length).toBeGreaterThan(0);
    expect(launches.every((r) => r.trigger === 'mcp')).toBe(true);
  }, 20_000);

  it('defaults to trigger:"cli" when no trigger is given', async () => {
    const tempRepo = makeTempRepo();
    const result = await launchEnvironment({ repoPath: tempRepo, agentId: 1, capture: true });
    expect(result.code).toBe(0);
    const launches = readRunRecords(tempRepo).filter((r) => r.kind === 'launch');
    expect(launches.length).toBeGreaterThan(0);
    expect(launches.every((r) => r.trigger === 'cli')).toBe(true);
  }, 20_000);
});

describe('status execution (#228)', () => {
  // The fixture agent-cli.sh rejects extra args, so the old duplicated
  // `status status` invocation fails this test.
  it('runs the status stage without a duplicated subcommand arg', async () => {
    const tempRepo = makeTempRepo();
    const result = await getEnvironmentStatus({ repoPath: tempRepo, agentId: 1, capture: true });
    expect(result.stderr).not.toContain('unexpected extra args');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Agent 1 running');
  }, 20_000);
});

describe('teardown closes the open work attempt (#228)', () => {
  const attemptId = '00000000-0000-4000-8000-000000000228';

  it('marks an undecided work unit abandoned on teardown', async () => {
    const tempRepo = makeTempRepo();
    upsertWorkUnit(tempRepo, { workUnitId: 'gh-228', source: 'github' });
    createWorkAttempt(tempRepo, { attemptId, workUnitId: 'gh-228', agentId: 1 });
    writeSlotRegistryEntry(tempRepo, 1, { workUnitId: 'gh-228', attemptId });

    const result = await teardownEnvironment({ repoPath: tempRepo, agentId: 1, capture: true });
    expect(result.code).toBe(0);

    const workUnit = findWorkUnit(tempRepo, 'gh-228');
    expect(workUnit?.outcome?.decision).toBe('abandoned');
    expect(workUnit?.outcome?.attemptId).toBe(attemptId);
  }, 20_000);

  it('does not overwrite an already-completed outcome', async () => {
    const tempRepo = makeTempRepo();
    upsertWorkUnit(tempRepo, { workUnitId: 'gh-228-done', source: 'github' });
    createWorkAttempt(tempRepo, { attemptId, workUnitId: 'gh-228-done', agentId: 1 });
    decideWorkUnitOutcome(tempRepo, 'gh-228-done', {
      decision: 'completed',
      decidedAt: new Date().toISOString(),
      attemptId,
      validationId: '00000000-0000-4000-8000-00000000dead',
      treeHash: 'a'.repeat(40),
    });
    writeSlotRegistryEntry(tempRepo, 1, { workUnitId: 'gh-228-done', attemptId });

    const result = await teardownEnvironment({ repoPath: tempRepo, agentId: 1, capture: true });
    expect(result.code).toBe(0);

    const workUnit = findWorkUnit(tempRepo, 'gh-228-done');
    expect(workUnit?.outcome?.decision).toBe('completed');
  }, 20_000);
});
