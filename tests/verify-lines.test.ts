import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { applyLine } from '../src/harness/lines';
import { createLine } from '../src/harness/line-create';
import { verifyLinesNextStep } from '../src/core/verify-lines';
import { renderLinesNextStep } from '../src/cli/commands/env';

function makeRepo(name: string, lines: 'none' | 'two'): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  fs.writeFileSync(
    path.join(repoPath, 'package.json'),
    JSON.stringify({ name: 'test-app', version: '1.0.0' }, null, 2) + '\n',
  );
  scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });
  if (lines === 'two') {
    applyLine(repoPath, 'example-line');
    createLine(repoPath, { id: 'alpha-line', title: 'Alpha', stations: ['S1', 'S2'], optInEnv: 'HAR_ALPHA' });
    applyLine(repoPath, 'alpha-line');
  }
  return repoPath;
}

describe('factory lines as a next step after verify', () => {
  it('lists every installed line with a command that runs it in the verified slot', () => {
    const lines = verifyLinesNextStep(makeRepo('har-vl-next', 'two'), 3);

    expect(lines).toEqual([
      {
        lineId: 'alpha-line',
        title: 'Alpha',
        scope: 'team',
        stationIds: ['S1', 'S2'],
        nextStationId: 'S1',
        allGreen: false,
        // Opt-in line: running it on purpose needs --force.
        runAll: { station: 'S2', force: true, command: 'har line gate S2 --line alpha-line --agent 3 --force' },
      },
      {
        lineId: 'example-line',
        title: 'Example factory line',
        scope: 'team',
        stationIds: ['S1', 'S2', 'S3'],
        nextStationId: 'S2',
        allGreen: false,
        runAll: { station: 'S3', force: false, command: 'har line gate S3 --line example-line --agent 3' },
      },
    ]);
  });

  it('offers nothing when no line is installed', () => {
    expect(verifyLinesNextStep(makeRepo('har-vl-none', 'none'), 1)).toEqual([]);
  });

  it('leaves out a line it cannot read and never throws', () => {
    const repoPath = makeRepo('har-vl-malformed', 'two');
    fs.writeFileSync(path.join(repoPath, '.har', 'lines', 'alpha-line', 'line.json'), '{ not json');

    expect(verifyLinesNextStep(repoPath, 1).map((line) => line.lineId)).toEqual(['example-line']);
  });

  it('renders the optional next step block', () => {
    const lines = verifyLinesNextStep(makeRepo('har-vl-render', 'two'), 1);

    expect(renderLinesNextStep(lines)).toEqual([
      'Optional next step — factory lines installed (not run by verify):',
      '  alpha-line    Alpha [team] (S1 → S2, next: S1)',
      '    har line gate S2 --line alpha-line --agent 1 --force',
      '  example-line  Example factory line [team] (S1 → S2 → S3, next: S2)',
      '    har line gate S3 --line example-line --agent 1',
      'What a line checks: har line describe <id>',
    ]);
    expect(renderLinesNextStep([])).toEqual([]);
  });
});
