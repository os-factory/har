import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { applyLine } from '../src/harness/lines';
import { createLine } from '../src/harness/line-create';
import { writeSlotRegistry } from '../src/core/slot-registry';
import { runLineGate } from '../src/core/lines';

// A line gate runs its stages against a launched slot with the slot's
// environment, and a failed stage says why.
const PROBE =
  'echo "WORK_DIR=${WORK_DIR:-unset} ENV_FILE=${ENV_FILE:-unset} SLOT_VAR=${SLOT_VAR:-unset}" >&2';

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

function tempDir(name: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)));
}

/** Repo with alpha-line installed; its gate script runs `body`. Optionally a launched slot 1. */
function makeRepo(name: string, body: string[], launched: boolean): { repoPath: string; workDir?: string } {
  const repoPath = tempDir(name);
  fs.writeFileSync(
    path.join(repoPath, 'package.json'),
    JSON.stringify({ name: 'test-app', version: '1.0.0' }, null, 2) + '\n',
  );
  scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });
  createLine(repoPath, { id: 'alpha-line', title: 'Alpha', stations: ['S1'] });
  applyLine(repoPath, 'alpha-line');
  fs.writeFileSync(
    path.join(repoPath, '.har', 'stages', 'alpha-line-gate.sh'),
    ['#!/usr/bin/env bash', 'set -euo pipefail', ...body].join('\n') + '\n',
  );
  if (!launched) return { repoPath };

  const workDir = tempDir(`${name}-slot`);
  fs.writeFileSync(path.join(workDir, '.env.agent.1'), "AGENT_ID=1\nSLOT_VAR='from slot env'\n");
  writeSlotRegistry(repoPath, {
    agentId: 1,
    projectName: 'test-app',
    mode: 'worktree',
    workDir,
    notifyControl: false,
  });
  return { repoPath, workDir };
}

describe('line gate against a slot', () => {
  it('gives the gate stage the slot environment, so it can pass', async () => {
    const { repoPath } = makeRepo(
      'har-gate-slot-pass',
      ['test -f "$ENV_FILE" && test "$SLOT_VAR" = "from slot env" && test "$PWD" = "$WORK_DIR"'],
      true,
    );

    const result = await runLineGate({ repoPath, lineId: 'alpha-line', station: 'S1', agentId: 1 });

    expect(result.pass).toBe(true);
  });

  it('reports why a gate stage failed, from the end of its stderr', async () => {
    const { repoPath, workDir } = makeRepo('har-gate-slot-reason', ['echo "noise" >&2', PROBE, 'exit 3'], true);

    const result = await runLineGate({ repoPath, lineId: 'alpha-line', station: 'S1', agentId: 1 });

    expect(result.pass).toBe(false);
    expect(result.stages[0].reason).toBe(
      `noise\nWORK_DIR=${workDir} ENV_FILE=${path.join(workDir!, '.env.agent.1')} SLOT_VAR=from slot env`,
    );
  });

  it('prefers the output field of the stage JSON result as the reason', async () => {
    const { repoPath } = makeRepo(
      'har-gate-slot-output',
      ['echo "==> running" >&2', 'echo \'{"status":"fail","output":"TODO: implement the gate"}\'', 'exit 1'],
      true,
    );

    const result = await runLineGate({ repoPath, lineId: 'alpha-line', station: 'S1', agentId: 1 });

    expect(result.stages[0].reason).toBe('TODO: implement the gate');
  });

  it('says why when the slot was never launched', async () => {
    const { repoPath } = makeRepo('har-gate-no-slot', [PROBE, 'exit 1'], false);

    const result = await runLineGate({ repoPath, lineId: 'alpha-line', station: 'S1', agentId: 1 });

    expect(result.stages[0].reason).toContain('WORK_DIR=unset ENV_FILE=unset');
  });
});
