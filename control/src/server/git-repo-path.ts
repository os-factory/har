import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

function tryGit(cwd: string, args: string[]): string | undefined {
  if (!fs.existsSync(cwd)) return undefined;
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

/** Main working tree for a git checkout (linked worktree → primary checkout). */
export function resolveMainWorkingTree(cwd: string): string | undefined {
  const toplevel = tryGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!toplevel) return undefined;

  const commonDirRaw = tryGit(cwd, ['rev-parse', '--git-common-dir']);
  const commonDir = commonDirRaw ? path.resolve(cwd, commonDirRaw) : undefined;
  if (!commonDir) return path.resolve(toplevel);

  if (path.basename(commonDir) === '.git') {
    return path.dirname(commonDir);
  }

  const porcelain = tryGit(cwd, ['worktree', 'list', '--porcelain']);
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
 * Map a repository path onto the main git working tree so linked HAR session
 * worktrees are not stored as distinct Mission Control repositories.
 */
export function canonicalizeControlRepoPath(repoPath: string): string {
  const resolved = path.resolve(repoPath);
  const toplevel = tryGit(resolved, ['rev-parse', '--show-toplevel']);
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
