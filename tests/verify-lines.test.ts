import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { applyLine } from '../src/harness/lines';
import { createLine } from '../src/harness/line-create';
import { listInstalledLineIds as listInstalledLineIdsUnsafe, runLineGate } from '../src/core/lines';
import {
  createVerifyLinesHook,
  installedLinesHint,
  listVerifyLineChoices,
  type VerifyLineChoice,
} from '../src/core/verify-lines';

// The gate runner is exercised in lines.test.ts; here we only check which
// gates the hook asks for and how it reports them.
jest.mock('../src/core/lines', () => {
  const actual = jest.requireActual('../src/core/lines');
  return { ...actual, runLineGate: jest.fn() };
});
const runLineGateMock = runLineGate as jest.MockedFunction<typeof runLineGate>;

function makeRepo(name: string, lines: 'none' | 'two'): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  fs.writeFileSync(
    path.join(repoPath, 'package.json'),
    JSON.stringify({ name: 'test-app', version: '1.0.0' }, null, 2) + '\n',
  );
  scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });
  if (lines === 'two') {
    applyLine(repoPath, 'example-line');
    createLine(repoPath, { id: 'alpha-line', title: 'Alpha', stations: ['S1', 'S2'] });
    applyLine(repoPath, 'alpha-line');
  }
  return repoPath;
}

beforeEach(() => runLineGateMock.mockReset());

describe('opt-in line gates after verify', () => {
  it('offers every installed line with the station whose gate covers all stations', () => {
    const repoPath = makeRepo('har-vl-choices', 'two');
    const choices = listVerifyLineChoices(repoPath);

    expect(choices.find((c) => c.lineId === 'example-line')).toMatchObject({
      title: 'Example factory line',
      lastStationId: 'S3',
      nextStationId: 'S2',
      allGreen: false,
    });
    expect(choices.find((c) => c.lineId === 'alpha-line')).toMatchObject({
      title: 'Alpha',
      lastStationId: 'S2',
    });
  });

  it('runs nothing when no line is chosen', async () => {
    const repoPath = makeRepo('har-vl-none-chosen', 'two');
    const choose = jest.fn(async () => [] as string[]);

    const checks = await createVerifyLinesHook({ repoPath, agentId: 2, choose })();

    expect(choose).toHaveBeenCalledTimes(1);
    expect(checks).toEqual([]);
    expect(runLineGateMock).not.toHaveBeenCalled();
  });

  it('does not ask when no line is installed', async () => {
    const repoPath = makeRepo('har-vl-no-lines', 'none');
    const choose = jest.fn(async () => [] as string[]);

    const checks = await createVerifyLinesHook({ repoPath, agentId: 2, choose })();

    expect(choose).not.toHaveBeenCalled();
    expect(checks).toEqual([]);
  });

  it('runs the last station gate of each chosen line in the verify slot, opted in', async () => {
    const repoPath = makeRepo('har-vl-pass', 'two');
    runLineGateMock.mockImplementation(async (options) => ({
      lineId: options.lineId!,
      station: options.station,
      stages: [],
      pass: true,
      skipped: false,
    }));

    const checks = await createVerifyLinesHook({
      repoPath,
      agentId: 2,
      choose: async () => ['example-line', 'alpha-line'],
    })();

    expect(runLineGateMock).toHaveBeenCalledWith(
      expect.objectContaining({ lineId: 'example-line', station: 'S3', agentId: 2, force: true }),
    );
    expect(runLineGateMock).toHaveBeenCalledWith(
      expect.objectContaining({ lineId: 'alpha-line', station: 'S2', agentId: 2, force: true }),
    );
    expect(checks).toEqual([
      { name: 'line:example-line', pass: true },
      { name: 'line:alpha-line', pass: true },
    ]);
  });

  it('names the failing line and stage', async () => {
    const repoPath = makeRepo('har-vl-fail', 'two');
    runLineGateMock.mockResolvedValue({
      lineId: 'example-line',
      station: 'S3',
      stages: [{ stageId: 'example-gate', fromStation: 'S2', status: 'fail' }],
      pass: false,
      skipped: false,
    });

    const checks = await createVerifyLinesHook({
      repoPath,
      agentId: 2,
      choose: async () => ['example-line'],
    })();

    expect(checks).toEqual([
      { name: 'line:example-line', pass: false, detail: 'example-gate (from S2): fail' },
    ]);
  });

  it('turns a gate error into a failed check instead of crashing verify', async () => {
    const repoPath = makeRepo('har-vl-throw', 'two');
    runLineGateMock.mockRejectedValue(new Error('Unknown station "S3"'));

    const checks = await createVerifyLinesHook({
      repoPath,
      agentId: 2,
      choose: async () => ['example-line'],
    })();

    expect(checks).toEqual([{ name: 'line:example-line', pass: false, detail: 'Unknown station "S3"' }]);
  });

  it('keeps a line with an unreadable program listed and fails it without running', async () => {
    const repoPath = makeRepo('har-vl-stale', 'two');
    fs.rmSync(path.join(repoPath, '.har', 'lines', 'alpha-line'), { recursive: true, force: true });
    let offered: VerifyLineChoice[] = [];

    const checks = await createVerifyLinesHook({
      repoPath,
      agentId: 2,
      choose: async (choices) => {
        offered = choices;
        return ['alpha-line'];
      },
    })();

    expect(offered.map((c) => c.lineId).sort()).toEqual(['alpha-line', 'example-line']);
    expect(offered.find((c) => c.lineId === 'alpha-line')?.unreadable).toMatch(/Line not installed/);
    expect(runLineGateMock).not.toHaveBeenCalled();
    expect(checks[0]).toMatchObject({ name: 'line:alpha-line', pass: false });
  });

  it('never breaks verify when a line file is malformed', async () => {
    const repoPath = makeRepo('har-vl-malformed', 'two');
    fs.writeFileSync(path.join(repoPath, '.har', 'lines', 'alpha-line', 'line.json'), '{ not json');
    // Sanity: the shared reader really does throw on this input.
    expect(() => listInstalledLineIdsUnsafe(repoPath)).toThrow();
    const choose = jest.fn(async () => [] as string[]);

    expect(installedLinesHint(repoPath)).toBeUndefined();
    await expect(createVerifyLinesHook({ repoPath, agentId: 2, choose })()).resolves.toEqual([]);
    expect(choose).not.toHaveBeenCalled();
  });

  it('hints at installed lines for non-interactive runs', () => {
    expect(installedLinesHint(makeRepo('har-vl-hint-none', 'none'))).toBeUndefined();
    expect(installedLinesHint(makeRepo('har-vl-hint-two', 'two'))).toBe(
      '2 factory lines installed (alpha-line, example-line) — not checked by verify. ' +
        'Run one with: har line gate <station> --line <id>',
    );
  });
});
