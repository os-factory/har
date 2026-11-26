import type { FactoryRun, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * A factory run as the 1.x "change batch" (a verified tree snapshot) readers
 * expect: History, slot timelines and the diff view read this shape.
 */
export interface ChangeBatchView {
  id: string;
  repositoryId: string | null;
  validationId: string;
  treeHash: string;
  headSha: string | null;
  branch: string | null;
  workDir: string | null;
  agentId: number | null;
  status: string;
  full: boolean;
  runId: string | null;
  changedFiles: Prisma.JsonValue | null;
  commitSha: string | null;
  committedAt: Date | null;
  occupancyKey: string | null;
  attemptId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function changeBatchView(run: FactoryRun): ChangeBatchView {
  return {
    id: run.id,
    repositoryId: run.repositoryId,
    validationId: run.factoryRunId,
    treeHash: run.tree,
    headSha: run.headSha,
    branch: run.branch,
    workDir: run.workDir,
    agentId: run.agentId,
    status: run.status ?? run.verdict ?? 'unknown',
    full: run.full,
    runId: run.runId,
    changedFiles: run.changedFiles,
    commitSha: run.commitSha,
    committedAt: run.committedAt,
    occupancyKey: run.occupancyKey,
    attemptId: run.attemptId,
    createdAt: run.startedAt,
    updatedAt: run.updatedAt,
  };
}

/** Factory runs that verified a tree: a run known only from a 1.x validation binding has no status yet. */
export const VERIFIED_RUN = { status: { not: null }, tree: { not: '' } } as const;

/** A repository's verified trees (its change batches), newest first per branch. */
export async function listChangeBatches(repositoryId: string, limit = 100): Promise<ChangeBatchView[]> {
  const runs = await prisma.factoryRun.findMany({
    where: { repositoryId, ...VERIFIED_RUN },
    orderBy: [{ branch: 'asc' }, { startedAt: 'desc' }],
    take: limit,
  });
  return runs.map(changeBatchView);
}
