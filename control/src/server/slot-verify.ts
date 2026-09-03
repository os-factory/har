import type { AgentSlot, Run } from '@prisma/client';
import { prisma } from '@/lib/db';

export interface LatestVerify {
  status: string;
  startedAt: Date;
  runId: string;
}

/** Pure part: newest verify run of each slot's current occupancy (#316, #339). */
export function latestVerifyBySlot(
  runs: Array<Pick<Run, 'repositoryId' | 'agentId' | 'stageId' | 'status' | 'startedAt' | 'workDir' | 'occupancyKey' | 'runId'>>,
  slots: Array<Pick<AgentSlot, 'repositoryId' | 'slotId' | 'sessionCreatedAt' | 'workDir' | 'occupancyKey'>>,
): Map<string, LatestVerify> {
  const key = (repositoryId: string, slotId: number) => `${repositoryId}:${slotId}`;
  const bySlot = new Map(slots.map((slot) => [key(slot.repositoryId, slot.slotId), slot]));
  const out = new Map<string, LatestVerify>();
  for (const run of [...runs].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())) {
    if (run.stageId !== 'verify' || run.agentId == null) continue;
    const k = key(run.repositoryId, run.agentId);
    if (out.has(k)) continue;
    const slot = bySlot.get(k);
    if (!slot) continue;
    const inOccupancy =
      slot.occupancyKey && run.occupancyKey
        ? run.occupancyKey === slot.occupancyKey
        : (!slot.sessionCreatedAt || run.startedAt >= slot.sessionCreatedAt) &&
          (!slot.workDir || !run.workDir || run.workDir === slot.workDir);
    if (!inOccupancy) continue;
    out.set(k, { status: run.status, startedAt: run.startedAt, runId: run.runId });
  }
  return out;
}

/** Latest verify run per slot, scoped to the current occupancy — "Last verify" must never read a launch or teardown. */
export async function loadLatestVerifyBySlot(
  slots: Array<Pick<AgentSlot, 'repositoryId' | 'slotId' | 'sessionCreatedAt' | 'workDir' | 'occupancyKey'>>,
): Promise<Map<string, LatestVerify>> {
  const repositoryIds = [...new Set(slots.map((slot) => slot.repositoryId))];
  if (repositoryIds.length === 0) return new Map();
  const runs = await prisma.run.findMany({
    where: { repositoryId: { in: repositoryIds }, stageId: 'verify' },
    orderBy: { startedAt: 'desc' },
    take: 100 * repositoryIds.length,
    select: { repositoryId: true, agentId: true, stageId: true, status: true, startedAt: true, workDir: true, occupancyKey: true, runId: true },
  });
  return latestVerifyBySlot(runs, slots);
}
