import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { applyLine } from '../src/harness/lines';
import { createLine } from '../src/harness/line-create';
import { AmbiguousLineError, listLineCandidates, runLineGate } from '../src/core/lines';
import { runLineGateWithPicker } from '../src/cli/commands/line';

// line.ts imports inquirer for the TTY picker; tests inject the picker instead.
jest.mock('inquirer', () => ({ __esModule: true, default: { prompt: jest.fn() } }));

function makeRepoWithTwoLines(name: string): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  fs.writeFileSync(
    path.join(repoPath, 'package.json'),
    JSON.stringify({ name: 'test-app', version: '1.0.0' }, null, 2) + '\n',
  );
  scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });
  applyLine(repoPath, 'example-line');
  createLine(repoPath, { id: 'alpha-line', title: 'Alpha', stations: ['S1', 'S2'] });
  applyLine(repoPath, 'alpha-line');
  return repoPath;
}

describe('line picker (several lines installed)', () => {
  it('lists every installed line with its next station', () => {
    const repoPath = makeRepoWithTwoLines('har-line-candidates');
    const candidates = listLineCandidates(repoPath);

    expect(candidates.map((c) => c.lineId).sort()).toEqual(['alpha-line', 'example-line']);
    expect(candidates.find((c) => c.lineId === 'example-line')).toMatchObject({
      title: 'Example factory line',
      nextStationId: 'S2',
      allGreen: false,
    });
    expect(candidates.find((c) => c.lineId === 'alpha-line')).toMatchObject({ title: 'Alpha' });
  });

  it('core refuses to guess and carries the candidates in the error', async () => {
    const repoPath = makeRepoWithTwoLines('har-line-ambiguous');

    const failure = await runLineGate({ repoPath, station: 'S1' }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(AmbiguousLineError);
    const ambiguous = failure as AmbiguousLineError;
    expect(ambiguous.candidates).toHaveLength(2);
    expect(ambiguous.message).toMatch(/Pass --line <id>/);
    expect(ambiguous.message).toMatch(/example-line — Example factory line {2}\(next: S2\)/);
    expect(ambiguous.message).toMatch(/alpha-line — Alpha/);
  });

  it('keeps listing every line when one program is missing (stale ledger)', async () => {
    const repoPath = makeRepoWithTwoLines('har-line-stale');
    fs.rmSync(path.join(repoPath, '.har', 'lines', 'alpha-line'), { recursive: true, force: true });

    const failure = await runLineGate({ repoPath, station: 'S1' }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(AmbiguousLineError);
    const ambiguous = failure as AmbiguousLineError;
    const stale = ambiguous.candidates.find((c) => c.lineId === 'alpha-line');
    expect(stale?.allGreen).toBe(false);
    expect(stale?.nextStationId).toBeUndefined();
    expect(ambiguous.message).toMatch(/alpha-line — \(unreadable — see "har line status alpha-line"\) {2}\(status unavailable\)/);
    expect(ambiguous.message).toMatch(/example-line — Example factory line {2}\(next: S2\)/);
  });

  it('asks the picker and runs the gate for the chosen line', async () => {
    const repoPath = makeRepoWithTwoLines('har-line-pick');
    const pick = jest.fn(async () => 'example-line');

    const result = await runLineGateWithPicker({ repoPath, station: 'S1' }, pick);

    expect(pick).toHaveBeenCalledTimes(1);
    const offered = (pick.mock.calls[0] as unknown[])[0] as { lineId: string }[];
    expect(offered.map((c) => c.lineId).sort()).toEqual(['alpha-line', 'example-line']);
    expect(result.lineId).toBe('example-line');
    expect(result.station).toBe('S1');
  });

  it('never asks the picker when --line is given', async () => {
    const repoPath = makeRepoWithTwoLines('har-line-explicit');
    const pick = jest.fn(async () => 'alpha-line');

    const result = await runLineGateWithPicker(
      { repoPath, station: 'S1', lineId: 'example-line' },
      pick,
    );

    expect(pick).not.toHaveBeenCalled();
    expect(result.lineId).toBe('example-line');
  });

  it('without a picker (non-interactive) still fails with the details', async () => {
    const repoPath = makeRepoWithTwoLines('har-line-no-picker');

    await expect(runLineGateWithPicker({ repoPath, station: 'S1' })).rejects.toBeInstanceOf(
      AmbiguousLineError,
    );
  });

  it('CLI without a terminal exits non-zero and lists every line', () => {
    const repoPath = makeRepoWithTwoLines('har-line-cli-picker');
    const cli = path.join(__dirname, '..', 'dist', 'index.js');

    const result = spawnSync(process.execPath, [cli, 'line', 'gate', 'S1', '--repo', repoPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(result.status).not.toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(/Pass --line <id>/);
    expect(output).toMatch(/example-line — Example factory line {2}\(next: S2\)/);
    expect(output).toMatch(/alpha-line — Alpha/);
  });
});
