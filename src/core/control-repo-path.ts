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
