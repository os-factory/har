import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { applyLine, installedLineScopes, readInstalledLineProgram } from '../src/harness/lines';
import { createLine } from '../src/harness/line-create';
import { readLineLedger } from '../src/harness/line-ledger';
import { ensureHarLocalIgnored, personalFileDest } from '../src/harness/line-scope';
import { getLineStatus, listInstalledLineIds, listLineScopeClashes, runLineGate } from '../src/core/lines';
import { runDoctor } from '../src/harness/doctor';
import { readStageRegistry } from '../src/harness/stages';

function makeTempRepo(name: string): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  fs.writeFileSync(
    path.join(repoPath, 'package.json'),
    JSON.stringify({ name: 'test-app', version: '1.0.0' }, null, 2) + '\n',
  );
  scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });
  return repoPath;
}

function git(repoPath: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' });
}

function initGitRepo(repoPath: string): void {
  git(repoPath, 'init', '-q');
  git(repoPath, 'config', 'user.email', 'test@example.com');
  git(repoPath, 'config', 'user.name', 'Test');
  git(repoPath, 'config', 'commit.gpgsign', 'false');
  git(repoPath, 'add', '-A');
  git(repoPath, 'commit', '-q', '-m', 'init');
}

/** A minimal line bundle whose gate stage runs without an agent slot. */
function writeSlotlessBundle(dir: string, id: string, exitCode = 0): void {
  fs.mkdirSync(path.join(dir, 'stages'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'stages', `${id}-gate.sh`),
    `#!/usr/bin/env bash\necho "gate for ${id}"\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(dir, 'line.json'),
    JSON.stringify(
      {
        contractVersion: 1,
        id,
        title: `${id} line`,
        description: 'test line',
        stations: [{ id: 'S1', title: 'Station 1', description: 'one', work: { source: 'none', ids: [], optional: true } }],
        gate: { cumulative: true, optInEnv: null, stages: [{ id: `${id}-gate`, fromStation: 'S1', tier: 'full' }] },
        extraStages: [],
        handoff: { autonomousShip: false, waitFor: 'human review' },
        prototypeNotes: [],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(dir, 'line.manifest.json'),
    JSON.stringify(
      {
        kind: 'line',
        id,
        title: `${id} line`,
        program: 'line.json',
        files: [{ src: `stages/${id}-gate.sh`, dest: `.har/stages/${id}-gate.sh`, executable: true }],
        stages: [
          {
            id: `${id}-gate`,
            kind: 'test',
            description: 'slotless gate',
            requiresAgentId: false,
            script: `stages/${id}-gate.sh`,
            tier: 'full',
          },
        ],
      },
      null,
      2,
    ),
  );
}

describe('personal factory lines', () => {
  it('maps .har/ destinations into .har/local/', () => {
    expect(personalFileDest('.har/stages/x.sh')).toBe('.har/local/stages/x.sh');
    expect(personalFileDest('./.har/stages/x.sh')).toBe('.har/local/stages/x.sh');
    expect(personalFileDest('.har/local/stages/x.sh')).toBe('.har/local/stages/x.sh');
    expect(personalFileDest('tests/e2e/x.spec.ts')).toBe('tests/e2e/x.spec.ts');
  });

  it('scaffolds local/ into .har/.gitignore and maintain-style ensure is idempotent', () => {
    const repoPath = makeTempRepo('har-line-gitignore');
    const gitignore = path.join(repoPath, '.har', '.gitignore');
    expect(fs.readFileSync(gitignore, 'utf8').split('\n')).toContain('local/');
    expect(ensureHarLocalIgnored(repoPath)).toBe(false);

    // An older harness without the rule gets it added exactly once.
    fs.writeFileSync(gitignore, 'logs/\nruns/');
    expect(ensureHarLocalIgnored(repoPath)).toBe(true);
    expect(ensureHarLocalIgnored(repoPath)).toBe(false);
    const lines = fs.readFileSync(gitignore, 'utf8').split('\n');
    expect(lines.filter((l) => l === 'local/')).toHaveLength(1);
    expect(lines).toContain('runs/');
  });

  it('installs a personal line under .har/local/ with its own ledger', () => {
    const repoPath = makeTempRepo('har-line-personal-apply');
    const verificationBefore = [...(readStageRegistry(repoPath).verificationStages ?? [])];

    const result = applyLine(repoPath, 'example-line', { scope: 'personal' });

    expect(result.scope).toBe('personal');
    expect(result.programPath).toBe('.har/local/lines/example-line/line.json');
    expect(result.adaptPromptPath).toBe(path.join('.har', 'local', 'ADAPT-PROMPT-line-example-line.md'));
    expect(fs.existsSync(path.join(repoPath, '.har', 'local', 'stages', 'example-gate.sh'))).toBe(true);
    expect(fs.existsSync(path.join(repoPath, '.har', 'stages', 'example-gate.sh'))).toBe(false);
    expect(fs.existsSync(path.join(repoPath, '.har', 'lines'))).toBe(false);

    // Stage points at the gitignored copy; verify plan untouched.
    const registry = readStageRegistry(repoPath);
    expect(registry.stages.find((s) => s.id === 'example-gate')?.script).toBe('local/stages/example-gate.sh');
    expect(registry.verificationStages).toEqual(verificationBefore);

    expect(readLineLedger(repoPath, 'team')).toBeNull();
    expect(readLineLedger(repoPath, 'personal')?.lines[0]).toMatchObject({
      id: 'example-line',
      programPath: '.har/local/lines/example-line/line.json',
    });
    // Scope is derived from the ledger it lives in, never stored.
    expect(readLineLedger(repoPath, 'personal')?.lines[0]).not.toHaveProperty('scope');
  });

  it('shows personal and team lines together, each with its scope', () => {
    const repoPath = makeTempRepo('har-line-personal-status');
    applyLine(repoPath, 'example-line', { scope: 'personal' });
    createLine(repoPath, { id: 'team-line', gateStage: false });
    applyLine(repoPath, 'team-line');

    expect(listInstalledLineIds(repoPath)).toEqual(['example-line', 'team-line']);
    expect(getLineStatus(repoPath, 'example-line')).toMatchObject({
      scope: 'personal',
      programPath: '.har/local/lines/example-line/line.json',
    });
    expect(getLineStatus(repoPath, 'team-line').scope).toBe('team');
  });

  it('creates a personal line and installs it by bare id with --personal', () => {
    const repoPath = makeTempRepo('har-line-personal-create');
    const created = createLine(repoPath, { id: 'my-flow', scope: 'personal' });

    expect(created.scope).toBe('personal');
    expect(created.lineDirRel).toBe('.har/local/lines/my-flow');
    expect(fs.existsSync(path.join(repoPath, '.har', 'local', 'lines', 'my-flow', 'line.manifest.json'))).toBe(true);
    expect(created.nextSteps.join('\n')).toContain('har line add my-flow --personal');

    const applied = applyLine(repoPath, 'my-flow', { scope: 'personal' });
    expect(applied.source).toBe('local');
    expect(readInstalledLineProgram(repoPath, 'my-flow')?.id).toBe('my-flow');
    expect(fs.existsSync(path.join(repoPath, '.har', 'local', 'stages', 'my-flow-gate.sh'))).toBe(true);
  });

  it('runs a personal line gate from its gitignored stage script', async () => {
    const repoPath = makeTempRepo('har-line-personal-gate');
    const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'har-line-bundle-'));
    writeSlotlessBundle(bundle, 'solo');
    applyLine(repoPath, bundle, { scope: 'personal' });

    const result = await runLineGate({ repoPath, lineId: 'solo', station: 'S1' });
    expect(result.stages).toEqual([
      expect.objectContaining({ stageId: 'solo-gate', status: 'pass' }),
    ]);
    expect(result.pass).toBe(true);
    expect(getLineStatus(repoPath, 'solo').stations[0].green).toBe(true);
  });

  it('keeps git status clean except for the stage registry', () => {
    const repoPath = makeTempRepo('har-line-personal-git');
    initGitRepo(repoPath);

    applyLine(repoPath, 'example-line', { scope: 'personal' });

    const changed = git(repoPath, 'status', '--porcelain', '--untracked-files=all')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3));
    // The stage registry is the one shared file left; the local stage overlay issue removes it.
    expect(changed).toEqual(['.har/stages.json']);
  });

  it('refuses the same id in both scopes, at install and on read', () => {
    const repoPath = makeTempRepo('har-line-personal-clash');
    applyLine(repoPath, 'example-line');

    expect(() => applyLine(repoPath, 'example-line', { scope: 'personal' })).toThrow(
      /already installed as team/,
    );
    expect(() => createLine(repoPath, { id: 'example-line', scope: 'personal' })).toThrow(
      /already exists as team/,
    );
    expect(fs.existsSync(path.join(repoPath, '.har', 'local', 'lines', 'example-line'))).toBe(false);

    // A clash made by hand (e.g. copying files) is reported, not silently resolved.
    fs.cpSync(
      path.join(repoPath, '.har', 'lines', 'example-line'),
      path.join(repoPath, '.har', 'local', 'lines', 'example-line'),
      { recursive: true },
    );
    expect(installedLineScopes(repoPath, 'example-line')).toEqual(['team', 'personal']);
    expect(listLineScopeClashes(repoPath)).toEqual(['example-line']);
    expect(() => getLineStatus(repoPath, 'example-line')).toThrow(/both team .* and personal/);

    const doctor = runDoctor(repoPath);
    expect(doctor.findings).toContainEqual(
      expect.objectContaining({ check: 'factory-lines', severity: 'error', message: expect.stringMatching(/both team/) }),
    );
  });
});
