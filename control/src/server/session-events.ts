import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

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
    take: 100,
  });
}

export async function listSessionEventsForRepo(repositoryId: string) {
  return prisma.agentSessionEvent.findMany({
    where: { repositoryId },
    orderBy: { timestamp: 'desc' },
    take: 200,
  });
}

export async function syncSessionEvents(repositoryId: string, events: SessionEventInput[]) {
  let synced = 0;
  for (const event of events) {
    await upsertSessionEvent(repositoryId, event);
    synced += 1;
  }
  return { synced };
}
