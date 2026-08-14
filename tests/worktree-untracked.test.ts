import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  formatUntrackedWorktreeWarning,
  listUntrackedAbsentFromWorktree,
  worktreeCheckEnabled,
} from '../src/core/worktree-untracked';

const tmpDirs: string[] = [];

function git(cwd: string, args: string): void {
  execSync(
    `git -c user.email=har@example.com -c user.name=har -c commit.gpgsign=false ${args}`,
    { cwd, stdio: 'ignore' },
  );
}

function write(repo: string, relPath: string, contents = 'x\n'): void {
  const target = path.join(repo, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function makeRepo(files: Record<string, string> = {}, tracked: string[] = []): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'har-worktree-untracked-'));
  tmpDirs.push(repo);
  git(repo, 'init -q');
  write(repo, 'tracked.txt');
  for (const [relPath, contents] of Object.entries(files)) {
    write(repo, relPath, contents);
  }
  git(
    repo,
    'add tracked.txt' + (tracked.length ? ' ' + tracked.map((p) => `"${p}"`).join(' ') : ''),
  );
  git(repo, 'commit -qm init');
  return repo;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('listUntrackedAbsentFromWorktree', () => {
  it('returns nothing outside a git checkout', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'har-not-a-repo-')));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# rules\n');
    const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = dir;
    try {
      expect(listUntrackedAbsentFromWorktree(dir)).toEqual([]);
    } finally {
      if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    }
  });

  it('lists untracked files and collapses an untracked directory', () => {
    const repo = makeRepo({
      'CLAUDE.md': '# rules\n',
      '.claude/skills/review/SKILL.md': '# skill\n',
    });
    expect(listUntrackedAbsentFromWorktree(repo)).toEqual(['.claude/', 'CLAUDE.md']);
  });

  it('does not list tracked or gitignored paths', () => {
    const repo = makeRepo(
      {
        '.gitignore': 'node_modules/\n.env\n*.md\n!README.md\n',
        'README.md': '# app\n',
        'CLAUDE.md': '# rules\n',
        '.env': 'TOKEN=abc\n',
        'notes.txt': 'scratch\n',
        'node_modules/left-pad/readme.md': 'x\n',
      },
      ['.gitignore', 'README.md'],
    );
    expect(listUntrackedAbsentFromWorktree(repo)).toEqual(['notes.txt']);
  });

  it('does not list tracked context files', () => {
    const repo = makeRepo({ 'CLAUDE.md': '# rules\n' }, ['CLAUDE.md']);
    expect(listUntrackedAbsentFromWorktree(repo)).toEqual([]);
  });
});

describe('formatUntrackedWorktreeWarning', () => {
  it('returns undefined when there is nothing to report', () => {
    expect(formatUntrackedWorktreeWarning([])).toBeUndefined();
  });

  it('names the count, paths, and the way out', () => {
    const warning = formatUntrackedWorktreeWarning(['CLAUDE.md', '.claude/']);
    expect(warning).toContain('2 untracked paths will not appear in the session worktree');
    expect(warning).toContain('CLAUDE.md, .claude/');
    expect(warning).toContain('They are only in the main checkout');
    expect(warning).toContain('--no-worktree');
  });

  it('stays singular for one path and caps the listed remainder', () => {
    expect(formatUntrackedWorktreeWarning(['.env'])).toContain('1 untracked path will not appear');
    expect(formatUntrackedWorktreeWarning(['.env'])).toContain('It is only in the main checkout');
    const many = Array.from({ length: 10 }, (_, i) => `note-${i}.txt`);
    const warning = formatUntrackedWorktreeWarning(many, 8);
    expect(warning).toContain('10 untracked paths');
    expect(warning).toContain('(+2 more)');
  });
});

describe('worktreeCheckEnabled', () => {
  it('follows the harness default and the per-launch override', () => {
    expect(worktreeCheckEnabled({})).toBe(true);
    expect(worktreeCheckEnabled({ HARNESS_USE_WORKTREE: 'false' })).toBe(false);
    expect(worktreeCheckEnabled({}, false)).toBe(false);
    expect(worktreeCheckEnabled({ HARNESS_USE_WORKTREE: 'false' }, true)).toBe(true);
  });
});
