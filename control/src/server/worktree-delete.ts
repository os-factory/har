import * as fs from 'fs';
import * as path from 'path';
import {
  DeleteWorktreesInputSchema,
  type DeleteWorktreesResult,
} from '@har/schemas';
import { prisma } from '@/lib/db';
import { cleanupSessionWorktrees } from './worktree-cleanup';

function sessionPath(slot: { worktreePath: string | null; workDir: string | null }): string | null {
  const raw = slot.worktreePath ?? slot.workDir;
  if (!raw) return null;
  return path.resolve(raw);
}

/**
 * Delete selected session worktrees on disk and clear matching Mission Control
 * slot rows. Refuses to delete a repository's main checkout path.
 */
export async function deleteSessionWorktrees(input: unknown): Promise<DeleteWorktreesResult> {
  const options = DeleteWorktreesInputSchema.parse(input);
  const results: DeleteWorktreesResult['results'] = [];

  for (const target of options.worktrees) {
    const slot = await prisma.agentSlot.findUnique({
      where: {
        repositoryId_slotId: {
          repositoryId: target.repoId,
          slotId: target.slotId,
        },
      },
      include: { repository: { select: { id: true, path: true } } },
    });

    if (!slot) {
      results.push({
        repoId: target.repoId,
        slotId: target.slotId,
        path: '',
        deleted: false,
        clearedFromDashboard: false,
        error: 'slot not found',
      });
      continue;
    }

    const worktreePath = sessionPath(slot);
    if (!worktreePath) {
      await prisma.agentSlot.delete({ where: { id: slot.id } });
      results.push({
        repoId: target.repoId,
        slotId: target.slotId,
        path: '',
        deleted: true,
        clearedFromDashboard: true,
      });
      continue;
    }

    const repoPath = path.resolve(slot.repository.path);
    if (worktreePath === repoPath) {
      results.push({
        repoId: target.repoId,
        slotId: target.slotId,
        path: worktreePath,
        deleted: false,
        clearedFromDashboard: false,
        error: 'refusing to delete repository main checkout',
      });
      continue;
    }

    const onDisk = fs.existsSync(worktreePath);
    let deleted = false;
    let error: string | undefined;

    if (onDisk) {
      const cleanup = cleanupSessionWorktrees(repoPath, [
        { agentId: slot.slotId, worktreePath },
      ]);
      deleted = cleanup[0]?.deleted === true;
      error = cleanup[0]?.error;
    } else {
      deleted = false;
      error = 'path not visible to Mission Control (use har env teardown <id> on the host)';
    }

    const clearMissing = options.clearMissing && !onDisk;
    const clearedFromDashboard = deleted || clearMissing;

    if (clearedFromDashboard) {
      await prisma.agentSlot.delete({ where: { id: slot.id } });
    }

    results.push({
      repoId: target.repoId,
      slotId: target.slotId,
      path: worktreePath,
      deleted: deleted || clearMissing,
      clearedFromDashboard,
      error: deleted || clearMissing ? undefined : error,
    });
  }

  return { ok: true, results };
}
