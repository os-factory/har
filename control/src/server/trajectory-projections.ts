import { Prisma, type AgentTrajectoryRecord } from '@prisma/client';
import type { AgentSessionUsage } from '@har/schemas';
import { prisma } from '@/lib/db';
import { shouldPersistOtelUsage } from '@/server/otel-workspace';
import { upsertSessionEvent } from '@/server/session-events';
import { upsertSessionUsage } from '@/server/usage';
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

function numberField(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function usageFromTrajectoryRecord(
  record: AgentTrajectoryRecord,
): AgentSessionUsage | null {
  const payload = asObject(record.payload);
  const attributes = asObject(payload?.attributes) ?? {};
  const session = asObject(payload?.session);
  const input = numberField(
    attributes['gen_ai.usage.input_tokens'] ?? attributes['gen_ai.usage.prompt_tokens'],
  );
  const output = numberField(
    attributes['gen_ai.usage.output_tokens'] ?? attributes['gen_ai.usage.completion_tokens'],
  );
  const cacheRead = numberField(attributes['gen_ai.usage.cache_read.input_tokens']);
  const cacheCreate = numberField(attributes['gen_ai.usage.cache_creation.input_tokens']);
  const model = String(
    attributes['gen_ai.request.model'] ?? attributes['gen_ai.response.model'] ?? '',
  ).trim();
  const usage: AgentSessionUsage = {
    sessionKey: record.sessionKey,
    agentId: record.agentId,
    agentTool: record.agentTool as AgentSessionUsage['agentTool'],
    workDir: stringField(session?.workDir),
    branch: stringField(session?.branch),
    suffix: stringField(session?.suffix),
    workUnitId: record.workUnitId ?? undefined,
    attemptId: record.attemptId ?? undefined,
    tokensInput: input,
    tokensOutput: output,
    tokensCacheRead: cacheRead,
    tokensCacheCreation: cacheCreate,
    tokensTotal: input + output + cacheRead + cacheCreate,
    costUsd: null,
    sources: [record.source === 'harvest' ? 'harvest' : 'otel'],
    firstSeenAt: record.eventTimestamp.toISOString(),
    lastSeenAt: record.eventTimestamp.toISOString(),
    modelBreakdown: model
      ? {
          [model]: {
            tokensInput: input,
            tokensOutput: output,
            tokensCacheRead: cacheRead,
            tokensCacheCreation: cacheCreate,
            tokensTotal: input + output + cacheRead + cacheCreate,
          },
        }
      : undefined,
  };
  return shouldPersistOtelUsage(usage) ? usage : null;
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

  const usage = usageFromTrajectoryRecord(record);
  if (usage) await upsertSessionUsage(record.repositoryId, usage);
}
