import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * Usage-bearing OTLP records whose session no repository could be resolved for
 * yet — typically a session started in a git worktree that Mission Control in
 * docker cannot list until the CLI reports it. They are kept here instead of
 * being dropped, and replayed (`replayParkedOtelRecords` in otel-ingest) when a
 * worktree listing arrives or a later record makes their session known.
 *
 * Records of sessions outside every registered repository never resolve; they
 * expire after `PARKED_TTL_MS`, and the table is capped at `PARKED_MAX_ROWS`.
 */
export type ParkedOtelSignal = 'span' | 'log';

export const PARKED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const PARKED_MAX_ROWS = 50_000;

export interface ParkedOtelRow {
  id: string;
  signal: ParkedOtelSignal;
  payload: unknown;
}

/** JSON-safe copy (dates as ISO strings, bigints as strings). */
function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item)),
  ) as Prisma.InputJsonValue;
}

export async function parkOtelRecord(input: {
  signal: ParkedOtelSignal;
  agentTool: string | null;
  sessionId: string | null;
  workspaceId: string | null;
  record: unknown;
}): Promise<void> {
  await prisma.parkedOtelRecord.create({
    data: {
      signal: input.signal,
      agentTool: input.agentTool,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      payload: toJson(input.record),
    },
  });
  await expireParkedOtelRecords();
}

async function expireParkedOtelRecords(now = Date.now()): Promise<void> {
  await prisma.parkedOtelRecord.deleteMany({ where: { createdAt: { lt: new Date(now - PARKED_TTL_MS) } } });
  const overflow = (await prisma.parkedOtelRecord.count()) - PARKED_MAX_ROWS;
  if (overflow <= 0) return;
  const oldest = await prisma.parkedOtelRecord.findMany({
    orderBy: { createdAt: 'asc' },
    take: overflow,
    select: { id: true },
  });
  await prisma.parkedOtelRecord.deleteMany({ where: { id: { in: oldest.map((row) => row.id) } } });
}

/** Parked records, oldest first: all of them, or those of the given sessions. */
export async function parkedOtelRecords(filter: { sessionIds?: string[]; limit?: number } = {}): Promise<ParkedOtelRow[]> {
  if (filter.sessionIds && filter.sessionIds.length === 0) return [];
  const rows = await prisma.parkedOtelRecord.findMany({
    where: filter.sessionIds ? { sessionId: { in: filter.sessionIds } } : {},
    orderBy: { createdAt: 'asc' },
    take: filter.limit ?? 2_000,
    select: { id: true, signal: true, payload: true },
  });
  return rows.map((row) => ({ id: row.id, signal: row.signal as ParkedOtelSignal, payload: row.payload }));
}

export async function deleteParkedOtelRecord(id: string): Promise<void> {
  await prisma.parkedOtelRecord.deleteMany({ where: { id } });
}
