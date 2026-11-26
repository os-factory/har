import { Prisma, type Attempt, type WorkUnit } from '@prisma/client';
import {
  SyncValidationBindingsInputSchema,
  SyncWorkUnitsInputSchema,
  occupancyKeyForAttempt,
} from '@har/schemas';
import { prisma } from '@/lib/db';
import { attributeWorkUnitUsage } from '@/server/work-unit-usage';
import { claimLateSlotEvidenceSafely } from '@/server/late-slot-evidence';
import { changeBatchView } from '@/server/change-batches';
import { repositoryKeyFor, repositoryUrlOf } from '@/server/repository-key';

async function repositoryScope(repositoryId: string) {
  const repository = await prisma.repository.findUnique({ where: { id: repositoryId }, select: { id: true, gitRemote: true } });
  if (!repository) throw new Error(`unknown repository ${repositoryId}`);
  return { repositoryKey: repositoryKeyFor(repository), repositoryUrl: repositoryUrlOf(repository.gitRemote) };
}

/**
 * Work units and attempts a 1.x `har control sync` sends, stored in the v2
 * tables (ADR 0005 section 3). A 2.0 CLI sends `WorkUnit` and `Attempt`
 * records to `POST v2/records` instead.
 */
export async function syncWorkUnits(repositoryId: string, input: unknown) {
  const { workUnits, attempts } = SyncWorkUnitsInputSchema.parse(input);
  const { repositoryKey, repositoryUrl } = await repositoryScope(repositoryId);

  for (const unit of workUnits) {
    const data = {
      source: unit.source,
      sourceUrl: unit.sourceUrl,
      title: unit.title,
      parentWorkUnitId: unit.parentWorkUnitId,
      relatedLinks: unit.relatedLinks ? (unit.relatedLinks as Prisma.InputJsonValue) : undefined,
      sourceUpdatedAt: new Date(unit.updatedAt),
    };
    await prisma.workUnit.upsert({
      where: { repositoryKey_workUnitId: { repositoryKey, workUnitId: unit.workUnitId } },
      create: {
        repositoryKey,
        repositoryUrl,
        repositoryId,
        workUnitId: unit.workUnitId,
        ...data,
        outcome: unit.outcome ? (unit.outcome as Prisma.InputJsonValue) : undefined,
        sourceCreatedAt: new Date(unit.createdAt),
      },
      update: {
        ...data,
        outcome: unit.outcome ? (unit.outcome as Prisma.InputJsonValue) : Prisma.DbNull,
      },
    });
  }

  for (const attempt of attempts) {
    const data = {
      workUnitId: attempt.workUnitId,
      sessionKey: attempt.sessionKey,
      workDir: attempt.workDir,
      worktreePath: attempt.worktreePath,
      branch: attempt.branch,
      baseCommit: attempt.baseCommit,
    };
    await prisma.attempt.upsert({
      where: { attemptId: attempt.attemptId },
      create: {
        attemptId: attempt.attemptId,
        repositoryKey,
        repositoryUrl,
        repositoryId,
        slotId: String(attempt.agentId),
        agentId: attempt.agentId,
        startedAt: new Date(attempt.createdAt),
        ...data,
      },
      update: data,
    });
    // Tool events may have targeted the attempt's worktree before it was known.
    await claimLateSlotEvidenceSafely(repositoryId, {
      slotId: attempt.agentId,
      occupancyKey: occupancyKeyForAttempt(attempt.attemptId),
      branch: attempt.branch ?? null,
      workDir: attempt.workDir ?? attempt.worktreePath ?? null,
      since: new Date(attempt.createdAt),
    });
  }

  return { synced: workUnits.length, attempts: attempts.length };
}

/** A 1.x validation binding names the attempt a factory run belongs to. */
export async function syncValidationBindings(repositoryId: string, input: unknown) {
  const { bindings } = SyncValidationBindingsInputSchema.parse(input);
  const { repositoryKey } = await repositoryScope(repositoryId);
  let synced = 0;
  for (const binding of bindings) {
    const attempt = await prisma.attempt.findUnique({ where: { attemptId: binding.attemptId }, select: { id: true } });
    if (!attempt) continue;
    await prisma.factoryRun.upsert({
      where: { factoryRunId: binding.validationId },
      create: {
        factoryRunId: binding.validationId,
        repositoryId,
        repositoryKey,
        tree: binding.treeHash,
        attemptId: binding.attemptId,
        workUnitId: binding.workUnitId,
        startedAt: new Date(binding.createdAt),
      },
      update: { attemptId: binding.attemptId, workUnitId: binding.workUnitId },
    });
    synced += 1;
  }
  return { synced };
}

/** The attempts of a work unit, newest first. */
export async function attemptsOfWorkUnit(unit: Pick<WorkUnit, 'repositoryKey' | 'workUnitId'>): Promise<Attempt[]> {
  return prisma.attempt.findMany({
    where: { repositoryKey: unit.repositoryKey, workUnitId: unit.workUnitId },
    orderBy: { startedAt: 'desc' },
  });
}

async function factoryWorkUnit(unit: WorkUnit) {
  const attempts = await attemptsOfWorkUnit(unit);
  const repositoryIds = [
    ...new Set([unit.repositoryId, ...attempts.map((attempt) => attempt.repositoryId)].filter((id): id is string => Boolean(id))),
  ];
  const primaryRepositoryId = unit.repositoryId ?? repositoryIds[0] ?? null;
  const attemptIds = attempts.map((attempt) => attempt.attemptId);
  const [repository, slots, runs, factoryRuns, usage] = await Promise.all([
    primaryRepositoryId
      ? prisma.repository.findUnique({ where: { id: primaryRepositoryId }, select: { id: true, path: true, gitRemote: true } })
      : null,
    prisma.agentSlot.findMany({
      where: { repositoryId: { in: repositoryIds }, workUnitId: unit.workUnitId },
      orderBy: [{ active: 'desc' }, { updatedAt: 'desc' }],
    }),
    prisma.run.findMany({
      where: { repositoryId: { in: repositoryIds }, workUnitId: unit.workUnitId },
      orderBy: { startedAt: 'desc' },
      take: 100,
    }),
    prisma.factoryRun.findMany({
      where: {
        OR: [
          ...(attemptIds.length ? [{ attemptId: { in: attemptIds } }] : []),
          { repositoryKey: unit.repositoryKey, workUnitId: unit.workUnitId },
        ],
      },
      orderBy: { startedAt: 'desc' },
    }),
    primaryRepositoryId
      ? attributeWorkUnitUsage(primaryRepositoryId, unit.workUnitId, attempts)
      : Promise.resolve({ tokensTotal: null, costUsd: null, costSource: null, sessionCount: 0 }),
  ]);
  const slot = slots.find((candidate) => candidate.active) ?? null;
  const validations = factoryRuns.filter((run) => run.status != null && run.tree !== '').map(changeBatchView);
  // Factory runs bound to one of the unit's attempts (1.x: its validation bindings).
  const validationBindings = factoryRuns.filter((run) => run.attemptId != null);
  return { ...unit, repository, attempts, factoryRuns, validationBindings, slot, slots, runs, usage, validations };
}

export type FactoryWorkUnit = Awaited<ReturnType<typeof factoryWorkUnit>>;

/** Work units, newest first; with `repositoryId`, those of that registered repository or with an attempt in it. */
export async function listFactoryWorkUnits(repositoryId?: string): Promise<FactoryWorkUnit[]> {
  let where: Prisma.WorkUnitWhereInput | undefined;
  if (repositoryId) {
    const attempts = await prisma.attempt.findMany({
      where: { repositoryId, workUnitId: { not: null } },
      select: { repositoryKey: true, workUnitId: true },
    });
    where = {
      OR: [
        { repositoryId },
        ...attempts.map((attempt) => ({ repositoryKey: attempt.repositoryKey, workUnitId: attempt.workUnitId as string })),
      ],
    };
  }
  const units = await prisma.workUnit.findMany({ where, orderBy: { sourceUpdatedAt: 'desc' } });
  return Promise.all(units.map(factoryWorkUnit));
}

export async function getFactoryWorkUnit(repositoryId: string, workUnitId: string) {
  const units = await listFactoryWorkUnits(repositoryId);
  return units.find((unit) => unit.workUnitId === workUnitId) ?? null;
}

export async function getFactoryWorkUnitById(id: string) {
  const record = await prisma.workUnit.findUnique({ where: { id } });
  return record ? factoryWorkUnit(record) : null;
}

/** Lightweight work-unit facts for slot headers (tracker / PR links, #340). */
export async function getWorkUnitRef(repositoryId: string, workUnitId: string) {
  const repository = await prisma.repository.findUnique({ where: { id: repositoryId }, select: { id: true, gitRemote: true } });
  const select = { id: true, workUnitId: true, title: true, source: true, sourceUrl: true, relatedLinks: true } as const;
  if (repository) {
    const scoped = await prisma.workUnit.findUnique({
      where: { repositoryKey_workUnitId: { repositoryKey: repositoryKeyFor(repository), workUnitId } },
      select,
    });
    if (scoped) return scoped;
  }
  return prisma.workUnit.findFirst({ where: { repositoryId, workUnitId }, select });
}
