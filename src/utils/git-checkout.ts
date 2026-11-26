import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Same-checkout detection without a `git` process per call.
 *
 * Slot discovery compares the harness root against every `*-har-agent-*`
 * directory under `~/worktrees` (all projects' slots live there), so a status
 * poll used to spawn two `git rev-parse --git-common-dir` per candidate per
 * slot — over a hundred processes for a busy machine. The common dir is
 * readable from the filesystem: a checkout's `.git` is either the git dir
 * itself or a `gitdir: <path>` file, and a linked worktree's git dir holds a
 * `commondir` file pointing back at the shared one.
 */

function findDotGit(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, '.git');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Reads the common dir from disk; null means "unusual layout, ask git". */
function commonDirFromFs(cwd: string): string | undefined | null {
  const dotGit = findDotGit(cwd);
  if (!dotGit) return process.env.GIT_DIR ? null : undefined;

  let gitDir: string;
  const stat = fs.statSync(dotGit);
  if (stat.isDirectory()) {
    gitDir = dotGit;
  } else {
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!match) return null;
    gitDir = path.resolve(path.dirname(dotGit), match[1]);
  }
  if (!fs.existsSync(gitDir)) return undefined;

  const commonDirFile = path.join(gitDir, 'commondir');
  const common = fs.existsSync(commonDirFile)
    ? path.resolve(gitDir, fs.readFileSync(commonDirFile, 'utf8').trim())
    : gitDir;
  return realpathOrSelf(common);
}

function commonDirFromGit(cwd: string): string | undefined {
  try {
    const out = execSync('git rev-parse --git-common-dir', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    return out ? realpathOrSelf(path.resolve(cwd, out)) : undefined;
  } catch {
    return undefined;
  }
}

/** Absolute, symlink-resolved `git rev-parse --git-common-dir` for `cwd`. */
export function gitCommonDir(cwd: string): string | undefined {
  try {
    const fromFs = commonDirFromFs(cwd);
    if (fromFs !== null) return fromFs;
  } catch {
    // fall through to git
  }
  return commonDirFromGit(cwd);
}

/** True when both paths belong to the same repository (main checkout or linked worktree). */
export function sameGitCheckout(a: string, b: string): boolean {
  const left = gitCommonDir(a);
  if (left === undefined) return false;
  const right = gitCommonDir(b);
  return right !== undefined && left === right;
}

/**
 * The same location in the repository's main working tree when `p` is inside a
 * linked worktree (`<main>/<same relative path>`); `p` itself otherwise — main
 * checkout, submodule, bare-repo worktree, or no git at all. Filesystem only:
 * no `git` process, so it is cheap enough for every registry read.
 */
export function mainWorktreePath(p: string): string {
  const resolved = path.resolve(p);
  try {
    const dotGit = findDotGit(resolved);
    if (!dotGit || fs.statSync(dotGit).isDirectory()) return resolved;

    const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!match) return resolved;
    const gitDir = path.resolve(path.dirname(dotGit), match[1]);
    // Only linked worktrees have `commondir`; a submodule's .git file does not.
    const commonDirFile = path.join(gitDir, 'commondir');
    if (!fs.existsSync(commonDirFile)) return resolved;
    const commonDir = path.resolve(gitDir, fs.readFileSync(commonDirFile, 'utf8').trim());
    if (path.basename(commonDir) !== '.git') return resolved;

    const rel = path.relative(path.dirname(dotGit), resolved);
    return path.join(path.dirname(commonDir), rel);
  } catch {
    return resolved;
  }
}
