import { SyncValidationsInputSchema, ValidationRecordSchema } from '@har/schemas';
import { prisma } from '@/lib/db';
import { resolveRecordOccupancyKey } from '@/server/occupancy';
import { listOccupancyCandidates } from '@/server/repositories';

function toJson(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as object;
}

export async function syncChangeBatches(repositoryId: string, input: unknown) {
  const { validations } = SyncValidationsInputSchema.parse(input);
  const slots = await listOccupancyCandidates(repositoryId);

  for (const validation of validations) {
    const parsed = ValidationRecordSchema.parse(validation);
    const occupancyKey = resolveRecordOccupancyKey(
      { agentId: parsed.agentId, workDir: parsed.workDir, at: new Date(parsed.createdAt) },
      slots,
    );
    const data = {
      validationId: parsed.validationId,
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
    await prisma.changeBatch.upsert({
      where: { repositoryId_treeHash: { repositoryId, treeHash: parsed.treeHash } },
      create: {
        repositoryId,
        treeHash: parsed.treeHash,
        createdAt: new Date(parsed.createdAt),
        occupancyKey,
        ...data,
      },
      // Keep a key stamped earlier: a later sync may run after the slot moved on.
      update: { ...data, ...(occupancyKey ? { occupancyKey } : {}) },
    });
  }

  return { synced: validations.length };
}

export async function listChangeBatches(repositoryId: string, limit = 100) {
  return prisma.changeBatch.findMany({
    where: { repositoryId },
    orderBy: [{ branch: 'asc' }, { createdAt: 'desc' }],
    take: limit,
  });
}
