import type { AgentTrajectoryRecord as CanonicalTrajectoryRecord } from '@har/schemas';
import { Prisma, type AgentTrajectoryRecord } from '@prisma/client';
import { createHash } from 'node:crypto';
import { prisma } from '@/lib/db';
import { boundTrajectoryPayload, trajectoryPolicy } from '@/lib/trajectory-privacy';
import type {
  SerializedTrajectoryPage,
  SerializedTrajectoryRecord,
  TrajectoryStream,
} from '@/lib/trajectory';
import { projectTrajectoryRecord } from '@/server/trajectory-projections';

export interface TrajectoryCursor {
  sequence: number;
  timestamp: string;
  source: string;
  sourceEventId: string;
  contentKey: string;
  id: string;
}

export interface TrajectoryScope {
  repositoryId: string;
  agentId: number;
  sessionKey: string;
  agentTool: string;
}

export interface TrajectoryPage {
  records: AgentTrajectoryRecord[];
  hasMore: boolean;
  nextBefore: string | null;
  latest: string | null;
}

export interface AppendTrajectoryResult {
  record: AgentTrajectoryRecord;
  inserted: boolean;
}

export interface SlotTrajectoryData {
  streams: TrajectoryStream[];
  initialPage: SerializedTrajectoryPage;
}

type TrajectoryListener = (record: AgentTrajectoryRecord) => void;

const globalBus = globalThis as unknown as {
  trajectoryListeners?: Set<TrajectoryListener>;
};
const listeners = (globalBus.trajectoryListeners ??= new Set());

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function stableTrajectoryKey(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function cursorForTrajectory(record: Pick<
  AgentTrajectoryRecord,
  'sequence' | 'eventTimestamp' | 'source' | 'sourceEventId' | 'contentKey' | 'id'
>): string {
  return Buffer.from(
    JSON.stringify({
      sequence: record.sequence,
      timestamp: record.eventTimestamp.toISOString(),
      source: record.source,
      sourceEventId: record.sourceEventId,
      contentKey: record.contentKey,
      id: record.id,
    } satisfies TrajectoryCursor),
  ).toString('base64url');
}

export function decodeTrajectoryCursor(value: string): TrajectoryCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<TrajectoryCursor>;
    if (
      !Number.isInteger(parsed.sequence) ||
      typeof parsed.timestamp !== 'string' ||
      !Number.isFinite(new Date(parsed.timestamp).getTime()) ||
      typeof parsed.source !== 'string' ||
      typeof parsed.sourceEventId !== 'string' ||
      typeof parsed.contentKey !== 'string' ||
      typeof parsed.id !== 'string'
    ) {
      throw new Error('invalid fields');
    }
    return parsed as TrajectoryCursor;
  } catch {
    throw new Error('Invalid trajectory cursor');
  }
}

export function compareTrajectoryOrder(
  left: TrajectoryCursor,
  right: TrajectoryCursor,
): number {
  return (
    left.sequence - right.sequence ||
    left.timestamp.localeCompare(right.timestamp) ||
    left.source.localeCompare(right.source) ||
    left.sourceEventId.localeCompare(right.sourceEventId) ||
    left.contentKey.localeCompare(right.contentKey) ||
    left.id.localeCompare(right.id)
  );
}

function cursorWhere(cursor: TrajectoryCursor, direction: 'before' | 'after'): Prisma.AgentTrajectoryRecordWhereInput {
  const operator = direction === 'before' ? 'lt' : 'gt';
  const timestamp = new Date(cursor.timestamp);
  return {
    OR: [
      { sequence: { [operator]: cursor.sequence } },
      { sequence: cursor.sequence, eventTimestamp: { [operator]: timestamp } },
      {
        sequence: cursor.sequence,
        eventTimestamp: timestamp,
        source: { [operator]: cursor.source },
      },
      {
        sequence: cursor.sequence,
        eventTimestamp: timestamp,
        source: cursor.source,
        sourceEventId: { [operator]: cursor.sourceEventId },
      },
      {
        sequence: cursor.sequence,
        eventTimestamp: timestamp,
        source: cursor.source,
        sourceEventId: cursor.sourceEventId,
        contentKey: { [operator]: cursor.contentKey },
      },
      {
        sequence: cursor.sequence,
        eventTimestamp: timestamp,
        source: cursor.source,
        sourceEventId: cursor.sourceEventId,
        contentKey: cursor.contentKey,
        id: { [operator]: cursor.id },
      },
    ],
  };
}

const ascendingOrder = [
  { sequence: 'asc' },
  { eventTimestamp: 'asc' },
  { source: 'asc' },
  { sourceEventId: 'asc' },
  { contentKey: 'asc' },
  { id: 'asc' },
] satisfies Prisma.AgentTrajectoryRecordOrderByWithRelationInput[];

const descendingOrder = ascendingOrder.map((field) => {
  const key = Object.keys(field)[0] as keyof typeof field;
  return { [key]: 'desc' };
}) as Prisma.AgentTrajectoryRecordOrderByWithRelationInput[];

function scopeWhere(scope: TrajectoryScope): Prisma.AgentTrajectoryRecordWhereInput {
  return {
    repositoryId: scope.repositoryId,
    agentId: scope.agentId,
    sessionKey: scope.sessionKey,
    agentTool: scope.agentTool,
  };
}

const globalRetention = globalThis as unknown as {
  trajectoryRetentionAt?: number;
};

export async function appendTrajectoryRecord(
  repositoryId: string,
  input: CanonicalTrajectoryRecord,
): Promise<AppendTrajectoryResult> {
  const { maxPayloadBytes } = trajectoryPolicy();
  const bounded = boundTrajectoryPayload(input.payload, input.contentDisclosure, maxPayloadBytes);
  try {
    const record = await prisma.agentTrajectoryRecord.create({
      data: {
        repositoryId,
        version: input.version,
        source: input.source,
        sourceEventId: input.sourceEventId,
        contentKey: input.contentKey,
        sessionKey: input.sessionKey,
        agentId: input.agentId,
        agentTool: input.agentTool,
        eventType: input.eventType,
        sequence: input.sequence,
        eventTimestamp: new Date(input.timestamp),
        payload: bounded.payload as Prisma.InputJsonValue,
        contentKind: input.contentKind,
        contentDisclosure: bounded.contentDisclosure,
        contentLabel: input.contentLabel,
        traceId: input.traceId,
        spanId: input.spanId,
        parentSpanId: input.parentSpanId,
        generationId: input.generationId,
        toolCallId: input.toolCallId,
        correlationId: input.correlationId,
        workUnitId: input.workUnitId,
        attemptId: input.attemptId,
      },
    });
    await projectTrajectoryRecord(record);
    await maybeExpireTrajectoryRecords();
    for (const listener of listeners) {
      try {
        listener(record);
      } catch {
        // A disconnected subscriber must not turn a durable insert into a failure.
      }
    }
    return { record, inserted: true };
  } catch (error: unknown) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      throw error;
    }
    const record = await prisma.agentTrajectoryRecord.findUniqueOrThrow({
      where: {
        repositoryId_source_sourceEventId_contentKey: {
          repositoryId,
          source: input.source,
          sourceEventId: input.sourceEventId,
          contentKey: input.contentKey,
        },
      },
    });
    return { record, inserted: false };
  }
}

export async function listTrajectoryHistory(
  scope: TrajectoryScope,
  options: { before?: string; limit?: number } = {},
): Promise<TrajectoryPage> {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 200));
  const before = options.before ? decodeTrajectoryCursor(options.before) : null;
  const rows = await prisma.agentTrajectoryRecord.findMany({
    where: {
      ...scopeWhere(scope),
      ...(before ? { AND: [cursorWhere(before, 'before')] } : {}),
    },
    orderBy: descendingOrder,
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const records = rows.slice(0, limit).reverse();
  return {
    records,
    hasMore,
    nextBefore: hasMore && records[0] ? cursorForTrajectory(records[0]) : null,
    latest: records.at(-1) ? cursorForTrajectory(records.at(-1)!) : null,
  };
}

export async function listTrajectoryAfter(
  scope: TrajectoryScope,
  after: string,
  limit = 1_000,
): Promise<AgentTrajectoryRecord[]> {
  const cursor = decodeTrajectoryCursor(after);
  return prisma.agentTrajectoryRecord.findMany({
    where: { ...scopeWhere(scope), AND: [cursorWhere(cursor, 'after')] },
    orderBy: ascendingOrder,
    take: Math.max(1, Math.min(limit, 1_000)),
  });
}

export function serializeTrajectoryRecord(
  record: AgentTrajectoryRecord,
): SerializedTrajectoryRecord {
  return {
    ...record,
    eventTimestamp: record.eventTimestamp.toISOString(),
    createdAt: record.createdAt.toISOString(),
    payload: record.payload,
    contentDisclosure: record.contentDisclosure as SerializedTrajectoryRecord['contentDisclosure'],
  };
}

export function serializeTrajectoryPage(page: TrajectoryPage): SerializedTrajectoryPage {
  return {
    ...page,
    records: page.records.map(serializeTrajectoryRecord),
  };
}

export async function listTrajectoryStreams(
  repositoryId: string,
  agentId: number,
): Promise<TrajectoryStream[]> {
  const groups = await prisma.agentTrajectoryRecord.groupBy({
    by: ['sessionKey', 'agentTool'],
    where: { repositoryId, agentId },
    _max: { eventTimestamp: true },
  });
  return groups.flatMap((group) => group._max.eventTimestamp
    ? [{
        sessionKey: group.sessionKey,
        agentTool: group.agentTool,
        latestTimestamp: group._max.eventTimestamp.toISOString(),
      }]
    : []).sort((left, right) => (
      right.latestTimestamp.localeCompare(left.latestTimestamp) ||
      left.sessionKey.localeCompare(right.sessionKey) ||
      left.agentTool.localeCompare(right.agentTool)
    ));
}

export async function getSlotTrajectoryData(
  repositoryId: string,
  agentId: number,
  limit = 100,
): Promise<SlotTrajectoryData> {
  const streams = await listTrajectoryStreams(repositoryId, agentId);
  const latest = streams[0];
  if (!latest) {
    return {
      streams: [],
      initialPage: { records: [], hasMore: false, nextBefore: null, latest: null },
    };
  }
  const page = await listTrajectoryHistory({
    repositoryId,
    agentId,
    sessionKey: latest.sessionKey,
    agentTool: latest.agentTool,
  }, { limit });
  return { streams, initialPage: serializeTrajectoryPage(page) };
}

export async function listTrajectoryExport(
  scope: TrajectoryScope,
): Promise<AgentTrajectoryRecord[]> {
  return prisma.agentTrajectoryRecord.findMany({
    where: scopeWhere(scope),
    orderBy: ascendingOrder,
  });
}

export async function deleteTrajectoryScope(scope: TrajectoryScope): Promise<{ deleted: number }> {
  const result = await prisma.agentTrajectoryRecord.deleteMany({ where: scopeWhere(scope) });
  await prisma.agentSessionEvent.deleteMany({
    where: {
      repositoryId: scope.repositoryId,
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
      agentTool: scope.agentTool,
    },
  });
  await prisma.agentSessionSpan.deleteMany({
    where: {
      repositoryId: scope.repositoryId,
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
      agentTool: scope.agentTool,
    },
  });
  return { deleted: result.count };
}

export async function expireTrajectoryRecords(now = new Date()): Promise<number> {
  const { retentionDays } = trajectoryPolicy();
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const result = await prisma.agentTrajectoryRecord.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  await prisma.agentSessionEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  await prisma.agentSessionSpan.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return result.count;
}

async function maybeExpireTrajectoryRecords(): Promise<void> {
  const { retentionDays } = trajectoryPolicy();
  if (retentionDays <= 0) return;
  const last = globalRetention.trajectoryRetentionAt ?? 0;
  if (Date.now() - last < 60_000) return;
  globalRetention.trajectoryRetentionAt = Date.now();
  await expireTrajectoryRecords();
}

export function subscribeToTrajectory(
  scope: TrajectoryScope,
  listener: TrajectoryListener,
): () => void {
  const scoped: TrajectoryListener = (record) => {
    if (
      record.repositoryId === scope.repositoryId &&
      record.agentId === scope.agentId &&
      record.sessionKey === scope.sessionKey &&
      record.agentTool === scope.agentTool
    ) {
      listener(record);
    }
  };
  listeners.add(scoped);
  return () => listeners.delete(scoped);
}
