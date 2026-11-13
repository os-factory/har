import {
  SyncGitWorktreesInputSchema,
  unresolvedWorkspaceOccupancyKey,
  workspaceIdFromUnresolvedOccupancyKey,
  worktreeOccupancyKey,
} from '@har/schemas';
import { prisma } from '@/lib/db';
import { parseReportedWorktrees } from '@/server/git-worktrees';
import { replayParkedOtelRecords } from '@/server/otel-ingest';
import { pickPathForWorkspaceId } from '@/server/otel-workspace';

/**
 * Store a repository's linked git worktrees as the CLI listed them on the host
 * (`har control sync`). Mission Control in docker sees only its data volume, so
 * this listing is how it maps otel-hook's hashed workspace id of a non-slot
 * worktree session back to that worktree.
 *
 * A new listing can name places that were unknown when their records arrived:
 * - bindings recorded for an unresolved place of a known session are renamed
 *   to the worktree the listing names (attribution is recomputed on read, so
 *   their usage moves to that worktree);
 * - parked records (sessions with no repository yet) are replayed.
 */
export async function syncReportedWorktrees(repositoryId: string, input: unknown) {
  const body = SyncGitWorktreesInputSchema.parse(input);
  const repo = await prisma.repository.findUnique({ where: { id: repositoryId }, select: { id: true } });
  if (!repo) throw new Error(`Repository not found: ${repositoryId}`);
  await prisma.repository.update({
    where: { id: repositoryId },
    data: {
      reportedWorktrees: body.worktrees.map(({ path, branch, head }) => ({ path, branch, head })),
      reportedWorktreesAt: new Date(body.generatedAt),
    },
  });

  const renamed = await renameResolvedPlaces(repositoryId, parseReportedWorktrees(body.worktrees));
  const parked = await replayParkedOtelRecords();
  return { worktrees: body.worktrees.length, renamedBindings: renamed, ...parked };
}

async function renameResolvedPlaces(
  repositoryId: string,
  worktrees: Array<{ path: string; branch: string | null }>,
): Promise<number> {
  if (worktrees.length === 0) return 0;
  const unresolved = await prisma.sessionSlotBinding.findMany({
    where: { repositoryId, occupancyKey: { startsWith: unresolvedWorkspaceOccupancyKey('') } },
    select: { occupancyKey: true },
    distinct: ['occupancyKey'],
  });
  let renamed = 0;
  for (const { occupancyKey } of unresolved) {
    const workspaceId = workspaceIdFromUnresolvedOccupancyKey(occupancyKey);
    if (!workspaceId) continue;
    const hit = pickPathForWorkspaceId(workspaceId, worktrees.map((worktree) => worktree.path));
    const worktree = hit ? worktrees.find((candidate) => candidate.path.replace(/[/\\]+$/, '') === hit) : undefined;
    if (!worktree) continue;
    const { count } = await prisma.sessionSlotBinding.updateMany({
      where: { repositoryId, occupancyKey },
      data: { occupancyKey: worktreeOccupancyKey({ workDir: worktree.path }), branch: worktree.branch },
    });
    renamed += count;
  }
  return renamed;
}

export async function getReportedWorktrees(repositoryId: string) {
  const repo = await prisma.repository.findUnique({
    where: { id: repositoryId },
    select: { reportedWorktrees: true, reportedWorktreesAt: true },
  });
  if (!repo) return null;
  return {
    worktrees: repo.reportedWorktrees ?? [],
    generatedAt: repo.reportedWorktreesAt?.toISOString() ?? null,
  };
}
