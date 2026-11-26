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

/**
 * The span row a trajectory record projects to, or null when it names none.
 *
 * Only a span itself (its record carries `payload.span`) or a 1.x `span.*`
 * mirror log projects to a span row. otel-hook's lifecycle logs
 * (`tool.start`, `session.start`, ...) carry their span's ids too, but they
 * are events of that span, not the span: letting them write the row named it
 * `tool.start`, kept the start log's (unstamped) identity and attributes, and
 * left the span's own stamp unread.
 */
export function spanProjectionOf(record: AgentTrajectoryRecord) {
  if (!record.traceId || !record.spanId) return null;
  const payload = asObject(record.payload);
  const span = asObject(payload?.span);
  if (!span && !record.eventType.startsWith('span.')) return null;
  const attributes = asObject(payload?.attributes) ?? {};
  const stamps = stampedIds(attributes as AttrMap);
  const start = span?.startTime ? new Date(String(span.startTime)) : record.eventTimestamp;
  const end = span?.endTime ? new Date(String(span.endTime)) : null;
  return {
    sessionKey: record.sessionKey,
    agentId: record.agentId,
    agentTool: record.agentTool,
    // The record's identity is the span's stamp, else where Mission Control
    // placed it (ADR 0005 section 3); both are recomputed on every delivery.
    workUnitId: record.workUnitId ?? stamps.workUnitId,
    attemptId: record.attemptId ?? stamps.attemptId,
    factoryRunId: stamps.factoryRunId,
    sessionId: stamps.sessionId,
    parentSpanId: record.parentSpanId,
    name: stringField(span?.name) ?? record.eventType.replace(/^span\./, ''),
    startTime: Number.isFinite(start.getTime()) ? start : record.eventTimestamp,
    endTime: end && Number.isFinite(end.getTime()) ? end : null,
    attributes: redactSecretAttributes(attributes) as Prisma.InputJsonValue,
  };
}

export async function projectTrajectoryRecord(record: AgentTrajectoryRecord): Promise<void> {
  await upsertSessionEvent(record.repositoryId, eventInputFromTrajectoryRecord(record));

  const span = spanProjectionOf(record);
  if (!span || !record.traceId || !record.spanId) return;
  // A span is (trace, span, start): a resumed session that reuses a span id
  // for a new span is a second row, never an overwrite of the first.
  const { endTime, ...rest } = span;
  await prisma.agentSessionSpan.upsert({
    where: {
      repositoryId_traceId_spanId_startTime: {
        repositoryId: record.repositoryId,
        traceId: record.traceId,
        spanId: record.spanId,
        startTime: span.startTime,
      },
    },
    create: { repositoryId: record.repositoryId, traceId: record.traceId, spanId: record.spanId, ...span },
    // A later delivery of the same span refreshes everything it says,
    // identity columns included; an end time is never taken back.
    update: { ...rest, ...(endTime ? { endTime } : {}) },
  });
}
