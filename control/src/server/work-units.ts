import { Prisma, type Attempt, type WorkUnit } from '@prisma/client';
import { listRuns } from '@/server/run-history';
import { prisma } from '@/lib/db';
import { attributeWorkUnitUsage } from '@/server/work-unit-usage';
import { changeBatchView } from '@/server/change-batches';
import { repositoryKeyFor } from '@/server/repository-key';

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
    listRuns({ repositoryIds, workUnitId: unit.workUnitId, take: 100 }),
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
