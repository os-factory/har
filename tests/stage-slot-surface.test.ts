import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { applyLine } from '../src/harness/lines';
import { createLine } from '../src/harness/line-create';
import { readStageRegistry, writeStageRegistry } from '../src/harness/stages';
import { runLineGate } from '../src/core/lines';
import { runStage } from '../src/core/run';

// What a stage sees when run on its own (har env run-stage, har line gate)
// against a launched slot: the same surface `har env verify` gives it.
const PROBE = 'echo "WORK_DIR=${WORK_DIR:-unset} ENV_FILE=${ENV_FILE:-unset} AGENT_ID=${AGENT_ID:-unset} SLOT_VAR=${SLOT_VAR:-unset}" >&2';

function makeRepo(name: string, withSlotEnv: boolean): string {
  const repoPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)));
  fs.writeFileSync(
    path.join(repoPath, 'package.json'),
    JSON.stringify({ name: 'test-app', version: '1.0.0' }, null, 2) + '\n',
  );
  scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });
  if (withSlotEnv) {
    fs.writeFileSync(path.join(repoPath, '.env.agent.1'), "AGENT_ID=1\nSLOT_VAR='from slot env'\n");
  }
  return repoPath;
}

function addLineWithGate(repoPath: string, body: string[]): string {
  createLine(repoPath, { id: 'alpha-line', title: 'Alpha', stations: ['S1'] });
  applyLine(repoPath, 'alpha-line');
  const script = path.join(repoPath, '.har', 'stages', 'alpha-line-gate.sh');
  fs.writeFileSync(script, ['#!/usr/bin/env bash', 'set -euo pipefail', ...body].join('\n') + '\n');
  return script;
}

// Under `har env verify` the test process itself inherits a slot surface.
const SURFACE_VARS = ['WORK_DIR', 'ENV_FILE', 'AGENT_ID', 'HAR_AGENT_ID', 'HAR_HARNESS_DIR', 'SLOT_VAR'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const name of SURFACE_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});
afterEach(() => {
  for (const name of SURFACE_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe('stage slot surface outside verify', () => {
  it('gives a line gate stage the slot env, so it can pass', async () => {
    const repoPath = makeRepo('har-surface-pass', true);
    addLineWithGate(repoPath, [
      'test -n "$WORK_DIR" && test -f "$ENV_FILE" && test "$SLOT_VAR" = "from slot env"',
    ]);

    const result = await runLineGate({ repoPath, lineId: 'alpha-line', station: 'S1', agentId: 1 });

    expect(result.pass).toBe(true);
  });

  it('reports why a gate stage failed, from the end of its output', async () => {
    const repoPath = makeRepo('har-surface-reason', true);
    addLineWithGate(repoPath, ['echo "noise" >&2', PROBE, 'exit 3']);

    const result = await runLineGate({ repoPath, lineId: 'alpha-line', station: 'S1', agentId: 1 });

    expect(result.pass).toBe(false);
    expect(result.stages[0].reason).toBe(
      `noise\nWORK_DIR=${repoPath} ENV_FILE=${path.join(repoPath, '.env.agent.1')} AGENT_ID=1 SLOT_VAR=from slot env`,
    );
  });

  it('prefers the output field of the stage JSON result as the reason', async () => {
    const repoPath = makeRepo('har-surface-output', true);
    addLineWithGate(repoPath, [
      'echo "==> running" >&2',
      'echo \'{"status":"fail","output":"TODO: implement the gate"}\'',
      'exit 1',
    ]);

    const result = await runLineGate({ repoPath, lineId: 'alpha-line', station: 'S1', agentId: 1 });

    expect(result.stages[0].reason).toBe('TODO: implement the gate');
  });

  it('exports the surface to command stages too', async () => {
    const repoPath = makeRepo('har-surface-command', true);
    const registry = readStageRegistry(repoPath);
    registry.stages.push({
      id: 'probe',
      kind: 'custom',
      command: `${PROBE}; exit 1`,
      artifacts: [],
    });
    writeStageRegistry(repoPath, registry);

    const result = await runStage({ repoPath, stageId: 'probe', agentId: 1 });

    expect(result.logs.find((l) => l.stream === 'stderr')?.content).toContain(
      `WORK_DIR=${repoPath} ENV_FILE=${path.join(repoPath, '.env.agent.1')} AGENT_ID=1 SLOT_VAR=from slot env`,
    );
  });

  it('runs a stage as before when the slot has no env file', async () => {
    const repoPath = makeRepo('har-surface-none', false);
    addLineWithGate(repoPath, [PROBE, 'exit 1']);

    const result = await runLineGate({ repoPath, lineId: 'alpha-line', station: 'S1', agentId: 1 });

    expect(result.stages[0].reason).toContain('WORK_DIR=unset ENV_FILE=unset');
  });
});
