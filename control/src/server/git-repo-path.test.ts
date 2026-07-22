import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalizeControlRepoPath } from './git-repo-path';

const temps: string[] = [];

function sh(cwd: string, command: string): void {
  execFileSync('bash', ['-lc', command], { cwd, stdio: 'pipe' });
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-mc-repo-'));
  temps.push(dir);
  sh(dir, 'git init -q -b main');
  sh(dir, 'git config user.email har@test.local');
  sh(dir, 'git config user.name har');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  sh(dir, 'git add -A && git commit -q -m init');
  return dir;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('canonicalizeControlRepoPath (Mission Control)', () => {
  it('maps linked worktrees to the main checkout', () => {
    const main = initRepo();
    const wtParent = fs.mkdtempSync(path.join(os.tmpdir(), 'har-mc-wt-'));
    temps.push(wtParent);
    const worktree = path.join(wtParent, 'wt');
    sh(main, `git worktree add -q "${worktree}" -b feature-wt`);

    expect(canonicalizeControlRepoPath(worktree)).toBe(path.resolve(main));
    expect(canonicalizeControlRepoPath(main)).toBe(path.resolve(main));
  });
});
