import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { applyLine, locateInstalledLine } from '../src/harness/lines';
import { createLine } from '../src/harness/line-create';
import * as lineLedger from '../src/harness/line-ledger';
import { readLineLedger } from '../src/harness/line-ledger';
import { promoteLine } from '../src/core/lines';
import { readCommittedStageRegistry, readStageOverlay } from '../src/harness/stages';
import { runDoctor } from '../src/harness/doctor';

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

function changedFiles(repoPath: string): string[] {
  return git(repoPath, 'status', '--porcelain', '--untracked-files=all')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3))
    .sort();
}

const exists = (repoPath: string, rel: string): boolean => fs.existsSync(path.join(repoPath, rel));

describe('har line promote', () => {
  it('moves an installed personal line into the committed team files', () => {
    const repo = makeGitRepo('har-promote');
    applyLine(repo, 'example-line', { scope: 'personal' });
    const verificationBefore = readCommittedStageRegistry(repo).verificationStages;
    const installedAt = readLineLedger(repo, 'personal')?.lines[0].installedAt;

    const result = promoteLine(repo, 'example-line');

    expect(result).toMatchObject({
      lineId: 'example-line',
      lineDirRel: '.har/lines/example-line',
      programPath: '.har/lines/example-line/line.json',
      stageIds: ['example-gate'],
    });
    expect(locateInstalledLine(repo, 'example-line')).toBe('team');

    // Team side: program, manifest, script (still executable), stage, ledger entry.
    expect(exists(repo, '.har/lines/example-line/line.json')).toBe(true);
    expect(exists(repo, '.har/lines/example-line/line.manifest.json')).toBe(true);
    expect(fs.statSync(path.join(repo, '.har/stages/example-gate.sh')).mode & 0o111).not.toBe(0);
    const committed = readCommittedStageRegistry(repo);
    expect(committed.stages.find((s) => s.id === 'example-gate')?.script).toBe('stages/example-gate.sh');
    expect(committed.verificationStages).toEqual(verificationBefore);
    expect(readLineLedger(repo, 'team')?.lines[0]).toMatchObject({
      id: 'example-line',
      programPath: '.har/lines/example-line/line.json',
      installedAt,
    });

    // Personal side is gone.
    expect(exists(repo, '.har/local/lines/example-line')).toBe(false);
    expect(exists(repo, '.har/local/stages/example-gate.sh')).toBe(false);
    expect(readStageOverlay(repo)).toBeNull();
    expect(readLineLedger(repo, 'personal')?.lines).toEqual([]);

    // The diff is exactly what the result says to commit.
    expect(changedFiles(repo)).toEqual(
      [
        '.har/lines.json',
        '.har/lines/example-line/line.json',
        '.har/lines/example-line/line.manifest.json',
        '.har/manifest.json',
        '.har/stages.json',
        '.har/stages/example-gate.sh',
      ].sort(),
    );
    expect(result.filesToCommit).toEqual(
      expect.arrayContaining(['.har/lines/example-line/', '.har/stages/example-gate.sh', '.har/stages.json', '.har/lines.json']),
    );
    expect(runDoctor(repo).ok).toBe(true);
  });

  it('promotes a scaffolded (not yet installed) personal line and strips the personal README note', () => {
    const repo = makeGitRepo('har-promote-draft');
    createLine(repo, { id: 'draft', scope: 'personal' });

    const result = promoteLine(repo, 'draft');

    expect(result.stageIds).toEqual([]);
    expect(exists(repo, '.har/local/lines/draft')).toBe(false);
    const readme = fs.readFileSync(path.join(repo, '.har/lines/draft/README.md'), 'utf8');
    expect(readme).not.toContain('--personal');
    expect(readme).not.toContain('**personal** line');

    // It is now an ordinary team bundle.
    applyLine(repo, 'draft');
    expect(locateInstalledLine(repo, 'draft')).toBe('team');
    expect(readCommittedStageRegistry(repo).stages.some((s) => s.id === 'draft-gate')).toBe(true);
  });

  it('refuses team lines, unknown lines, and a stage id already committed — changing nothing', () => {
    const repo = makeGitRepo('har-promote-refuse');
    applyLine(repo, 'example-line');
    expect(() => promoteLine(repo, 'example-line')).toThrow(/already a team line/);
    expect(() => promoteLine(repo, 'nope')).toThrow(/not installed/);

    const other = makeGitRepo('har-promote-taken');
    applyLine(other, 'example-line', { scope: 'personal' });
    const committed = readCommittedStageRegistry(other);
    // Hand-made: the committed registry already has the id (bypassing the install guard).
    fs.writeFileSync(
      path.join(other, '.har/stages.json'),
      JSON.stringify({ ...committed, stages: [...committed.stages, { id: 'example-gate', kind: 'test', command: 'true' }] }, null, 2),
    );
    const before = changedFiles(other);
    expect(() => promoteLine(other, 'example-line')).toThrow(/already exist in .har\/stages.json/);
    expect(changedFiles(other)).toEqual(before);
    expect(exists(other, '.har/local/lines/example-line/line.json')).toBe(true);
  });

  it('rolls everything back when a write fails part-way', () => {
    const repo = makeGitRepo('har-promote-rollback');
    applyLine(repo, 'example-line', { scope: 'personal' });
    const overlayBefore = fs.readFileSync(path.join(repo, '.har/local/stages.json'), 'utf8');
    const spy = jest.spyOn(lineLedger, 'upsertLineLedgerEntry').mockImplementation(() => {
      throw new Error('disk full');
    });
    try {
      expect(() => promoteLine(repo, 'example-line')).toThrow(/rolled back: disk full/);
    } finally {
      spy.mockRestore();
    }

    expect(locateInstalledLine(repo, 'example-line')).toBe('personal');
    expect(changedFiles(repo)).toEqual([]);
    expect(fs.readFileSync(path.join(repo, '.har/local/stages.json'), 'utf8')).toBe(overlayBefore);
    expect(exists(repo, '.har/local/stages/example-gate.sh')).toBe(true);
    expect(exists(repo, '.har/lines/example-line')).toBe(false);
  });

  it('promotes from a worktree slot into the slot branch, removing the main checkout personal copy', () => {
    const main = makeGitRepo('har-promote-wt');
    applyLine(main, 'example-line', { scope: 'personal' });
    const slot = path.join(path.dirname(main), `${path.basename(main)}-slot`);
    git(main, 'worktree', 'add', '-q', '-b', 'slot', slot);

    promoteLine(slot, 'example-line');

    expect(exists(slot, '.har/lines/example-line/line.json')).toBe(true);
    expect(exists(slot, '.har/stages/example-gate.sh')).toBe(true);
    expect(changedFiles(slot)).toContain('.har/stages.json');
    expect(exists(main, '.har/local/lines/example-line')).toBe(false);
    expect(changedFiles(main)).toEqual([]);
  });
});
