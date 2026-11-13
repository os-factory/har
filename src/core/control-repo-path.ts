import * as fs from 'fs';
import * as path from 'path';
import { run } from '../utils/shell';

function tryGit(cwd: string, args: string): string | undefined {
  if (!fs.existsSync(cwd)) return undefined;
  const result = run(`git ${args}`, { cwd });
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/**
 * Main working tree for a git checkout (linked worktree → primary checkout).
 * Returns undefined when `cwd` is not inside a git work tree.
 */
export function resolveMainWorkingTree(cwd: string): string | undefined {
  const toplevel = tryGit(cwd, 'rev-parse --show-toplevel');
  if (!toplevel) return undefined;

  const commonDirRaw = tryGit(cwd, 'rev-parse --git-common-dir');
  const commonDir = commonDirRaw ? path.resolve(cwd, commonDirRaw) : undefined;
  if (!commonDir) return path.resolve(toplevel);

  // Normal repos: common dir is `<main>/.git` (or a `.git` file is not used here —
  // `git-common-dir` already resolves to the real common directory).
  if (path.basename(commonDir) === '.git') {
    return path.dirname(commonDir);
  }

  // Unusual gitdir layouts — first porcelain worktree entry is the primary.
  const porcelain = tryGit(cwd, 'worktree list --porcelain');
  if (porcelain) {
    for (const line of porcelain.split('\n')) {
      if (line.startsWith('worktree ')) {
        return path.resolve(line.slice('worktree '.length));
      }
    }
  }

  return path.resolve(toplevel);
}

/**
 * Linked git worktrees of `cwd`'s repository, excluding the main working tree.
 *
 * Used when syncing Mission Control: an externally-owned workspace writes its
 * own `.har/` (runs, slots, work-units) and is invisible if we only read the
 * canonical checkout (#256). HAR-owned session worktrees are linked too, but
 * they normally hold no evidence of their own — callers filter on that.
 */
export function listLinkedWorktrees(cwd: string): string[] {
  const porcelain = tryGit(cwd, 'worktree list --porcelain');
  if (!porcelain) return [];

  const main = resolveMainWorkingTree(cwd);
  const mainResolved = main ? path.resolve(main) : undefined;
  const paths: string[] = [];
  for (const line of porcelain.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const worktree = path.resolve(line.slice('worktree '.length));
    if (mainResolved && worktree === mainResolved) continue;
    paths.push(worktree);
  }
  return paths;
}

export interface LinkedWorktreeDetail {
  path: string;
  /** Short branch name; null on a detached HEAD. */
  branch: string | null;
  head: string | null;
}

/**
 * Linked worktrees of `cwd`'s repository with their branch and HEAD, excluding
 * the main working tree and bare entries. Reported to Mission Control on sync:
 * in docker it cannot read `<repo>/.git/worktrees` and would otherwise not know
 * where a session in a plain `git worktree add` worktree works.
 */
export function listLinkedWorktreeDetails(cwd: string): LinkedWorktreeDetail[] {
  const porcelain = tryGit(cwd, 'worktree list --porcelain');
  if (!porcelain) return [];
  const main = resolveMainWorkingTree(cwd);
  const mainResolved = main ? path.resolve(main) : undefined;
  const out: LinkedWorktreeDetail[] = [];
  for (const block of porcelain.split(/\n\s*\n/)) {
    let worktree: string | undefined;
    let branch: string | null = null;
    let head: string | null = null;
    let bare = false;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) worktree = path.resolve(line.slice('worktree '.length));
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length).trim() || null;
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '') || null;
      else if (line.trim() === 'bare') bare = true;
    }
    if (!worktree || bare || worktree === mainResolved) continue;
    out.push({ path: worktree, branch, head });
  }
  return out;
}

/**
 * Map a harness/repo path onto the main git working tree.
 *
 * Mission Control identities repositories by absolute path. Session worktrees
 * contain a full `.har/` tree, so sync/register from a worktree would otherwise
 * create a duplicate repository row. Rewrite linked-worktree paths to the same
 * relative location under the main checkout.
 */
export function canonicalizeControlRepoPath(repoPath: string): string {
  const resolved = path.resolve(repoPath);
  const toplevel = tryGit(resolved, 'rev-parse --show-toplevel');
  if (!toplevel) return resolved;

  const mainRoot = resolveMainWorkingTree(resolved);
  if (!mainRoot) return resolved;

  const top = path.resolve(toplevel);
  const main = path.resolve(mainRoot);
  if (top === main) return resolved;

  const rel = path.relative(top, resolved);
  if (!rel || rel === '.') return main;
  if (rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) {
    return resolved;
  }
  return path.resolve(main, rel);
}
