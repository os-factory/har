import type { Prisma } from '@prisma/client';
import { AgentTrajectoryRecordSchema } from '@har/schemas';
import { prisma } from '@/lib/db';
import { boundTrajectoryPayload } from '@/lib/trajectory-privacy';
import { clampPageLimit, createdAtKeyset } from '@/server/pagination';

export interface SessionEventInput {
  sessionKey: string;
  agentId: number;
  agentTool: string;
  eventName: string;
  sequence: number;
  timestamp: Date;
  attributes?: Prisma.InputJsonValue;
  promptText?: string | null;
  responseText?: string | null;
  rawTruncated?: string | null;
  source?: string;
  workUnitId?: string;
  attemptId?: string;
}

const PROMPT_MAX = 8_000;
const RAW_MAX = 4_000;

function trunc(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

export async function upsertSessionEvent(repositoryId: string, input: SessionEventInput) {
  const fields = {
    agentId: input.agentId,
    timestamp: input.timestamp,
    attributes: input.attributes,
    promptText: trunc(input.promptText, PROMPT_MAX),
    responseText: trunc(input.responseText, PROMPT_MAX),
    rawTruncated: trunc(input.rawTruncated, RAW_MAX),
    source: input.source ?? 'otel',
    workUnitId: input.workUnitId,
    attemptId: input.attemptId,
  };

  return prisma.agentSessionEvent.upsert({
    where: {
      repositoryId_sessionKey_agentTool_eventName_sequence: {
        repositoryId,
        sessionKey: input.sessionKey,
        agentTool: input.agentTool,
        eventName: input.eventName,
        sequence: input.sequence,
      },
    },
    create: {
      repositoryId,
      sessionKey: input.sessionKey,
      agentTool: input.agentTool,
      eventName: input.eventName,
      sequence: input.sequence,
      ...fields,
    },
    update: fields,
  });
}

export async function listSessionEventsForSlot(repositoryId: string, agentId: number) {
  return prisma.agentSessionEvent.findMany({
    where: { repositoryId, agentId },
    orderBy: { timestamp: 'desc' },
    take: 500,
  });
}

const REPO_EVENTS_LIMIT = 1_000;
const REPO_EVENTS_MAX_LIMIT = 5_000;

export async function listSessionEventsForRepo(
  repositoryId: string,
  options: { since?: string | null; sinceId?: string | null; limit?: number } = {},
) {
  return prisma.agentSessionEvent.findMany({
    where: { repositoryId, ...createdAtKeyset(options) },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: clampPageLimit(options.limit, REPO_EVENTS_LIMIT, REPO_EVENTS_MAX_LIMIT),
  });
}

export async function syncSessionEvents(repositoryId: string, events: SessionEventInput[]) {
  const { appendTrajectoryRecord, stableTrajectoryKey } = await import('@/server/trajectory-ledger');
  let synced = 0;
  for (const event of events) {
    const source = event.source === 'otel' ? 'otel' : 'harvest';
    const sourceEventId = stableTrajectoryKey({
      sessionKey: event.sessionKey,
      agentTool: event.agentTool,
      eventName: event.eventName,
      sequence: event.sequence,
      timestamp: event.timestamp.toISOString(),
    });
    const facts = [
      ...(event.promptText ? [{ kind: 'prompt', content: event.promptText }] : []),
      ...(event.responseText ? [{ kind: 'response', content: event.responseText }] : []),
      ...(!event.promptText && !event.responseText
        ? [{ kind: 'event', content: event.rawTruncated ?? null }]
        : []),
    ];
    for (const fact of facts) {
      const bounded = boundTrajectoryPayload({
        attributes: event.attributes ?? {},
        promptText: event.promptText ?? null,
        responseText: event.responseText ?? null,
        raw: event.rawTruncated ?? null,
        body: fact.content,
      }, event.rawTruncated ? 'truncated' : 'full');
      await appendTrajectoryRecord(
        repositoryId,
        AgentTrajectoryRecordSchema.parse({
          version: 1,
          source,
          sourceEventId,
          contentKey: stableTrajectoryKey({
            kind: fact.kind,
            content: fact.kind === 'event' ? event.rawTruncated ?? event.eventName : fact.content,
          }),
          sessionKey: event.sessionKey,
          agentId: event.agentId,
          agentTool: event.agentTool,
          eventType: event.eventName,
          sequence: event.sequence,
          timestamp: event.timestamp.toISOString(),
          payload: bounded.payload,
          contentKind: fact.kind,
          contentDisclosure: bounded.contentDisclosure,
          workUnitId: event.workUnitId,
          attemptId: event.attemptId,
        }),
      );
    }
    synced += 1;
  }
  return { synced };
}
