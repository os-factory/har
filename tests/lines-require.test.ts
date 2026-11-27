import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { applyLine } from '../src/harness/lines';
import { readLineLedger, writeLineLedger } from '../src/harness/line-ledger';
import { describeLine, getLineStatus, listLines, requireLine, unrequireLine } from '../src/core/lines';
import { readCommittedStageRegistry, writeStageOverlay, writeStageRegistry } from '../src/harness/stages';
import { runDoctor, type DoctorReport } from '../src/harness/doctor';
import { handleMcpToolCall } from '../src/mcp/server';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeGitRepo(name: string): string {
  const repoPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)));
  fs.writeFileSync(
    path.join(repoPath, 'package.json'),
    JSON.stringify({ name: 'test-app', version: '1.0.0' }, null, 2) + '\n',
  );
  scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });
  git(repoPath, 'init', '-q');
  git(repoPath, 'config', 'user.email', 'test@example.com');
  git(repoPath, 'config', 'user.name', 'Test');
  git(repoPath, 'config', 'commit.gpgsign', 'false');
  git(repoPath, 'add', '-A');
  git(repoPath, 'commit', '-q', '-m', 'init');
  return repoPath;
}

/** A repo with the bundled example line (stations S1 → S2 → S3; gate stage `example-gate` from S2). */
function repoWithTeamLine(name: string): string {
  const repo = makeGitRepo(name);
  applyLine(repo, 'example-line');
  return repo;
}

function lineFindings(report: DoctorReport, severity: 'error' | 'warning') {
  return report.findings.filter((f) => f.check === 'factory-lines' && f.severity === severity);
}

function dropCommittedStage(repo: string, stageId: string): void {
  const registry = readCommittedStageRegistry(repo);
  writeStageRegistry(repo, { ...registry, stages: registry.stages.filter((s) => s.id !== stageId) });
}

describe('har line require', () => {
  it('defaults to the last station and records the policy in the team ledger', () => {
    const repo = repoWithTeamLine('har-require-default');

    const result = requireLine(repo, 'example-line');

    expect(result).toEqual({ lineId: 'example-line', station: 'S3', ledgerPath: '.har/lines.json' });
    expect(readLineLedger(repo, 'team')?.lines[0].required).toEqual({ station: 'S3' });
    expect(runDoctor(repo).ok).toBe(true);
  });

  it('takes an explicit station and reports the one it replaced', () => {
    const repo = repoWithTeamLine('har-require-station');
    requireLine(repo, 'example-line');

    const result = requireLine(repo, 'example-line', 'S2');

    expect(result).toMatchObject({ station: 'S2', previousStation: 'S3' });
    expect(readLineLedger(repo, 'team')?.lines[0].required).toEqual({ station: 'S2' });
  });

  it('refuses a station the program does not have', () => {
    const repo = repoWithTeamLine('har-require-unknown');
    expect(() => requireLine(repo, 'example-line', 'S9')).toThrow(/Unknown station "S9".*S1, S2, S3/);
    expect(readLineLedger(repo, 'team')?.lines[0].required).toBeUndefined();
  });

  it('refuses a personal line and points at promote', () => {
    const repo = makeGitRepo('har-require-personal');
    applyLine(repo, 'example-line', { scope: 'personal' });
    expect(() => requireLine(repo, 'example-line')).toThrow(/personal.*har line promote example-line/);
  });

  it('refuses a line that is not installed', () => {
    const repo = makeGitRepo('har-require-missing');
    expect(() => requireLine(repo, 'nope')).toThrow(/Line not installed: nope/);
  });

  it('survives a forced reinstall', () => {
    const repo = repoWithTeamLine('har-require-force');
    requireLine(repo, 'example-line', 'S2');

    applyLine(repo, 'example-line', { force: true });

    expect(readLineLedger(repo, 'team')?.lines[0].required).toEqual({ station: 'S2' });
  });

  it('warns on a forced reinstall whose program no longer has the required station', () => {
    const repo = repoWithTeamLine('har-require-force-stale');
    const ledger = readLineLedger(repo, 'team');
    if (!ledger) throw new Error('team ledger missing');
    writeLineLedger(repo, { ...ledger, lines: ledger.lines.map((l) => ({ ...l, required: { station: 'S9' } })) });

    const result = applyLine(repo, 'example-line', { force: true });

    expect(result.warnings).toContainEqual(expect.stringMatching(/required up to station "S9".*no longer has/));
    expect(readLineLedger(repo, 'team')?.lines[0].required).toEqual({ station: 'S9' });
  });

  it('unrequire drops the policy, and is a no-op when there is none', () => {
    const repo = repoWithTeamLine('har-unrequire');
    requireLine(repo, 'example-line', 'S2');

    expect(unrequireLine(repo, 'example-line')).toEqual({
      lineId: 'example-line',
      previousStation: 'S2',
      ledgerPath: '.har/lines.json',
    });
    expect(readLineLedger(repo, 'team')?.lines[0]).not.toHaveProperty('required');

    expect(unrequireLine(repo, 'example-line')).toEqual({
      lineId: 'example-line',
      ledgerPath: '.har/lines.json',
    });
  });

  it('shows up in list, status and describe', () => {
    const repo = repoWithTeamLine('har-require-output');
    expect(listLines(repo).installed[0]).not.toHaveProperty('required');

    requireLine(repo, 'example-line', 'S2');

    expect(listLines(repo).installed[0].required).toEqual({ station: 'S2' });
    expect(getLineStatus(repo, 'example-line').required).toEqual({ station: 'S2' });
    expect(describeLine(repo, 'example-line').required).toEqual({ station: 'S2' });
  });
});

describe('doctor: required lines', () => {
  it('fails on a personal line marked required', () => {
    const repo = makeGitRepo('har-doctor-req-personal');
    applyLine(repo, 'example-line', { scope: 'personal' });
    const ledger = readLineLedger(repo, 'personal');
    if (!ledger) throw new Error('personal ledger missing');
    writeLineLedger(
      repo,
      { ...ledger, lines: ledger.lines.map((l) => ({ ...l, required: { station: 'S3' } })) },
      'personal',
    );

    const report = runDoctor(repo);

    expect(report.ok).toBe(false);
    expect(lineFindings(report, 'error').map((f) => f.message)).toEqual([
      expect.stringMatching(/personal line "example-line" is marked required/),
    ]);
  });

  it('fails on a required station the program does not have', () => {
    const repo = repoWithTeamLine('har-doctor-req-station');
    const ledger = readLineLedger(repo, 'team');
    if (!ledger) throw new Error('team ledger missing');
    writeLineLedger(repo, { ...ledger, lines: ledger.lines.map((l) => ({ ...l, required: { station: 'S9' } })) });

    const report = runDoctor(repo);

    expect(report.ok).toBe(false);
    expect(lineFindings(report, 'error').map((f) => f.message)).toEqual([
      expect.stringMatching(/required up to station "S9", which its program does not have/),
    ]);
  });

  it('fails when a gate stage up to the required station is not registered', () => {
    const repo = repoWithTeamLine('har-doctor-req-unregistered');
    requireLine(repo, 'example-line', 'S2');
    dropCommittedStage(repo, 'example-gate');

    const report = runDoctor(repo);

    expect(report.ok).toBe(false);
    expect(lineFindings(report, 'error').map((f) => f.message)).toEqual([
      expect.stringMatching(/required line "example-line" gate stage "example-gate" .*not registered/),
    ]);
  });

  it('counts only the committed registry for a required gate stage (CI cannot see the overlay)', () => {
    const repo = repoWithTeamLine('har-doctor-req-overlay');
    requireLine(repo, 'example-line');
    const gate = readCommittedStageRegistry(repo).stages.find((s) => s.id === 'example-gate');
    if (!gate) throw new Error('example-gate not registered');
    dropCommittedStage(repo, 'example-gate');
    writeStageOverlay(repo, { version: '1', stages: [gate] });

    const errors = lineFindings(runDoctor(repo), 'error').map((f) => f.message);

    expect(errors).toContainEqual(expect.stringMatching(/committed \.har\/stages\.json/));
  });

  it('keeps an unregistered gate stage past the required station a warning', () => {
    const repo = repoWithTeamLine('har-doctor-req-later');
    requireLine(repo, 'example-line', 'S1'); // example-gate starts at S2
    dropCommittedStage(repo, 'example-gate');

    const report = runDoctor(repo);

    expect(lineFindings(report, 'error')).toEqual([]);
    expect(lineFindings(report, 'warning').map((f) => f.message)).toEqual([
      expect.stringMatching(/^line "example-line" gate stage "example-gate"/),
    ]);
  });
});

describe('MCP har_line_require / har_line_unrequire', () => {
  it('match the CLI core', async () => {
    const repo = repoWithTeamLine('har-require-mcp');

    const required = await handleMcpToolCall('har_line_require', { repo, line: 'example-line', station: 'S2' });
    expect(JSON.parse(required.content[0].text)).toEqual({
      lineId: 'example-line',
      station: 'S2',
      ledgerPath: '.har/lines.json',
    });
    expect(readLineLedger(repo, 'team')?.lines[0].required).toEqual({ station: 'S2' });

    const list = await handleMcpToolCall('har_line_list', { repo });
    expect(JSON.parse(list.content[0].text).installed[0].required).toEqual({ station: 'S2' });

    const dropped = await handleMcpToolCall('har_line_unrequire', { repo, line: 'example-line' });
    expect(JSON.parse(dropped.content[0].text)).toMatchObject({ lineId: 'example-line', previousStation: 'S2' });
  });

  it('refuses a personal line', async () => {
    const repo = makeGitRepo('har-require-mcp-personal');
    applyLine(repo, 'example-line', { scope: 'personal' });

    await expect(handleMcpToolCall('har_line_require', { repo, line: 'example-line' })).rejects.toThrow(
      /only team lines can be required/,
    );
  });
});
