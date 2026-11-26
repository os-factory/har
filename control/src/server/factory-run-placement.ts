import type { PrismaClient } from '@prisma/client';
import { occupancyKeyForAttempt } from '@har/schemas';
import { prisma } from '@/lib/db';

type Db = Pick<PrismaClient, 'attempt' | 'agentSlot' | 'factoryRun'>;

/**
 * Where a factory run happened, derived by Mission Control from its attempt.
 *
 * A v2 `FactoryRun` record names its attempt only (ADR 0005 section 3; no
 * local paths, no slot). The slot views, History and the attempt record key
 * runs by slot, occupancy and work dir, as 1.x runs carried them. They follow
 * from the attempt: the occupancy is the attempt's (`attempt::<id>`), the slot
 * number its `slotId`, and the work dir the live slot view's for that
 * occupancy. Records arrive in any order, so this runs whenever a factory run,
 * an attempt or a slot is written, and only fills what is still empty.
 */
export async function placeFactoryRunsOfAttempt(attemptId: string | null | undefined, db: Db = prisma): Promise<void> {
  if (!attemptId) return;
  const occupancyKey = occupancyKeyForAttempt(attemptId);
  const [attempt, slot] = await Promise.all([
    db.attempt.findUnique({ where: { attemptId }, select: { agentId: true, workDir: true, worktreePath: true } }),
    db.agentSlot.findFirst({
      where: { OR: [{ occupancyKey }, { attemptId }] },
      select: { slotId: true, workDir: true, worktreePath: true },
    }),
  ]);
  const agentId = attempt?.agentId ?? slot?.slotId ?? null;
  const workDir = attempt?.workDir ?? attempt?.worktreePath ?? slot?.workDir ?? slot?.worktreePath ?? null;
  await db.factoryRun.updateMany({ where: { attemptId, occupancyKey: null }, data: { occupancyKey } });
  if (agentId != null) await db.factoryRun.updateMany({ where: { attemptId, agentId: null }, data: { agentId } });
  if (workDir) await db.factoryRun.updateMany({ where: { attemptId, workDir: null }, data: { workDir } });
}

/** Best effort: placement must never fail an ingest. */
export async function placeFactoryRunsOfAttemptSafely(attemptId: string | null | undefined, db?: Db): Promise<void> {
  try {
    await placeFactoryRunsOfAttempt(attemptId, db);
  } catch {
    // the next write of the run, attempt or slot tries again
  }
}
