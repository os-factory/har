import { execSync } from 'child_process';
import { resolveCheckoutRoot } from './hooks';

const MAX_LISTED = 8;

/**
 * Paths present in the checkout but absent from a fresh `git worktree add`:
 * untracked and not ignored. `--directory` collapses a fully untracked tree
 * to one entry so a dirty `node_modules/` is a single line, not a walk.
 * Returns `[]` outside a git checkout and never throws.
 */
export function listUntrackedAbsentFromWorktree(repoPath: string): string[] {
  const toplevel = resolveCheckoutRoot(repoPath);
  if (!toplevel) return [];
  try {
    const raw = execSync(
      'git --literal-pathspecs ls-files --others --exclude-standard --directory -z',
      {
        cwd: toplevel,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 10_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    return raw.split('\0').filter(Boolean).sort();
  } catch {
    return [];
  }
}

/** One readiness warning: count plus a capped example list. */
export function formatUntrackedWorktreeWarning(
  paths: string[],
  maxListed = MAX_LISTED,
): string | undefined {
  if (paths.length === 0) return undefined;
  const shown = paths.slice(0, maxListed);
  const omitted = paths.length - shown.length;
  const listed = shown.join(', ') + (omitted > 0 ? ` (+${omitted} more)` : '');
  const n = paths.length;
  const noun = n === 1 ? 'path' : 'paths';
  const them = n === 1 ? 'It is' : 'They are';
  return (
    `${n} untracked ${noun} will not appear in the session worktree: ${listed}. ` +
    `${them} only in the main checkout — track them, or launch with --no-worktree.`
  );
}

export function worktreeCheckEnabled(
  env: Record<string, string>,
  worktree?: boolean,
): boolean {
  if (worktree === false) return false;
  if (worktree === true) return true;
  return (env.HARNESS_USE_WORKTREE ?? 'true').toLowerCase() !== 'false';
}
