import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { applyLine } from '../src/harness/lines';
import { createLine } from '../src/harness/line-create';
import { lineScopeAudience } from '../src/harness/line-scope';
import { listLines, runLineGate } from '../src/core/lines';
import { verifyLinesNextStep } from '../src/core/verify-lines';
import { HAR_MCP_TOOLS } from '../src/mcp/server';

const CLI = path.join(__dirname, '..', 'dist', 'index.js');

function makeTempRepo(name: string): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  fs.writeFileSync(
    path.join(repoPath, 'package.json'),
    JSON.stringify({ name: 'test-app', version: '1.0.0' }, null, 2) + '\n',
  );
  scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });
  return repoPath;
}

/** A personal-installable bundle whose gate runs without a slot. */
function writeSlotlessBundle(dir: string, id: string): void {
  fs.mkdirSync(path.join(dir, 'stages'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'stages', `${id}-gate.sh`), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(dir, 'line.json'),
    JSON.stringify({
      contractVersion: 1,
      id,
      title: `${id} line`,
      description: 'test line',
      stations: [{ id: 'S1', title: 'Station 1', description: 'one', work: { source: 'none', ids: [], optional: true } }],
      gate: { cumulative: true, optInEnv: null, stages: [{ id: `${id}-gate`, fromStation: 'S1', tier: 'full' }] },
      extraStages: [],
      handoff: { autonomousShip: false, waitFor: 'human review' },
      prototypeNotes: [],
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'line.manifest.json'),
    JSON.stringify({
      kind: 'line',
      id,
      title: `${id} line`,
      program: 'line.json',
      files: [{ src: `stages/${id}-gate.sh`, dest: `.har/stages/${id}-gate.sh`, executable: true }],
      stages: [{ id: `${id}-gate`, kind: 'test', requiresAgentId: false, script: `stages/${id}-gate.sh`, tier: 'full' }],
    }),
  );
}

/** One team line, one personal line, one personal draft (scaffolded, never added). */
function mixedRepo(name: string): string {
  const repo = makeTempRepo(name);
  applyLine(repo, 'example-line');
  const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'har-scope-bundle-'));
  writeSlotlessBundle(bundle, 'solo');
  applyLine(repo, bundle, { scope: 'personal' });
  return repo;
}

describe('line scope in every output (BE-3802)', () => {
  it('tags every installed line with its scope and filters har line list by scope', () => {
    const repo = mixedRepo('har-scope-list');

    const all = listLines(repo);
    expect(all.installed.map((l) => [l.lineId, l.scope])).toEqual([
      ['example-line', 'team'],
      ['solo', 'personal'],
    ]);

    const personal = listLines(repo, { scope: 'personal' });
    expect(personal.installed.map((l) => l.lineId)).toEqual(['solo']);
    const team = listLines(repo, { scope: 'team' });
    expect(team.installed.map((l) => l.lineId)).toEqual(['example-line']);
  });

  it('keeps bundled lines available under either filter and filters authored ones by home', () => {
    const repo = makeTempRepo('har-scope-available');
    // Authored but not installed: the program is only in the manifest dir under a different name.
    createLine(repo, { id: 'team-draft', gateStage: false });
    fs.renameSync(
      path.join(repo, '.har/lines/team-draft/line.json'),
      path.join(repo, '.har/lines/team-draft/program.json'),
    );
    const manifestPath = path.join(repo, '.har/lines/team-draft/line.manifest.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ ...JSON.parse(fs.readFileSync(manifestPath, 'utf8')), program: 'program.json' }),
    );

    const personal = listLines(repo, { scope: 'personal' });
    expect(personal.available.some((l) => l.lineId === 'example-line' && l.source === 'bundled')).toBe(true);
    expect(personal.available.some((l) => l.lineId === 'team-draft')).toBe(false);
    expect(listLines(repo, { scope: 'team' }).available).toContainEqual({
      lineId: 'team-draft',
      source: 'local',
      scope: 'team',
    });
  });

  it('keeps the scope of an unreadable line known from its ledger', () => {
    const repo = mixedRepo('har-scope-unreadable');
    fs.writeFileSync(path.join(repo, '.har/local/lines/solo/line.json'), '{ not json');

    const entry = listLines(repo).installed.find((l) => l.lineId === 'solo');
    expect(entry).toMatchObject({ scope: 'personal', unreadable: expect.any(String) });
    expect(listLines(repo, { scope: 'personal' }).installed.map((l) => l.lineId)).toEqual(['solo']);
  });

  it('reports scope on a gate run and in the post-verify line offer', async () => {
    const repo = mixedRepo('har-scope-gate');

    const gate = await runLineGate({ repoPath: repo, lineId: 'solo', station: 'S1' });
    expect(gate).toMatchObject({ lineId: 'solo', scope: 'personal', pass: true });

    expect(verifyLinesNextStep(repo, 3).map((l) => [l.lineId, l.scope])).toEqual([
      ['example-line', 'team'],
      ['solo', 'personal'],
    ]);
  });

  it("points a personal install's next steps at the files it moved under .har/local/", () => {
    const repo = makeTempRepo('har-scope-next-steps');
    const personal = applyLine(repo, 'example-line', { scope: 'personal' });
    expect(personal.nextSteps.join('\n')).toContain('.har/local/stages/example-gate.sh');
    expect(personal.nextSteps.join('\n')).not.toMatch(/(^|\s)\.har\/stages\/example-gate\.sh/);
    expect(personal.nextSteps.join('\n')).toContain('.har/local/lines/example-line/line.json');
    expect(personal.nextSteps.join('\n')).not.toMatch(/(^|\s)\.har\/lines\//);

    const teamRepo = makeTempRepo('har-scope-next-steps-team');
    expect(applyLine(teamRepo, 'example-line').nextSteps.join('\n')).toContain('Edit .har/stages/example-gate.sh');
  });

  it("create's next steps and gate script name the right paths for each scope", () => {
    const repo = makeTempRepo('har-scope-create-text');
    const personal = createLine(repo, { id: 'mine', scope: 'personal' });
    expect(personal.nextSteps.join('\n')).toContain('Installing writes .har/local/ADAPT-PROMPT-line-mine.md');
    const team = createLine(repo, { id: 'ours' });
    expect(team.nextSteps.join('\n')).toContain('Installing writes .har/ADAPT-PROMPT-line-ours.md');

    // The script is bundle content: it names neither home as *the* path…
    const script = fs.readFileSync(path.join(repo, '.har/local/lines/mine/stages/mine-gate.sh'), 'utf8');
    expect(script).not.toContain('Usage: ./.har/stages/');
    expect(script).not.toContain('TODO: implement .har/stages/');
    expect(script).toContain('.har/local/stages/mine-gate.sh (personal)');

    // …and once installed as personal, its TODO reports where it really is.
    applyLine(repo, 'mine', { scope: 'personal' });
    const installed = path.join(repo, '.har/local/stages/mine-gate.sh');
    const run = spawnSync('bash', [installed, '1'], {
      encoding: 'utf8',
      env: { ...process.env, AGENT_ID: '1', ENV_FILE: '/dev/null', WORK_DIR: repo },
    });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain(`TODO: implement ${installed}`);
  });

  it('says who sees a line in each scope', () => {
    expect(lineScopeAudience('personal')).toMatch(/only you/);
    expect(lineScopeAudience('team')).toMatch(/team and CI/);
  });

  it('exposes the scope filter on har_line_list', () => {
    const tool = HAR_MCP_TOOLS.find((t) => t.name === 'har_line_list');
    expect(tool?.inputSchema).toMatchObject({
      properties: { scope: { type: 'string', enum: ['team', 'personal'] } },
    });
  });

  it('har line list --scope on the CLI: filtered JSON, tagged text, invalid value refused', () => {
    const repo = mixedRepo('har-scope-cli');

    const json = JSON.parse(
      execFileSync('node', [CLI, 'line', 'list', '--repo', repo, '--scope', 'personal', '--json'], { encoding: 'utf8' }),
    );
    expect(json.installed.map((l: { lineId: string; scope: string }) => [l.lineId, l.scope])).toEqual([
      ['solo', 'personal'],
    ]);

    const text = execFileSync('node', [CLI, 'line', 'list', '--repo', repo], { encoding: 'utf8' });
    expect(text).toMatch(/example-line .*\[team\]/);
    expect(text).toMatch(/solo .*\[personal\]/);

    const bad = spawnSync('node', [CLI, 'line', 'list', '--repo', repo, '--scope', 'mine'], { encoding: 'utf8' });
    expect(bad.status).not.toBe(0);
  });
});
