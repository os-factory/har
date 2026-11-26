import type { Prisma, SessionSegment } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * The ADR 0003 slot timeline of a session, stored as `SessionSegment` rows
 * (ADR 0005 section 3): each point (launch | release | workspace | observed)
 * is a row with `from` = its instant and no `to`. v2 segments
 * (`kind = "segment"`) carry a stamped attempt and are not timeline points:
 * stamped data needs no resolution (ADR 0004 section 6).
 */

/** A timeline point: a session-segment row read with the 1.x binding field names. */
export interface TimelinePointRow {
  id: string;
  repositoryId: string;
  agentTool: string;
  sessionId: string;
  subagentId: string;
  kind: string;
  slotId: number;
  occupancyKey: string | null;
  branch: string | null;
  at: Date;
  origin: string;
  createdAt: Date;
}

export const TIMELINE_POINT_WHERE = {
  kind: { not: 'segment' },
  slotId: { not: null },
  repositoryId: { not: null },
} satisfies Prisma.SessionSegmentWhereInput;

/**
 * The natural key of a timeline point: the 1.x unique
 * (repository, tool, session, subagent, kind, slot, at). `scripts/migrate-db.cjs`
 * builds the same JSON with SQLite's `json_array`.
 */
export function timelinePointKey(point: {
  repositoryId: string;
  agentTool: string;
  sessionId: string;
  subagentId?: string | null;
  kind: string;
  slotId: number;
  at: Date;
}): string {
  return JSON.stringify([
    'point',
    point.repositoryId,
    point.agentTool,
    point.sessionId,
    point.subagentId ?? '',
    point.kind,
    point.slotId,
    point.at.getTime(),
  ]);
}

export function timelinePointRow(row: SessionSegment): TimelinePointRow {
  return {
    id: row.id,
    repositoryId: row.repositoryId ?? '',
    agentTool: row.agentTool,
    sessionId: row.sessionId,
    subagentId: row.subagentId,
    kind: row.kind,
    slotId: row.slotId ?? 0,
    occupancyKey: row.occupancyKey,
    branch: row.branch,
    at: row.from,
    origin: row.origin,
    createdAt: row.createdAt,
  };
}

export async function findTimelinePoints(
  where: Prisma.SessionSegmentWhereInput,
  orderBy?: Prisma.SessionSegmentOrderByWithRelationInput[],
): Promise<TimelinePointRow[]> {
  // A filter the caller sets on kind, slot or repository is narrower than the point filter: it wins.
  const rows = await prisma.sessionSegment.findMany({ where: { ...TIMELINE_POINT_WHERE, ...where }, orderBy });
  return rows.map(timelinePointRow);
}
