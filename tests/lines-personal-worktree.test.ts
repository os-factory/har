import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { applyLine } from '../src/harness/lines';
import { createLine } from '../src/harness/line-create';
import { personalHarRoot } from '../src/harness/line-scope';
import { getStageOverlayPath, readStageRegistry } from '../src/harness/stages';
import { runDoctor } from '../src/harness/doctor';
import { getLineStatus, listInstalledLineIds, runLineGate } from '../src/core/lines';
import { mainWorktreePath } from '../src/utils/git-checkout';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** A committed harness repo (main checkout) plus a linked worktree, like a HAR slot. */
function makeRepoWithWorktree(name: string): { main: string; slot: string } {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)));
  const main = path.join(base, 'main');
  fs.mkdirSync(main);
  fs.writeFileSync(
    path.join(main, 'package.json'),
    JSON.stringify({ name: 'test-app', version: '1.0.0' }, null, 2) + '\n',
  );
  scaffoldHarnessBoilerplate(main, { force: true, profile: 'cli' });
  git(main, 'init', '-q');
  git(main, 'config', 'user.email', 'test@example.com');
  git(main, 'config', 'user.name', 'Test');
  git(main, 'config', 'commit.gpgsign', 'false');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'init');

  const slot = path.join(base, 'slot');
  git(main, 'worktree', 'add', '-q', '-b', 'slot', slot);
  return { main, slot };
}

/** A personal line whose slotless gate records the directory it ran in. */
function writeCwdBundle(dir: string, id: string, marker: string): void {
  fs.mkdirSync(path.join(dir, 'stages'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'stages', `${id}-gate.sh`),
    `#!/usr/bin/env bash\npwd -P > "${marker}"\n`,
    { mode: 0o755 },
  );
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
      stages: [
        { id: `${id}-gate`, kind: 'test', requiresAgentId: false, script: `stages/${id}-gate.sh`, tier: 'full' },
      ],
    }),
  );
}

describe('personal lines inside worktree slots', () => {
  it('maps a linked-worktree path onto the main checkout, and leaves others alone', () => {
    const { main, slot } = makeRepoWithWorktree('har-wt-map');
    fs.mkdirSync(path.join(slot, 'docs'));

    expect(mainWorktreePath(slot)).toBe(main);
    expect(mainWorktreePath(path.join(slot, 'docs'))).toBe(path.join(main, 'docs'));
    expect(mainWorktreePath(main)).toBe(main);
    const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'har-wt-nogit-')));
    expect(mainWorktreePath(plain)).toBe(plain);

    expect(personalHarRoot(slot)).toBe(main);
    expect(personalHarRoot(main)).toBe(main);
  });

  it('sees a personal line installed in the main checkout and runs its gate in the slot', async () => {
    const { main, slot } = makeRepoWithWorktree('har-wt-gate');
    const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'har-wt-bundle-'));
    const marker = path.join(fs.realpathSync(os.tmpdir()), `har-wt-cwd-${process.pid}-${Date.now()}.txt`);
    writeCwdBundle(bundle, 'solo', marker);
    applyLine(main, bundle, { scope: 'personal' });

    // Git did not copy the gitignored personal area into the worktree…
    expect(fs.existsSync(path.join(slot, '.har', 'local'))).toBe(false);

    // …but the slot reads it from the main checkout.
    expect(listInstalledLineIds(slot)).toContain('solo');
    expect(getLineStatus(slot, 'solo').scope).toBe('personal');
    expect(readStageRegistry(slot).stages.find((s) => s.id === 'solo-gate')?.script).toBe('local/stages/solo-gate.sh');
    expect(getStageOverlayPath(slot)).toBe(path.join(main, '.har', 'local', 'stages.json'));

    const result = await runLineGate({ repoPath: slot, lineId: 'solo', station: 'S1' });
    expect(result.stages).toEqual([expect.objectContaining({ stageId: 'solo-gate', status: 'pass' })]);
    // The main checkout's script ran with the slot as its working directory.
    expect(fs.readFileSync(marker, 'utf8').trim()).toBe(slot);
    fs.rmSync(marker, { force: true });

    // Doctor in the slot finds the personal script (no missing stage file).
    expect(runDoctor(slot).findings.filter((f) => f.check === 'stage-files' && f.severity === 'error')).toEqual([]);
  });

  it('installs and scaffolds personal lines from a slot into the main checkout', () => {
    const { main, slot } = makeRepoWithWorktree('har-wt-install');

    applyLine(slot, 'example-line', { scope: 'personal' });
    createLine(slot, { id: 'draft', scope: 'personal', gateStage: false });

    expect(fs.existsSync(path.join(main, '.har', 'local', 'lines', 'example-line', 'line.json'))).toBe(true);
    expect(fs.existsSync(path.join(main, '.har', 'local', 'lines', 'draft', 'line.json'))).toBe(true);
    expect(fs.existsSync(path.join(main, '.har', 'local', 'stages', 'example-gate.sh'))).toBe(true);
    expect(fs.existsSync(path.join(slot, '.har', 'local'))).toBe(false);
    expect(listInstalledLineIds(main)).toEqual(expect.arrayContaining(['example-line', 'draft']));

    // Nothing personal shows up as a change in either checkout.
    expect(git(slot, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(git(main, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  });

  it('keeps team lines per checkout', () => {
    const { main, slot } = makeRepoWithWorktree('har-wt-team');
    applyLine(slot, 'example-line');

    expect(fs.existsSync(path.join(slot, '.har', 'lines', 'example-line', 'line.json'))).toBe(true);
    expect(fs.existsSync(path.join(main, '.har', 'lines', 'example-line'))).toBe(false);
    expect(listInstalledLineIds(main)).not.toContain('example-line');
  });
});
