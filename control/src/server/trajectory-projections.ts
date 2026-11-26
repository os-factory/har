import { Prisma, type AgentTrajectoryRecord } from '@prisma/client';
import { prisma } from '@/lib/db';
import { upsertSessionEvent } from '@/server/session-events';
import type { AttrMap } from '@/server/otel-ingest';
import { stampedIds } from '@/server/stamped-ids';
import {
  redactSecretAttributes,
  visibleContentFromPayload,
} from '@/lib/trajectory-privacy';

function asObject(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function eventInputFromTrajectoryRecord(record: AgentTrajectoryRecord) {
  const payload = asObject(record.payload) ?? {};
  const attributes = asObject(payload.attributes) ?? {};
  const visible = visibleContentFromPayload(
    payload,
    record.contentKind,
    record.contentDisclosure,
  );
  return {
    sessionKey: record.sessionKey,
    agentId: record.agentId,
    agentTool: record.agentTool,
    eventName: record.eventType,
    sequence: record.sequence,
    timestamp: record.eventTimestamp,
    attributes: redactSecretAttributes(attributes) as Prisma.InputJsonValue,
    promptText: visible.promptText,
    responseText: visible.responseText,
    rawTruncated: visible.raw,
    source: record.source === 'harvest' ? 'harvest' : 'otel',
    workUnitId: record.workUnitId ?? undefined,
    attemptId: record.attemptId ?? undefined,
    factoryRunId: stampedIds(attributes as AttrMap).factoryRunId ?? undefined,
    sessionId: stampedIds(attributes as AttrMap).sessionId ?? undefined,
  };
}

export async function projectTrajectoryRecord(record: AgentTrajectoryRecord): Promise<void> {
  await upsertSessionEvent(record.repositoryId, eventInputFromTrajectoryRecord(record));

  if (record.traceId && record.spanId) {
    const payload = asObject(record.payload);
    const span = asObject(payload?.span);
    const attributes = asObject(payload?.attributes) ?? {};
    const startTime = span?.startTime ? new Date(String(span.startTime)) : record.eventTimestamp;
    const endTime = span?.endTime ? new Date(String(span.endTime)) : null;
    await prisma.agentSessionSpan.upsert({
      where: {
        repositoryId_traceId_spanId: {
          repositoryId: record.repositoryId,
          traceId: record.traceId,
          spanId: record.spanId,
        },
      },
      create: {
        repositoryId: record.repositoryId,
        sessionKey: record.sessionKey,
        agentId: record.agentId,
        agentTool: record.agentTool,
        workUnitId: record.workUnitId,
        attemptId: record.attemptId,
        factoryRunId: stampedIds(attributes as AttrMap).factoryRunId,
        sessionId: stampedIds(attributes as AttrMap).sessionId,
        traceId: record.traceId,
        spanId: record.spanId,
        parentSpanId: record.parentSpanId,
        name: stringField(span?.name) ?? record.eventType.replace(/^span\./, ''),
        startTime: Number.isFinite(startTime.getTime()) ? startTime : record.eventTimestamp,
        endTime: endTime && Number.isFinite(endTime.getTime()) ? endTime : null,
        attributes: redactSecretAttributes(attributes) as Prisma.InputJsonValue,
      },
      update: {
        parentSpanId: record.parentSpanId,
        endTime: endTime && Number.isFinite(endTime.getTime()) ? endTime : undefined,
        attributes: redactSecretAttributes(attributes) as Prisma.InputJsonValue,
      },
    });
  }
}
