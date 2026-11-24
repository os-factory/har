import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { applyLine } from '../src/harness/lines';
import { createLine } from '../src/harness/line-create';
import { describeLine, listLines } from '../src/core/lines';
import { handleMcpToolCall } from '../src/mcp/server';

function makeRepo(name: string, lines: 'none' | 'two'): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  fs.writeFileSync(
    path.join(repoPath, 'package.json'),
    JSON.stringify({ name: 'test-app', version: '1.0.0' }, null, 2) + '\n',
  );
  scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });
  if (lines === 'two') {
    applyLine(repoPath, 'example-line');
    createLine(repoPath, {
      id: 'alpha-line',
      title: 'Alpha',
      description: 'Checks the alpha contract. More detail here.',
      stations: ['S1', 'S2'],
      optInEnv: 'HAR_ALPHA',
    });
    applyLine(repoPath, 'alpha-line');
  }
  return repoPath;
}

describe('har line list', () => {
  it('lists installed lines with what they cover and how to run every station', () => {
    const list = listLines(makeRepo('har-lc-list', 'two'));

    expect(list.installed.map((l) => l.lineId)).toEqual(['alpha-line', 'example-line']);
    expect(list.installed.find((l) => l.lineId === 'example-line')).toMatchObject({
      title: 'Example factory line',
      description: expect.stringContaining('three-station program'),
      stationIds: ['S1', 'S2', 'S3'],
      nextStationId: 'S2',
      allGreen: false,
      optInEnv: null,
      runAll: { station: 'S3', force: false, command: 'har line gate S3 --line example-line' },
    });
    // An opt-in line still runs when picked on purpose.
    expect(list.installed.find((l) => l.lineId === 'alpha-line')?.runAll).toEqual({
      station: 'S2',
      force: true,
      command: 'har line gate S2 --line alpha-line --force',
    });
    expect(list.available.map((l) => l.lineId)).not.toContain('example-line');
  });

  it('offers bundled lines as available when nothing is installed', () => {
    const list = listLines(makeRepo('har-lc-empty', 'none'));

    expect(list.installed).toEqual([]);
    expect(list.available).toContainEqual({ lineId: 'example-line', source: 'bundled' });
  });

  it('lists a malformed line as unreadable instead of failing', () => {
    const repoPath = makeRepo('har-lc-malformed', 'two');
    fs.writeFileSync(path.join(repoPath, '.har', 'lines', 'alpha-line', 'line.json'), '{ not json');

    const list = listLines(repoPath);

    expect(list.installed.find((l) => l.lineId === 'alpha-line')).toMatchObject({
      unreadable: expect.stringContaining('cannot read line.json'),
    });
    expect(list.installed.find((l) => l.lineId === 'example-line')?.unreadable).toBeUndefined();
  });

  it('lists a ledger line whose program was removed as unreadable', () => {
    const repoPath = makeRepo('har-lc-removed', 'two');
    fs.rmSync(path.join(repoPath, '.har', 'lines', 'alpha-line'), { recursive: true, force: true });

    expect(listLines(repoPath).installed.find((l) => l.lineId === 'alpha-line')).toMatchObject({
      unreadable: 'line.json is missing or invalid',
    });
  });
});

describe('har line describe', () => {
  it('shows stations, gate stages with descriptions, and run commands', () => {
    const line = describeLine(makeRepo('har-lc-describe', 'two'), 'example-line');

    expect(line.description).toContain('three-station program');
    expect(line.stations.map((s) => [s.id, s.title, s.gateStageIds])).toEqual([
      ['S1', 'Draft', []],
      ['S2', 'Build', ['example-gate']],
      ['S3', 'Prove', ['example-gate']],
    ]);
    expect(line.stations[0].description).toContain('Agree the contract');
    expect(line.gateStages).toEqual([
      {
        id: 'example-gate',
        fromStation: 'S2',
        description: expect.any(String),
        registered: true,
        lastRunStatus: undefined,
      },
    ]);
    expect(line.runAll?.command).toBe('har line gate S3 --line example-line');
    expect(line.runStationCommand).toBe('har line gate <station> --line example-line');
    expect(line.nextStationId).toBe('S2');
  });

  it('fails clearly for a line that is not installed', () => {
    expect(() => describeLine(makeRepo('har-lc-missing', 'none'), 'nope')).toThrow(/Line not installed: nope/);
  });
});

describe('line catalog over MCP', () => {
  it('har_line_list and har_line_describe return the core results', async () => {
    const repoPath = makeRepo('har-lc-mcp', 'two');

    const list = await handleMcpToolCall('har_line_list', { repo: repoPath });
    expect(JSON.parse(list.content[0].text)).toEqual(JSON.parse(JSON.stringify(listLines(repoPath))));

    const described = await handleMcpToolCall('har_line_describe', { repo: repoPath, line: 'alpha-line' });
    expect(JSON.parse(described.content[0].text)).toEqual(
      JSON.parse(JSON.stringify(describeLine(repoPath, 'alpha-line'))),
    );
  });
});
