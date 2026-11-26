import type { FactoryRun, Prisma } from '@prisma/client';
import { SyncValidationsInputSchema, ValidationRecordSchema } from '@har/schemas';
import { prisma } from '@/lib/db';
import { resolveRecordOccupancyKey } from '@/server/occupancy';
import { listOccupancyCandidates } from '@/server/repositories';
import { repositoryKeyFor } from '@/server/repository-key';

function toJson(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as object;
}

/**
 * Validations a 1.x `har control sync` sends (one per verified tree) are
 * factory runs keyed by their validation id (ADR 0005 section 3). A 2.0 CLI
 * sends `FactoryRun` records to `POST v2/records` instead.
 */
export async function syncChangeBatches(repositoryId: string, input: unknown) {
  const { validations } = SyncValidationsInputSchema.parse(input);
  const slots = await listOccupancyCandidates(repositoryId);
  const repository = await prisma.repository.findUnique({ where: { id: repositoryId }, select: { id: true, gitRemote: true } });
  if (!repository) throw new Error(`unknown repository ${repositoryId}`);
  const repositoryKey = repositoryKeyFor(repository);

  for (const validation of validations) {
    const parsed = ValidationRecordSchema.parse(validation);
    const occupancyKey = resolveRecordOccupancyKey(
      { agentId: parsed.agentId, workDir: parsed.workDir, at: new Date(parsed.createdAt) },
      slots,
    );
    const data = {
      tree: parsed.treeHash,
      headSha: parsed.headSha,
      branch: parsed.branch,
      workDir: parsed.workDir,
      agentId: parsed.agentId,
      status: parsed.status,
      full: parsed.full,
      runId: parsed.runId,
      changedFiles: toJson(parsed.changedFiles),
      commitSha: parsed.commitSha,
      committedAt: parsed.committedAt ? new Date(parsed.committedAt) : null,
    };
    await prisma.factoryRun.upsert({
      where: { factoryRunId: parsed.validationId },
      create: {
        factoryRunId: parsed.validationId,
        repositoryId,
        repositoryKey,
        startedAt: new Date(parsed.createdAt),
        occupancyKey,
        ...data,
      },
      // Keep a key stamped earlier: a later sync may run after the slot moved on.
      update: { ...data, repositoryId, ...(occupancyKey ? { occupancyKey } : {}) },
    });
  }

  return { synced: validations.length };
}

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
