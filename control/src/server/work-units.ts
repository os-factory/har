import { Prisma } from '@prisma/client';
import {
  SyncValidationBindingsInputSchema,
  SyncWorkUnitsInputSchema,
} from '@har/schemas';
import { prisma } from '@/lib/db';

export async function syncWorkUnits(repositoryId: string, input: unknown) {
  const { workUnits, attempts } = SyncWorkUnitsInputSchema.parse(input);

  for (const unit of workUnits) {
    await prisma.workUnit.upsert({
      where: {
        repositoryId_workUnitId: { repositoryId, workUnitId: unit.workUnitId },
      },
      create: {
        repositoryId,
        workUnitId: unit.workUnitId,
        source: unit.source,
        sourceUrl: unit.sourceUrl,
        title: unit.title,
        parentWorkUnitId: unit.parentWorkUnitId,
        relatedLinks: unit.relatedLinks
          ? (unit.relatedLinks as Prisma.InputJsonValue)
          : undefined,
        outcome: unit.outcome
          ? (unit.outcome as Prisma.InputJsonValue)
          : undefined,
        sourceCreatedAt: new Date(unit.createdAt),
        sourceUpdatedAt: new Date(unit.updatedAt),
      },
      update: {
        source: unit.source,
        sourceUrl: unit.sourceUrl,
        title: unit.title,
        parentWorkUnitId: unit.parentWorkUnitId,
        relatedLinks: unit.relatedLinks
          ? (unit.relatedLinks as Prisma.InputJsonValue)
          : undefined,
        outcome: unit.outcome
          ? (unit.outcome as Prisma.InputJsonValue)
          : Prisma.DbNull,
        sourceUpdatedAt: new Date(unit.updatedAt),
      },
    });
  }

  for (const attempt of attempts) {
    const workUnit = await prisma.workUnit.findUnique({
      where: {
        repositoryId_workUnitId: {
          repositoryId,
          workUnitId: attempt.workUnitId,
        },
      },
      select: { id: true },
    });
    if (!workUnit) continue;
    await prisma.workAttempt.upsert({
      where: {
        repositoryId_attemptId: { repositoryId, attemptId: attempt.attemptId },
      },
      create: {
        repositoryId,
        workUnitDbId: workUnit.id,
        attemptId: attempt.attemptId,
        agentId: attempt.agentId,
        sessionKey: attempt.sessionKey,
        workDir: attempt.workDir,
        worktreePath: attempt.worktreePath,
        branch: attempt.branch,
        baseCommit: attempt.baseCommit,
        sourceCreatedAt: new Date(attempt.createdAt),
      },
      update: {
        sessionKey: attempt.sessionKey,
        workDir: attempt.workDir,
        worktreePath: attempt.worktreePath,
        branch: attempt.branch,
        baseCommit: attempt.baseCommit,
      },
    });
  }

  return { synced: workUnits.length, attempts: attempts.length };
}

export async function syncValidationBindings(repositoryId: string, input: unknown) {
  const { bindings } = SyncValidationBindingsInputSchema.parse(input);
  let synced = 0;
  for (const binding of bindings) {
    const [workUnit, attempt] = await Promise.all([
      prisma.workUnit.findUnique({
        where: {
          repositoryId_workUnitId: {
            repositoryId,
            workUnitId: binding.workUnitId,
          },
        },
        select: { id: true },
      }),
      prisma.workAttempt.findUnique({
        where: {
          repositoryId_attemptId: {
            repositoryId,
            attemptId: binding.attemptId,
          },
        },
        select: { id: true },
      }),
    ]);
    if (!workUnit || !attempt) continue;
    await prisma.validationBinding.upsert({
      where: {
        repositoryId_bindingId: { repositoryId, bindingId: binding.bindingId },
      },
      create: {
        repositoryId,
        bindingId: binding.bindingId,
        workUnitDbId: workUnit.id,
        attemptDbId: attempt.id,
        validationId: binding.validationId,
        treeHash: binding.treeHash,
        sourceCreatedAt: new Date(binding.createdAt),
      },
      update: {
        validationId: binding.validationId,
        treeHash: binding.treeHash,
      },
    });
    synced += 1;
  }
  return { synced };
}

export async function listFactoryWorkUnits(repositoryId?: string) {
  const units = await prisma.workUnit.findMany({
    where: repositoryId ? { repositoryId } : undefined,
    include: {
      repository: { select: { id: true, path: true, gitRemote: true } },
      attempts: { orderBy: { sourceCreatedAt: 'desc' } },
      validationBindings: { orderBy: { sourceCreatedAt: 'desc' } },
    },
    orderBy: { sourceUpdatedAt: 'desc' },
  });

  return Promise.all(
    units.map(async (unit) => {
      const [slots, runs, usage, validations] = await Promise.all([
        prisma.agentSlot.findMany({
          where: { repositoryId: unit.repositoryId, workUnitId: unit.workUnitId },
          orderBy: [{ active: 'desc' }, { updatedAt: 'desc' }],
        }),
        prisma.run.findMany({
          where: { repositoryId: unit.repositoryId, workUnitId: unit.workUnitId },
          orderBy: { startedAt: 'desc' },
          take: 100,
        }),
        prisma.agentSessionUsage.aggregate({
          where: { repositoryId: unit.repositoryId, workUnitId: unit.workUnitId },
          _sum: { tokensTotal: true, costUsd: true },
        }),
        prisma.changeBatch.findMany({
          where: {
            repositoryId: unit.repositoryId,
            validationId: {
              in: unit.validationBindings.map((binding) => binding.validationId),
            },
          },
        }),
      ]);
      const slot = slots.find((candidate) => candidate.active) ?? null;
      return { ...unit, slot, slots, runs, usage: usage._sum, validations };
    }),
  );
}

export async function getFactoryWorkUnit(repositoryId: string, workUnitId: string) {
  const units = await listFactoryWorkUnits(repositoryId);
  return units.find((unit) => unit.workUnitId === workUnitId) ?? null;
}

export async function getFactoryWorkUnitById(id: string) {
  const record = await prisma.workUnit.findUnique({
    where: { id },
    select: { repositoryId: true, workUnitId: true },
  });
  if (!record) return null;
  return getFactoryWorkUnit(record.repositoryId, record.workUnitId);
}
