import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The bundled example gate needs a launched slot; the gate's bookkeeping is
// what is under test here, so the stage runner is stubbed.
jest.mock('../src/core/run-service', () => ({ runStage: jest.fn() }));

import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { applyLine } from '../src/harness/lines';
import { runLineGate } from '../src/core/lines';
import { listLineGateRuns, recordLineGateRun } from '../src/core/line-gates';
import { createRun } from '../src/core/runs';
import { collectLineGateRunsForSync, collectLinesForSync } from '../src/core/sync-sources';
import { runStage } from '../src/core/run-service';

const runStageMock = runStage as jest.Mock;

function makeRepo(): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'line-gates-'));
  fs.writeFileSync(path.join(repoPath, 'package.json'), '{"name":"t","version":"1.0.0"}\n');
  scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });
  applyLine(repoPath, 'example-line');
  return repoPath;
}

function setOptInEnv(repoPath: string, name: string): void {
  const programPath = path.join(repoPath, '.har', 'lines', 'example-line', 'line.json');
  const program = JSON.parse(fs.readFileSync(programPath, 'utf8'));
  program.gate.optInEnv = name;
  fs.writeFileSync(programPath, JSON.stringify(program, null, 2));
}

let repoPath: string;

beforeEach(() => {
  runStageMock.mockReset();
  repoPath = makeRepo();
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe('line gate records', () => {
  it('tags each stage run with the line and records the gate run', async () => {
    const runId = crypto.randomUUID();
    runStageMock.mockResolvedValue({ status: 'pass', durationMs: 12, data: { runId } });

    const result = await runLineGate({ repoPath, station: 'S2', agentId: 1 });

    expect(runStageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stageId: 'example-gate',
        line: { lineId: 'example-line', stationId: 'S2', gateRunId: result.gateRunId },
      }),
    );

    const [record] = listLineGateRuns(repoPath);
    expect(record).toMatchObject({
      gateRunId: result.gateRunId,
      lineId: 'example-line',
      stationId: 'S2',
      scope: 'team',
      agentId: 1,
      pass: true,
      skipped: false,
      stages: [{ stageId: 'example-gate', fromStation: 'S2', status: 'pass', runId, durationMs: 12 }],
    });
    expect(record.relativePath).toMatch(/^\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}-\d{2}_example-line_S2\.json$/);
    expect(result.stages[0].runId).toBe(runId);
  });

  it('records a skipped gate, which writes no run records', async () => {
    setOptInEnv(repoPath, 'HAR_TEST_LINE_GATE_OPT_IN');
    delete process.env.HAR_TEST_LINE_GATE_OPT_IN;

    const result = await runLineGate({ repoPath, station: 'S3' });

    expect(runStageMock).not.toHaveBeenCalled();
    expect(result.skipped).toBe(true);
    const [record] = listLineGateRuns(repoPath);
    expect(record).toMatchObject({
      gateRunId: result.gateRunId,
      stationId: 'S3',
      skipped: true,
      pass: true,
      skipReason: expect.stringContaining('HAR_TEST_LINE_GATE_OPT_IN'),
      stages: [{ stageId: 'example-gate', status: 'skipped' }],
    });
  });

  it('records a failing gate when a stage throws, then rethrows', async () => {
    runStageMock.mockRejectedValue(new Error('boom'));

    await expect(runLineGate({ repoPath, station: 'S2', agentId: 1 })).rejects.toThrow('boom');

    const [record] = listLineGateRuns(repoPath);
    expect(record).toMatchObject({
      pass: false,
      skipped: false,
      stages: [{ stageId: 'example-gate', status: 'error' }],
    });
  });

  it('keeps gate records out of git', () => {
    recordLineGateRun({
      gateRunId: crypto.randomUUID(),
      lineId: 'example-line',
      stationId: 'S1',
      repoPath,
      stages: [],
      pass: true,
      skipped: false,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
    const gitignore = fs.readFileSync(path.join(repoPath, '.har', '.gitignore'), 'utf8');
    expect(gitignore.split('\n')).toContain('line-gates/');
  });

  it('lists gate runs newest first and filters by line', () => {
    const base = { lineId: 'example-line', repoPath, stages: [], pass: true, skipped: false };
    recordLineGateRun({
      ...base,
      gateRunId: crypto.randomUUID(),
      stationId: 'S1',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
    });
    recordLineGateRun({
      ...base,
      gateRunId: crypto.randomUUID(),
      stationId: 'S2',
      startedAt: '2026-01-02T00:00:00.000Z',
      finishedAt: '2026-01-02T00:00:01.000Z',
    });

    expect(listLineGateRuns(repoPath).map((r) => r.stationId)).toEqual(['S2', 'S1']);
    expect(listLineGateRuns(repoPath, { lineId: 'other' })).toEqual([]);
  });
});

describe('run records', () => {
  it('persist the line context they ran under', () => {
    const line = { lineId: 'example-line', stationId: 'S2', gateRunId: crypto.randomUUID() };
    const run = createRun({ repoPath, line }, { stageId: 'example-gate' });
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(repoPath, '.har', 'runs', run.relativePath!), 'utf8'),
    );
    expect(onDisk.line).toEqual(line);
  });
});

describe('portal sync of lines', () => {
  function gate(scope: 'team' | 'personal', stationId: string) {
    return recordLineGateRun({
      gateRunId: crypto.randomUUID(),
      lineId: 'example-line',
      stationId,
      scope,
      repoPath,
      stages: [],
      pass: true,
      skipped: false,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
  }

  it('sends team lines with their program', () => {
    const [line] = collectLinesForSync(repoPath);
    expect(line).toMatchObject({ id: 'example-line', program: { id: 'example-line' } });
    expect(line.programHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('leaves personal lines and their gate runs out', () => {
    const personalRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'line-gates-personal-'));
    try {
      fs.writeFileSync(path.join(personalRepo, 'package.json'), '{"name":"t","version":"1.0.0"}\n');
      scaffoldHarnessBoilerplate(personalRepo, { force: true, profile: 'cli' });
      applyLine(personalRepo, 'example-line', { scope: 'personal' });
      expect(collectLinesForSync(personalRepo)).toEqual([]);
    } finally {
      fs.rmSync(personalRepo, { recursive: true, force: true });
    }

    gate('team', 'S1');
    gate('personal', 'S2');
    expect(collectLineGateRunsForSync([repoPath]).map((r) => r.stationId)).toEqual(['S1']);
  });
});
