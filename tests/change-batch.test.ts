import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  computeStagedTree,
  computeWorktreeSnapshot,
  getCurrentBranch,
  getHeadTree,
  isGitCheckout,
  isMergeOrRebaseInProgress,
} from '../src/core/change-batch';

function sh(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-cb-'));
  sh(dir, 'git init -q -b main');
  sh(dir, 'git config user.email har@test.local');
  sh(dir, 'git config user.name har');
  return dir;
}

function commitAll(dir: string, message: string): void {
  sh(dir, 'git add -A');
  sh(dir, `git commit -q -m "${message}"`);
}

describe('change-batch git plumbing', () => {
  it('detects git checkouts', () => {
    const dir = initRepo();
    expect(isGitCheckout(dir)).toBe(true);
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'har-cb-plain-'));
    expect(isGitCheckout(plain)).toBe(false);
  });

  it('clean tree snapshot equals HEAD tree and hash is stable', () => {
    const dir = initRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    commitAll(dir, 'init');

    const snap1 = computeWorktreeSnapshot(dir);
    const snap2 = computeWorktreeSnapshot(dir);
    expect(snap1.treeHash).toBe(snap2.treeHash);
    expect(snap1.treeHash).toBe(getHeadTree(dir));
    expect(snap1.changedFiles).toEqual([]);
    expect(snap1.branch).toBe('main');
    expect(snap1.headSha).toBe(sh(dir, 'git rev-parse HEAD'));
  });

  it('untracked files and deletions change the hash and appear in changedFiles', () => {
    const dir = initRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'world\n');
    commitAll(dir, 'init');
    const clean = computeWorktreeSnapshot(dir);

    fs.writeFileSync(path.join(dir, 'new.txt'), 'untracked\n');
    const withNew = computeWorktreeSnapshot(dir);
    expect(withNew.treeHash).not.toBe(clean.treeHash);
    expect(withNew.changedFiles).toEqual([{ path: 'new.txt', status: 'A' }]);

    fs.rmSync(path.join(dir, 'b.txt'));
    const withDelete = computeWorktreeSnapshot(dir);
    expect(withDelete.treeHash).not.toBe(withNew.treeHash);
    expect(withDelete.changedFiles).toEqual(
      expect.arrayContaining([
        { path: 'new.txt', status: 'A' },
        { path: 'b.txt', status: 'D' },
      ]),
    );
  });

  it('respects .gitignore in worktree snapshots', () => {
    const dir = initRepo();
    fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.log\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    commitAll(dir, 'init');
    const clean = computeWorktreeSnapshot(dir);

    fs.writeFileSync(path.join(dir, 'ignored.log'), 'noise\n');
    const after = computeWorktreeSnapshot(dir);
    expect(after.treeHash).toBe(clean.treeHash);
  });

  it('staging everything makes the staged tree equal the worktree snapshot', () => {
    const dir = initRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    commitAll(dir, 'init');

    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(dir, 'fresh.txt'), 'new\n');
    const snapshot = computeWorktreeSnapshot(dir);

    sh(dir, 'git add -A');
    expect(computeStagedTree(dir)).toBe(snapshot.treeHash);
  });

  it('partial staging produces a different staged tree', () => {
    const dir = initRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    commitAll(dir, 'init');

    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(dir, 'fresh.txt'), 'new\n');
    const snapshot = computeWorktreeSnapshot(dir);

    sh(dir, 'git add a.txt');
    expect(computeStagedTree(dir)).not.toBe(snapshot.treeHash);
  });

  it('does not touch the real index', () => {
    const dir = initRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    commitAll(dir, 'init');
    fs.writeFileSync(path.join(dir, 'untracked.txt'), 'x\n');

    computeWorktreeSnapshot(dir);
    expect(sh(dir, 'git diff --cached --name-only')).toBe('');
    expect(sh(dir, 'git status --porcelain')).toBe('?? untracked.txt');
  });

  it('detects renames', () => {
    const dir = initRepo();
    fs.writeFileSync(path.join(dir, 'old-name.txt'), 'stable content that git can match\n');
    commitAll(dir, 'init');

    fs.renameSync(path.join(dir, 'old-name.txt'), path.join(dir, 'new-name.txt'));
    const snapshot = computeWorktreeSnapshot(dir);
    expect(snapshot.changedFiles).toEqual([
      { path: 'new-name.txt', status: 'R', oldPath: 'old-name.txt' },
    ]);
  });

  it('handles unborn HEAD (no commits yet)', () => {
    const dir = initRepo();
    fs.writeFileSync(path.join(dir, 'first.txt'), 'x\n');

    expect(getHeadTree(dir)).toBeUndefined();
    const snapshot = computeWorktreeSnapshot(dir);
    expect(snapshot.headSha).toBeUndefined();
    expect(snapshot.changedFiles).toEqual([{ path: 'first.txt', status: 'A' }]);
  });

  it('write-tree throws on unmerged index and merge state is detected', () => {
    const dir = initRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n');
    commitAll(dir, 'init');

    sh(dir, 'git checkout -q -b feature');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'feature\n');
    commitAll(dir, 'feature change');

    sh(dir, 'git checkout -q main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'main\n');
    commitAll(dir, 'main change');

    expect(isMergeOrRebaseInProgress(dir)).toBe(false);
    expect(() => sh(dir, 'git merge feature')).toThrow();
    expect(isMergeOrRebaseInProgress(dir)).toBe(true);
    expect(() => computeStagedTree(dir)).toThrow();
  });

  it('reports branch for named branches only', () => {
    const dir = initRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
    commitAll(dir, 'init');
    expect(getCurrentBranch(dir)).toBe('main');
    sh(dir, 'git checkout -q --detach HEAD');
    expect(getCurrentBranch(dir)).toBeUndefined();
  });
});
