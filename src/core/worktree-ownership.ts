import * as path from 'path';
import { run } from '../utils/shell';
import { resolveMainWorkingTree } from './control-repo-path';

/**
 * Whether the checkout at `repoRoot` is a linked worktree HAR did not create.
 *
 * `--no-worktree` collapses two different situations: running in the main
 * checkout, and running inside a worktree some external orchestrator created
 * (Conductor, Cursor worktrees, a hand-rolled `git worktree add`, a cloud
 * sandbox). They need different handling — most importantly, teardown may
 * remove a worktree HAR created and must never remove one it did not (#254).
 *
 * Detection is deliberately tool-agnostic: a linked worktree is one whose
 * top-level differs from the repository's main working tree. Nothing here
 * matches on the name of the tool that created it.
 */
export function detectInPlaceSlotMode(repoRoot: string): 'root' | 'external' {
  const resolved = path.resolve(repoRoot);

  const toplevel = run('git rev-parse --show-toplevel', { cwd: resolved });
  if (toplevel.code !== 0) return 'root';

  const mainRoot = resolveMainWorkingTree(resolved);
  if (!mainRoot) return 'root';

  return path.resolve(toplevel.stdout.trim()) === path.resolve(mainRoot) ? 'root' : 'external';
}

/** Checkout root of the worktree `repoRoot` sits in, or '' when not a git tree. */
export function resolveWorktreeRoot(repoRoot: string): string {
  const toplevel = run('git rev-parse --show-toplevel', { cwd: path.resolve(repoRoot) });
  return toplevel.code === 0 ? path.resolve(toplevel.stdout.trim()) : '';
}
