import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getEnvironmentStatus, launchEnvironment, runStage } from '../src/core/run-service';
import { collectEnvironmentStatus, renderEnvironmentStatusText } from '../src/core/slot-status';
import { getSlotRegistryPath } from '../src/core/slot-registry';
import { synthesizeStageRegistry } from '../src/harness/stages';


// #234: launch/teardown/setup/verify/agent ops run in the package runtime.
// Stub the pipelines: these suites assert the run-service surface (records,
// triggers, work units), not the runtime internals (covered in tests/runtime-*).
jest.mock('../src/runtime', () => {
  const actual = jest.requireActual('../src/runtime');
  return {
    ...actual,
    launchSession: jest.fn(async () => ({ code: 0 })),
    teardownSession: jest.fn(async (options: { agentId: number; out?: (line: string) => void }) => {
      options.out?.(`==> Tearing down agent ${options.agentId}...`);
      return { code: 0 };
    }),
    runSetupInfra: jest.fn(async () => ({ code: 0 })),
    runAgentOp: jest.fn(
      async (options: { agentId: number; command: string; out?: (line: string) => void }) => {
        options.out?.(
          options.command === 'logs'
            ? `log line for agent ${options.agentId}`
            : `Agent ${options.agentId} running`,
        );
        return { code: 0 };
      },
    ),
    buildVerifyPlan: jest.fn((_repo: string, agentId: number) => ({
      shellCommand:
        "echo '" +
        JSON.stringify({ status: 'pass', agent_id: agentId, total_ms: 10, stages: [{ name: 'smoke', pass: true }] }) +
        "'",
      cwd: process.cwd(),
      env: process.env,
    })),
  };
});

const FIXTURE = path.join(__dirname, 'fixtures/minimal-harness');

function makeTempRepo(prefix: string): string {
  const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.cpSync(path.join(FIXTURE, '.har'), path.join(tempRepo, '.har'), { recursive: true });
  for (const dir of ['runs', 'slots', 'work-units', 'work-attempts']) {
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
      else if (entry.name.endsWith('.json')) records.push(JSON.parse(fs.readFileSync(full, 'utf8')));
    }
  };
  walk(runsDir);
  return records;
}

function writeSlotRegistryEntry(
  repoPath: string,
  agentId: number,
  status: 'starting' | 'active' | 'failed' | 'completed',
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
      branch: 'session-branch',
      createdAt: new Date().toISOString(),
      status,
    }),
  );
}

describe('run service parity', () => {
  it(
    'launchEnvironment matches runStage launch preview URLs',
    async () => {
      const legacy = await launchEnvironment({ repoPath: FIXTURE, agentId: 1, capture: true });
      const generic = await runStage({
        repoPath: FIXTURE,
        kind: 'launch',
        agentId: 1,
        capture: true,
      });

      expect(legacy.code).toBe(0);
      expect(generic.status).toBe('pass');
      expect(legacy.previewUrls?.api).toBe('http://localhost:8010');
      expect(generic.urls?.some((u) => u.label === 'api' && u.url === 'http://localhost:8010')).toBe(
        true,
      );
    },
    20_000,
  );

  it('substitutes {agentId} in command-based stages', async () => {
    const result = await runStage({
      repoPath: FIXTURE,
      stageId: 'logs',
      agentId: 2,
      capture: true,
    });
    const stdout =
      result.logs?.find((log) => log.stream === 'stdout')?.content ??
      result.logs?.[0]?.content ??
      '';
    expect(stdout).toContain('log line for agent 2');
  });

  it('persists a run record under .har/runs', async () => {
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'har-run-record-'));
    fs.cpSync(path.join(FIXTURE, '.har'), path.join(tempRepo, '.har'), { recursive: true });

    const result = await runStage({
      repoPath: tempRepo,
      kind: 'launch',
      agentId: 1,
      capture: true,
    });

    const runId =
      typeof result.data === 'object' &&
      result.data !== null &&
      !Array.isArray(result.data) &&
      typeof (result.data as { runId?: string }).runId === 'string'
        ? (result.data as { runId: string }).runId
        : null;

    expect(runId).toBeTruthy();

    const runsDir = path.join(tempRepo, '.har', 'runs');
    const allFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.json')) allFiles.push(full);
      }
    };
    walk(runsDir);
    expect(allFiles.length).toBeGreaterThan(0);
    expect(allFiles.some((f) => f.includes('launch_agent-1.json'))).toBe(true);
  });
});

describe('trigger tagging parity (#233)', () => {
  it('tags run records with the surface trigger for generic stages', async () => {
    const tempRepo = makeTempRepo('har-trigger-parity-');

    await runStage({ repoPath: tempRepo, stageId: 'logs', agentId: 1, capture: true, trigger: 'mcp' });
    await runStage({ repoPath: tempRepo, stageId: 'logs', agentId: 2, capture: true, trigger: 'cli' });

    const records = readRunRecords(tempRepo).filter((r) => r.stageId === 'logs');
    expect(records.find((r) => r.agentId === 1)?.trigger).toBe('mcp');
    expect(records.find((r) => r.agentId === 2)?.trigger).toBe('cli');
  }, 20_000);
});

describe('status parity (#233)', () => {
  it('renders text from the same structured source on every surface and writes no run records', async () => {
    const tempRepo = makeTempRepo('har-status-parity-');
    writeSlotRegistryEntry(tempRepo, 1, 'active');

    const result = await getEnvironmentStatus({ repoPath: tempRepo, capture: true });
    const structured = collectEnvironmentStatus(tempRepo);

    // Same structured source: identical slot set and identical text rendering.
    expect(result.status.slots.map((s) => s.agentId)).toEqual(
      structured.slots.map((s) => s.agentId),
    );
    expect(result.stdout).toBe(
      renderEnvironmentStatusText({ ...structured, generatedAt: result.status.generatedAt }),
    );
    expect(result.status.slots.find((s) => s.agentId === 1)?.active).toBe(true);
    expect(result.stdout).toContain('Agent 1');
    // Remote URLs can embed credentials — the text view must never include them.
    if (structured.gitRemote) expect(result.stdout).not.toContain(structured.gitRemote);

    // Run-record policy is identical across CLI text, CLI --json, and MCP: none.
    expect(readRunRecords(tempRepo)).toHaveLength(0);
  }, 30_000);

  it('filters to one slot when agentId is given', async () => {
    const tempRepo = makeTempRepo('har-status-one-slot-');
    const result = await getEnvironmentStatus({ repoPath: tempRepo, agentId: 3, capture: true });
    expect(result.status.slots.map((s) => s.agentId)).toEqual([3]);
  }, 30_000);
});

describe('launch guard parity (#233)', () => {
  it('blocks an occupied slot inside run-service (no CLI-layer guard needed)', async () => {
    const tempRepo = makeTempRepo('har-guard-occupied-');
    writeSlotRegistryEntry(tempRepo, 1, 'active');

    const result = await launchEnvironment({ repoPath: tempRepo, agentId: 1, capture: true });
    expect(result.blocked).toBe(true);
    expect(result.code).toBe(2);
    expect(readRunRecords(tempRepo).filter((r) => r.kind === 'launch')).toHaveLength(0);
  }, 20_000);

  it('applies the guard on resume too: an active slot cannot be resumed', async () => {
    const tempRepo = makeTempRepo('har-guard-resume-active-');
    writeSlotRegistryEntry(tempRepo, 1, 'active');

    const result = await launchEnvironment({
      repoPath: tempRepo,
      agentId: 1,
      resume: true,
      capture: true,
    });
    expect(result.blocked).toBe(true);
  }, 20_000);

  it('allows resuming a failed session', async () => {
    const tempRepo = makeTempRepo('har-guard-resume-failed-');
    writeSlotRegistryEntry(tempRepo, 1, 'failed');

    const result = await launchEnvironment({
      repoPath: tempRepo,
      agentId: 1,
      resume: true,
      capture: true,
    });
    expect(result.blocked).toBeUndefined();
    expect(result.code).toBe(0);
  }, 20_000);
});

describe('synthesizeStageRegistry fallback', () => {
  it('builds command-based stages when stages.json is missing', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-synth-'));
    fs.cpSync(path.join(FIXTURE, '.har'), path.join(repoPath, '.har'), { recursive: true });
    fs.unlinkSync(path.join(repoPath, '.har', 'stages.json'));

    const registry = synthesizeStageRegistry(repoPath);
    expect(registry.stages.map((stage) => stage.id)).toEqual(
      expect.arrayContaining(['launch', 'verify', 'status', 'logs', 'teardown']),
    );
  });
});

describe('doctor gate before launch (#232)', () => {
  it('blocks launch with actionable findings when the harness contract is broken', async () => {
    const tempRepo = makeTempRepo('har-doctor-gate-');
    const stagesPath = path.join(tempRepo, '.har', 'stages.json');
    const registry = JSON.parse(fs.readFileSync(stagesPath, 'utf8'));
    registry.verificationStages = ['phantom-stage'];
    fs.writeFileSync(stagesPath, JSON.stringify(registry));

    const result = await launchEnvironment({ repoPath: tempRepo, agentId: 1, capture: true });
    expect(result.blocked).toBe(true);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('phantom-stage');
    expect(result.stderr).toContain('har env doctor');
  });

  it('lets a healthy harness pass the doctor gate', async () => {
    const tempRepo = makeTempRepo('har-doctor-gate-ok-');
    const result = await launchEnvironment({ repoPath: tempRepo, agentId: 1, capture: true });
    expect(result.stderr || '').not.toContain('Launch blocked by harness doctor');
  });
});
