import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface WorktreeCleanupTarget {
  agentId?: number;
  worktreePath: string;
}

export interface WorktreeCleanupResult {
  path: string;
  agentId?: number;
  deleted: boolean;
  error?: string;
}

/**
 * Best-effort removal of session worktrees on the host filesystem.
 * Inside the packaged Docker image host paths are usually invisible — those
 * targets are reported as not deleted so the CLI can finish the job.
 */
export function cleanupSessionWorktrees(
  repoPath: string,
  targets: WorktreeCleanupTarget[],
): WorktreeCleanupResult[] {
  const results: WorktreeCleanupResult[] = [];
  const seen = new Set<string>();

  for (const target of targets) {
    const worktreePath = path.resolve(target.worktreePath);
    if (!worktreePath || seen.has(worktreePath)) continue;
    seen.add(worktreePath);

    if (!fs.existsSync(worktreePath)) {
      results.push({
        path: worktreePath,
        agentId: target.agentId,
        deleted: false,
        error:
          'path not visible to Mission Control (use har env teardown <id> or delete the worktree on the host)',
      });
      continue;
    }

    try {
      const gitRemove = spawnSync(
        'git',
        ['-C', repoPath, 'worktree', 'remove', worktreePath, '--force'],
        { encoding: 'utf8' },
      );
      if (gitRemove.status !== 0 && fs.existsSync(worktreePath)) {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
      results.push({
        path: worktreePath,
        agentId: target.agentId,
        deleted: !fs.existsSync(worktreePath),
        error:
          fs.existsSync(worktreePath)
            ? gitRemove.stderr?.trim() || 'failed to remove worktree'
            : undefined,
      });
    } catch (err: unknown) {
      results.push({
        path: worktreePath,
        agentId: target.agentId,
        deleted: !fs.existsSync(worktreePath),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
