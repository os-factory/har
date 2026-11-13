import { Prisma } from '@prisma/client';
import { MAIN_CHECKOUT_AGENT_ID, worktreeOccupancyKey, type AgentTool } from '@har/schemas';
import { prisma } from '@/lib/db';
import { timelineSlotAt } from '@/server/otel-attribution';

/**
 * Late slot evidence (ADR 0003).
 *
 * A tool event that targets a slot's worktree before Mission Control has heard
 * of that slot occupancy — the CLI syncs the slot after `har env launch`, or
 * not at all while Mission Control is down or the repo is outside the sync
 * selection — cannot be placed on the slot when it arrives. It is stored as a
 * non-slot worktree binding (`MAIN_CHECKOUT_AGENT_ID` naming the worktree), and
 * its span, event and trajectory rows are stamped as the main checkout's.
 *
 * Once a slot or work-attempt sync names the occupancy's branch and work dir,
 * that worktree is known to be the slot's: those bindings are moved onto the
 * occupancy and the session's rows from then on are placed again through the
 * binding timeline. Usage needs nothing more — it is derived from the
 * bindings on every read.
 */

export interface SyncedOccupancy {
  slotId: number;
  occupancyKey: string;
  branch: string | null;
  workDir: string | null;
  /** When the occupancy began; earlier evidence cannot be about it. */
  since: Date;
}

/** Rows re-placed per session in one pass; a race window is seconds long. */
const RESTAMP_LIMIT = 5000;

export async function claimLateSlotEvidence(
  repositoryId: string,
  occupancy: SyncedOccupancy,
): Promise<{ bindings: number; records: number }> {
  if (occupancy.slotId === MAIN_CHECKOUT_AGENT_ID || (!occupancy.branch && !occupancy.workDir)) {
    return { bindings: 0, records: 0 };
  }
  const worktreeKeys = [
    worktreeOccupancyKey({ workDir: occupancy.workDir }),
    worktreeOccupancyKey({ branch: occupancy.branch }),
  ].filter((key): key is string => Boolean(key));
  const stale = await prisma.sessionSlotBinding.findMany({
    where: {
      repositoryId,
      slotId: MAIN_CHECKOUT_AGENT_ID,
      kind: { in: ['observed', 'workspace'] },
      at: { gte: occupancy.since },
      OR: [
        ...(occupancy.branch ? [{ branch: occupancy.branch }] : []),
        { occupancyKey: { in: worktreeKeys } },
      ],
    },
  });
  if (stale.length === 0) return { bindings: 0, records: 0 };

  const sessions = new Map<string, { agentTool: AgentTool; sessionId: string; from: Date }>();
  for (const binding of stale) {
    try {
      await prisma.sessionSlotBinding.update({
        where: { id: binding.id },
        data: {
          slotId: occupancy.slotId,
          occupancyKey: occupancy.occupancyKey,
          branch: occupancy.branch ?? binding.branch,
        },
      });
    } catch (error) {
      // The same evidence already sits on the slot: the worktree copy is redundant.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
      await prisma.sessionSlotBinding.delete({ where: { id: binding.id } });
    }
    const key = `${binding.agentTool}\0${binding.sessionId}`;
    const seen = sessions.get(key);
    if (!seen || binding.at < seen.from) {
      sessions.set(key, { agentTool: binding.agentTool as AgentTool, sessionId: binding.sessionId, from: binding.at });
    }
  }

  let records = 0;
  for (const session of sessions.values()) {
    records += await restampSessionRecords(repositoryId, session);
  }
  return { bindings: stale.length, records };
}

/**
 * Place a session's main-checkout rows from `from` on again, now that its
 * timeline names a slot there. Rows its timeline still leaves on the main
 * checkout are untouched.
 */
async function restampSessionRecords(
  repositoryId: string,
  session: { agentTool: AgentTool; sessionId: string; from: Date },
): Promise<number> {
  const ref = { agentTool: session.agentTool, sessionId: session.sessionId };
  const scope = {
    repositoryId,
    sessionKey: session.sessionId,
    agentTool: session.agentTool,
    agentId: MAIN_CHECKOUT_AGENT_ID,
  };
  const [spans, events, trajectory] = await Promise.all([
    prisma.agentSessionSpan.findMany({
      where: { ...scope, startTime: { gte: session.from } },
      select: { id: true, startTime: true },
      take: RESTAMP_LIMIT,
    }),
    prisma.agentSessionEvent.findMany({
      where: { ...scope, timestamp: { gte: session.from } },
      select: { id: true, timestamp: true },
      take: RESTAMP_LIMIT,
    }),
    prisma.agentTrajectoryRecord.findMany({
      where: { ...scope, eventTimestamp: { gte: session.from } },
      select: { id: true, eventTimestamp: true },
      take: RESTAMP_LIMIT,
    }),
  ]);

  let restamped = 0;
  const place = async (at: Date) => timelineSlotAt(repositoryId, ref, at);
  for (const span of spans) {
    const slot = await place(span.startTime);
    if (!slot) continue;
    await prisma.agentSessionSpan.update({
      where: { id: span.id },
      data: { agentId: slot.slotId, workUnitId: slot.workUnitId, attemptId: slot.attemptId },
    });
    restamped += 1;
  }
  for (const event of events) {
    const slot = await place(event.timestamp);
    if (!slot) continue;
    await prisma.agentSessionEvent.update({
      where: { id: event.id },
      data: { agentId: slot.slotId, workUnitId: slot.workUnitId, attemptId: slot.attemptId },
    });
    restamped += 1;
  }
  for (const record of trajectory) {
    const slot = await place(record.eventTimestamp);
    if (!slot) continue;
    await prisma.agentTrajectoryRecord.update({
      where: { id: record.id },
      data: {
        agentId: slot.slotId,
        occupancyKey: slot.occupancyKey,
        workUnitId: slot.workUnitId,
        attemptId: slot.attemptId,
      },
    });
    restamped += 1;
  }
  return restamped;
}

/** Claim late evidence without failing the sync that revealed the occupancy. */
export async function claimLateSlotEvidenceSafely(repositoryId: string, occupancy: SyncedOccupancy): Promise<void> {
  try {
    await claimLateSlotEvidence(repositoryId, occupancy);
  } catch (error) {
    console.warn(
      `[session-attribution] could not move late evidence onto slot ${occupancy.slotId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}
