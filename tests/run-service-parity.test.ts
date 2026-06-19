import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchEnvironment, runStage } from '../src/core/run-service';
import { synthesizeStageRegistry } from '../src/harness/stages';

const FIXTURE = path.join(__dirname, 'fixtures/minimal-harness');

describe('run service parity', () => {
  it('launchEnvironment matches runStage launch preview URLs', async () => {
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
  });

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
    expect(fs.existsSync(path.join(tempRepo, '.har', 'runs', `${runId}.json`))).toBe(true);
  });
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
