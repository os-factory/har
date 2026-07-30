import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { computeWorktreeSnapshot } from '../src/core/change-batch';
import {
  attachCommit,
  findValidation,
  listValidations,
  recordValidation,
  resolveValidationCheckoutDir,
} from '../src/core/validations';

function sh(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-val-'));
  sh(dir, 'git init -q -b main');
  sh(dir, 'git config user.email har@test.local');
  sh(dir, 'git config user.name har');
  fs.mkdirSync(path.join(dir, '.har'));
  fs.writeFileSync(path.join(dir, '.har', '.gitignore'), 'runs/\nvalidations/\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  sh(dir, 'git add -A');
  sh(dir, 'git commit -q -m init');
  return dir;
}

describe('validation store', () => {
  it('records a validation keyed by the worktree tree hash', () => {
    const dir = initRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');

    const record = recordValidation({
      checkoutDir: dir,
      harnessRoot: dir,
      status: 'pass',
      full: true,
      agentId: 1,
    });

    const snapshot = computeWorktreeSnapshot(dir);
    expect(record.treeHash).toBe(snapshot.treeHash);
    expect(record.changedFiles).toEqual([{ path: 'a.txt', status: 'M' }]);
    expect(fs.existsSync(path.join(dir, '.har', 'validations', `${record.treeHash}.json`))).toBe(
      true,
    );
    expect(findValidation(dir, record.treeHash)).toMatchObject({
      status: 'pass',
      full: true,
      agentId: 1,
    });
  });

  it('a later pass upgrades an earlier fail for the same hash', () => {
    const dir = initRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');

    const failed = recordValidation({ checkoutDir: dir, harnessRoot: dir, status: 'fail', full: true });
    const passed = recordValidation({ checkoutDir: dir, harnessRoot: dir, status: 'pass', full: true });

    expect(passed.treeHash).toBe(failed.treeHash);
    expect(passed.validationId).toBe(failed.validationId);
    expect(passed.createdAt).toBe(failed.createdAt);
    expect(findValidation(dir, passed.treeHash)?.status).toBe('pass');
    expect(listValidations(dir)).toHaveLength(1);
  });

  it('dual-writes to checkout and harness root when they differ', () => {
    const dir = initRepo();
    const worktree = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'har-val-wt-')), 'wt');
    sh(dir, `git worktree add -q "${worktree}" -b har-agent-1`);
    fs.writeFileSync(path.join(worktree, 'a.txt'), 'agent change\n');

    const record = recordValidation({
      checkoutDir: worktree,
      harnessRoot: dir,
      status: 'pass',
      full: true,
      agentId: 1,
    });

    expect(findValidation(worktree, record.treeHash)).toBeDefined();
    expect(findValidation(dir, record.treeHash)).toBeDefined();
  });

  it('attachCommit sets commitSha on both copies and survives re-validation', () => {
    const dir = initRepo();
    const worktree = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'har-val-wt2-')), 'wt');
    sh(dir, `git worktree add -q "${worktree}" -b har-agent-1`);
    fs.writeFileSync(path.join(worktree, 'a.txt'), 'agent change\n');

    const record = recordValidation({
      checkoutDir: worktree,
      harnessRoot: dir,
      status: 'pass',
      full: true,
    });

    sh(worktree, 'git add -A');
    sh(worktree, 'git commit -q -m change');
    const commitSha = sh(worktree, 'git rev-parse HEAD');
    const commitTree = sh(worktree, 'git rev-parse HEAD^{tree}');
    expect(commitTree).toBe(record.treeHash);

    const updated = attachCommit(worktree, commitTree, commitSha);
    expect(updated?.commitSha).toBe(commitSha);
    expect(findValidation(dir, commitTree)?.commitSha).toBe(commitSha);
  });

  it('returns undefined for unknown hashes and skips invalid files in list', () => {
    const dir = initRepo();
    expect(findValidation(dir, 'f'.repeat(40))).toBeUndefined();
    expect(attachCommit(dir, 'f'.repeat(40), 'abc')).toBeUndefined();

    fs.mkdirSync(path.join(dir, '.har', 'validations'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.har', 'validations', 'garbage.json'), 'not json');
    expect(listValidations(dir)).toEqual([]);
  });

  it('prefers the worktree root over a nested harness workDir', () => {
    const dir = initRepo();
    const nested = path.join(dir, 'control');
    fs.mkdirSync(nested, { recursive: true });

    expect(
      resolveValidationCheckoutDir({
        worktreePath: dir,
        workDir: nested,
        harnessRoot: nested,
      }),
    ).toBe(dir);
  });
});
