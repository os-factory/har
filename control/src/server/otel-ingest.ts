import { createRequire } from 'node:module';
import type { Prisma } from '@prisma/client';
import type { AgentSessionUsage, AgentTool } from '@har/schemas';
import { prisma } from '@/lib/db';
import { upsertSessionUsage } from '@/server/usage';

const nodeRequire = createRequire(__filename);

interface AttrMap {
  [key: string]: string | number | boolean;
}

interface ParsedMetricPoint {
  name: string;
  attributes: AttrMap;
  value: number;
}

function attrsFromOtel(list: unknown): AttrMap {
  const out: AttrMap = {};
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const key = String((item as { key?: string }).key ?? '');
    if (!key) continue;
    const value = (item as { value?: Record<string, unknown> }).value ?? {};
    if (typeof value.stringValue === 'string') out[key] = value.stringValue;
    else if (typeof value.intValue === 'number' || typeof value.intValue === 'string') {
      out[key] = Number(value.intValue);
    } else if (typeof value.doubleValue === 'number') out[key] = value.doubleValue;
    else if (typeof value.boolValue === 'boolean') out[key] = value.boolValue;
  }
  return out;
}

function numberFromDataPoint(point: Record<string, unknown>): number {
  if (typeof point.asDouble === 'number') return point.asDouble;
  if (typeof point.asInt === 'number') return point.asInt;
  if (typeof point.asInt === 'string') return Number(point.asInt);
  if (point.sum && typeof point.sum === 'object') {
    const sum = point.sum as Record<string, unknown>;
    if (typeof sum.asDouble === 'number') return sum.asDouble;
    if (typeof sum.asInt === 'number') return sum.asInt;
  }
  return 0;
}

function extractPointsFromResourceMetrics(payload: unknown): Array<{
  resource: AttrMap;
  points: ParsedMetricPoint[];
}> {
  const results: Array<{ resource: AttrMap; points: ParsedMetricPoint[] }> = [];
  if (!payload || typeof payload !== 'object') return results;

  const root = payload as {
    resourceMetrics?: unknown[];
    resource_metrics?: unknown[];
  };
  const resourceMetrics = root.resourceMetrics ?? root.resource_metrics ?? [];
  if (!Array.isArray(resourceMetrics)) return results;

  for (const rm of resourceMetrics) {
    if (!rm || typeof rm !== 'object') continue;
    const resourceObj = (rm as { resource?: { attributes?: unknown } }).resource;
    const resource = attrsFromOtel(resourceObj?.attributes);
    const scopeMetrics =
      (rm as { scopeMetrics?: unknown[]; scope_metrics?: unknown[] }).scopeMetrics ??
      (rm as { scope_metrics?: unknown[] }).scope_metrics ??
      [];
    const points: ParsedMetricPoint[] = [];

    for (const sm of scopeMetrics) {
      if (!sm || typeof sm !== 'object') continue;
      const metrics = (sm as { metrics?: unknown[] }).metrics ?? [];
      for (const metric of metrics) {
        if (!metric || typeof metric !== 'object') continue;
        const name = String((metric as { name?: string }).name ?? '');
        const data =
          (metric as { sum?: { dataPoints?: unknown[] }; gauge?: { dataPoints?: unknown[] } })
            .sum ??
          (metric as { gauge?: { dataPoints?: unknown[] } }).gauge ??
          (metric as { histogram?: { dataPoints?: unknown[] } }).histogram;
        const dataPoints = data?.dataPoints ?? (data as { data_points?: unknown[] })?.data_points ?? [];
        if (!Array.isArray(dataPoints)) continue;
        for (const dp of dataPoints) {
          if (!dp || typeof dp !== 'object') continue;
          const record = dp as Record<string, unknown>;
          points.push({
            name,
            attributes: attrsFromOtel(record.attributes),
            value: numberFromDataPoint(record),
          });
        }
      }
    }

    results.push({ resource, points });
  }

  return results;
}

function detectAgentTool(resource: AttrMap, serviceName?: string): AgentTool | null {
  const explicit = String(resource['har.agent_tool'] ?? '').toLowerCase();
  if (explicit === 'claude_code' || explicit === 'claude-code') return 'claude_code';
  if (explicit === 'codex') return 'codex';
  const svc = (serviceName ?? String(resource['service.name'] ?? '')).toLowerCase();
  if (svc.includes('claude')) return 'claude_code';
  if (svc.includes('codex')) return 'codex';
  return null;
}

function emptyUsage(
  base: Pick<AgentSessionUsage, 'sessionKey' | 'agentId' | 'agentTool' | 'workDir' | 'branch' | 'suffix'>,
): AgentSessionUsage {
  const now = new Date().toISOString();
  return {
    ...base,
    tokensInput: 0,
    tokensOutput: 0,
    tokensCacheRead: 0,
    tokensCacheCreation: 0,
    tokensTotal: 0,
    costUsd: null,
    sources: ['otel'],
    firstSeenAt: now,
    lastSeenAt: now,
  };
}

function applyClaudePoint(usage: AgentSessionUsage, point: ParsedMetricPoint): void {
  const name = point.name;
  const type = String(point.attributes.type ?? point.attributes.token_type ?? '').toLowerCase();
  if (name === 'claude_code.token.usage' || name.endsWith('token.usage')) {
    if (type === 'input') usage.tokensInput += point.value;
    else if (type === 'output') usage.tokensOutput += point.value;
    else if (type === 'cacheread' || type === 'cache_read' || type === 'cacheRead') {
      usage.tokensCacheRead += point.value;
    } else if (
      type === 'cachecreation' ||
      type === 'cache_creation' ||
      type === 'cacheCreation' ||
      type === 'cache_create'
    ) {
      usage.tokensCacheCreation += point.value;
    } else {
      usage.tokensTotal += point.value;
    }
  }
  if (name === 'claude_code.cost.usage' || name.endsWith('cost.usage')) {
    usage.costUsd = (usage.costUsd ?? 0) + point.value;
  }
}

function applyCodexPoint(usage: AgentSessionUsage, point: ParsedMetricPoint): void {
  const name = point.name;
  const type = String(
    point.attributes.token_type ?? point.attributes.type ?? point.attributes.tokenType ?? '',
  ).toLowerCase();
  if (
    name.includes('token_usage') ||
    name.includes('token.usage') ||
    name.includes('tokens') ||
    name === 'codex.turn.token_usage'
  ) {
    if (type === 'input' || type === 'input_token' || type === 'input_tokens') {
      usage.tokensInput += point.value;
    } else if (type === 'output' || type === 'output_token' || type === 'output_tokens') {
      usage.tokensOutput += point.value;
    } else if (type === 'cached' || type === 'cache' || type === 'cached_input') {
      usage.tokensCacheRead += point.value;
    } else if (type === 'reasoning') {
      usage.tokensOutput += point.value;
    } else if (type === 'total' || type === '') {
      usage.tokensTotal += point.value;
    } else {
      usage.tokensTotal += point.value;
    }
  }
}

async function resolveRepositoryId(repoPath: string | undefined): Promise<string | null> {
  if (!repoPath) return null;
  const exact = await prisma.repository.findUnique({ where: { path: repoPath } });
  if (exact) return exact.id;
  // Soft match: path prefix / trailing slash differences
  const repos = await prisma.repository.findMany({ select: { id: true, path: true } });
  const normalized = repoPath.replace(/\/$/, '');
  const match = repos.find(
    (r) => r.path.replace(/\/$/, '') === normalized || normalized.startsWith(r.path.replace(/\/$/, '')),
  );
  return match?.id ?? null;
}

export interface OtelIngestResult {
  accepted: number;
  dropped: number;
  reasons: string[];
}

export async function ingestOtelMetricsJson(payload: unknown): Promise<OtelIngestResult> {
  const groups = extractPointsFromResourceMetrics(payload);
  let accepted = 0;
  let dropped = 0;
  const reasons: string[] = [];

  for (const group of groups) {
    const sessionKey = String(group.resource['har.session_key'] ?? '');
    const repoPath = String(group.resource['har.repo_path'] ?? '');
    const agentId = Number(group.resource['har.agent_id'] ?? 0);
    const tool = detectAgentTool(group.resource);

    if (!sessionKey) {
      dropped += 1;
      reasons.push('missing har.session_key');
      continue;
    }
    if (!tool) {
      dropped += 1;
      reasons.push(`unknown agent tool for session ${sessionKey}`);
      continue;
    }

    const repositoryId = await resolveRepositoryId(repoPath || undefined);
    if (!repositoryId) {
      dropped += 1;
      reasons.push(`unknown repository for ${repoPath || '(empty har.repo_path)'}`);
      continue;
    }

    const usage = emptyUsage({
      sessionKey,
      agentId: Number.isFinite(agentId) && agentId > 0 ? agentId : 1,
      agentTool: tool,
      workDir: group.resource['har.work_dir']
        ? String(group.resource['har.work_dir'])
        : undefined,
      branch: group.resource['har.branch'] ? String(group.resource['har.branch']) : undefined,
      suffix: group.resource['har.suffix'] ? String(group.resource['har.suffix']) : undefined,
    });

    for (const point of group.points) {
      if (tool === 'claude_code') applyClaudePoint(usage, point);
      else applyCodexPoint(usage, point);
    }

    usage.tokensTotal =
      usage.tokensTotal ||
      usage.tokensInput + usage.tokensOutput + usage.tokensCacheRead + usage.tokensCacheCreation;

    if (
      usage.tokensTotal === 0 &&
      usage.tokensInput === 0 &&
      usage.tokensOutput === 0 &&
      (usage.costUsd == null || usage.costUsd === 0)
    ) {
      dropped += 1;
      reasons.push(`no token/cost points for ${sessionKey}`);
      continue;
    }

    await upsertSessionUsage(repositoryId, usage);
    accepted += 1;
  }

  return { accepted, dropped, reasons };
}

/** Best-effort: protobuf bodies are ignored if we cannot decode; agents must not fail. */
export async function ingestOtelMetricsBody(
  body: Buffer,
  contentType: string | null,
): Promise<OtelIngestResult> {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('json') || body[0] === 0x7b /* { */) {
    try {
      const json = JSON.parse(body.toString('utf8'));
      return ingestOtelMetricsJson(json);
    } catch (err) {
      return {
        accepted: 0,
        dropped: 1,
        reasons: [`json parse failed: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
  }

  // Protobuf: try optional transformer; otherwise acknowledge without failing the exporter.
  try {
    const { ProtobufMetricsSerializer } = nodeRequire('@opentelemetry/otlp-transformer') as {
      ProtobufMetricsSerializer?: {
        deserializeRequest: (data: Uint8Array) => unknown;
      };
    };
    if (ProtobufMetricsSerializer?.deserializeRequest) {
      const decoded = ProtobufMetricsSerializer.deserializeRequest(body);
      return ingestOtelMetricsJson(decoded);
    }
  } catch {
    // optional dependency
  }

  return {
    accepted: 0,
    dropped: 1,
    reasons: ['protobuf body received but no decoder available; prefer OTEL_EXPORTER_OTLP_PROTOCOL=http/json'],
  };
}

function otelTimeToDate(value: unknown): Date {
  if (typeof value === 'string' || typeof value === 'number') {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) {
      // OTLP uses nanoseconds; JS Date wants ms.
      if (n > 1e15) return new Date(Math.floor(n / 1e6));
      if (n > 1e12) return new Date(Math.floor(n / 1e3));
      return new Date(n);
    }
  }
  return new Date();
}

function bodyToText(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  if (typeof record.stringValue === 'string') return record.stringValue;
  if (typeof record.string_value === 'string') return record.string_value;
  return null;
}

interface ParsedLogRecord {
  resource: AttrMap;
  eventName: string;
  attributes: AttrMap;
  timestamp: Date;
  bodyText: string | null;
  sequence: number;
}

function extractLogRecords(payload: unknown): ParsedLogRecord[] {
  const out: ParsedLogRecord[] = [];
  if (!payload || typeof payload !== 'object') return out;

  const root = payload as {
    resourceLogs?: unknown[];
    resource_logs?: unknown[];
  };
  const resourceLogs = root.resourceLogs ?? root.resource_logs ?? [];
  if (!Array.isArray(resourceLogs)) return out;

  let seq = 0;
  for (const rl of resourceLogs) {
    if (!rl || typeof rl !== 'object') continue;
    const resource = attrsFromOtel((rl as { resource?: { attributes?: unknown } }).resource?.attributes);
    const scopeLogs =
      (rl as { scopeLogs?: unknown[]; scope_logs?: unknown[] }).scopeLogs ??
      (rl as { scope_logs?: unknown[] }).scope_logs ??
      [];
    for (const sl of scopeLogs) {
      if (!sl || typeof sl !== 'object') continue;
      const records =
        (sl as { logRecords?: unknown[]; log_records?: unknown[] }).logRecords ??
        (sl as { log_records?: unknown[] }).log_records ??
        [];
      if (!Array.isArray(records)) continue;
      for (const lr of records) {
        if (!lr || typeof lr !== 'object') continue;
        const record = lr as Record<string, unknown>;
        const attributes = attrsFromOtel(record.attributes);
        const eventName = String(
          attributes['event.name'] ??
            attributes.event_name ??
            attributes['log.event'] ??
            record.name ??
            'log',
        );
        const ts =
          record.timeUnixNano ??
          record.time_unix_nano ??
          record.observedTimeUnixNano ??
          record.observed_time_unix_nano;
        seq += 1;
        out.push({
          resource,
          eventName,
          attributes,
          timestamp: otelTimeToDate(ts),
          bodyText: bodyToText(record.body),
          sequence: Number(attributes['har.sequence'] ?? attributes.sequence ?? seq),
        });
      }
    }
  }
  return out;
}

export async function ingestOtelLogsJson(payload: unknown): Promise<OtelIngestResult> {
  const { upsertSessionEvent } = await import('@/server/session-events');
  const records = extractLogRecords(payload);
  let accepted = 0;
  let dropped = 0;
  const reasons: string[] = [];

  for (const record of records) {
    const sessionKey = String(
      record.resource['har.session_key'] ?? record.attributes['har.session_key'] ?? '',
    );
    const repoPath = String(
      record.resource['har.repo_path'] ?? record.attributes['har.repo_path'] ?? '',
    );
    const agentId = Number(
      record.resource['har.agent_id'] ?? record.attributes['har.agent_id'] ?? 0,
    );
    const tool =
      detectAgentTool(record.resource) ??
      detectAgentTool(record.attributes) ??
      'claude_code';

    if (!sessionKey) {
      dropped += 1;
      reasons.push('missing har.session_key on log');
      continue;
    }

    const repositoryId = await resolveRepositoryId(repoPath || undefined);
    if (!repositoryId) {
      dropped += 1;
      reasons.push(`unknown repository for log ${repoPath || '(empty)'}`);
      continue;
    }

    const promptText =
      typeof record.attributes.prompt === 'string'
        ? record.attributes.prompt
        : typeof record.attributes['user.prompt'] === 'string'
          ? String(record.attributes['user.prompt'])
          : typeof record.attributes['gen_ai.prompt'] === 'string'
            ? String(record.attributes['gen_ai.prompt'])
            : record.eventName.includes('user_prompt')
              ? record.bodyText
              : null;
    const responseText =
      typeof record.attributes.response === 'string'
        ? record.attributes.response
        : typeof record.attributes['assistant.response'] === 'string'
          ? String(record.attributes['assistant.response'])
          : typeof record.attributes['gen_ai.completion'] === 'string'
            ? String(record.attributes['gen_ai.completion'])
            : record.eventName.includes('assistant')
              ? record.bodyText
              : null;

    await upsertSessionEvent(repositoryId, {
      sessionKey,
      agentId: Number.isFinite(agentId) && agentId > 0 ? agentId : 1,
      agentTool: tool,
      eventName: record.eventName,
      sequence: Number.isFinite(record.sequence) ? Math.floor(record.sequence) : accepted + 1,
      timestamp: record.timestamp,
      attributes: record.attributes as Prisma.InputJsonValue,
      promptText,
      responseText,
      rawTruncated: record.bodyText,
      source: 'otel',
    });
    accepted += 1;
  }

  return { accepted, dropped, reasons };
}

export async function ingestOtelLogsBody(
  body: Buffer,
  contentType: string | null,
): Promise<OtelIngestResult> {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('json') || body[0] === 0x7b) {
    try {
      return ingestOtelLogsJson(JSON.parse(body.toString('utf8')));
    } catch (err) {
      return {
        accepted: 0,
        dropped: 1,
        reasons: [`json parse failed: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
  }
  return {
    accepted: 0,
    dropped: 1,
    reasons: ['protobuf logs body not decoded; prefer http/json'],
  };
}

interface ParsedSpan {
  resource: AttrMap;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTime: Date;
  endTime: Date | null;
  attributes: AttrMap;
}

function extractSpans(payload: unknown): ParsedSpan[] {
  const out: ParsedSpan[] = [];
  if (!payload || typeof payload !== 'object') return out;
  const root = payload as {
    resourceSpans?: unknown[];
    resource_spans?: unknown[];
  };
  const resourceSpans = root.resourceSpans ?? root.resource_spans ?? [];
  if (!Array.isArray(resourceSpans)) return out;

  for (const rs of resourceSpans) {
    if (!rs || typeof rs !== 'object') continue;
    const resource = attrsFromOtel((rs as { resource?: { attributes?: unknown } }).resource?.attributes);
    const scopeSpans =
      (rs as { scopeSpans?: unknown[]; scope_spans?: unknown[] }).scopeSpans ??
      (rs as { scope_spans?: unknown[] }).scope_spans ??
      [];
    for (const ss of scopeSpans) {
      if (!ss || typeof ss !== 'object') continue;
      const spans = (ss as { spans?: unknown[] }).spans ?? [];
      if (!Array.isArray(spans)) continue;
      for (const span of spans) {
        if (!span || typeof span !== 'object') continue;
        const record = span as Record<string, unknown>;
        out.push({
          resource,
          traceId: String(record.traceId ?? record.trace_id ?? ''),
          spanId: String(record.spanId ?? record.span_id ?? ''),
          parentSpanId: record.parentSpanId || record.parent_span_id
            ? String(record.parentSpanId ?? record.parent_span_id)
            : null,
          name: String(record.name ?? 'span'),
          startTime: otelTimeToDate(record.startTimeUnixNano ?? record.start_time_unix_nano),
          endTime: record.endTimeUnixNano || record.end_time_unix_nano
            ? otelTimeToDate(record.endTimeUnixNano ?? record.end_time_unix_nano)
            : null,
          attributes: attrsFromOtel(record.attributes),
        });
      }
    }
  }
  return out;
}

export async function ingestOtelTracesJson(payload: unknown): Promise<OtelIngestResult> {
  const spans = extractSpans(payload);
  let accepted = 0;
  let dropped = 0;
  const reasons: string[] = [];

  for (const span of spans) {
    const sessionKey = String(
      span.resource['har.session_key'] ?? span.attributes['har.session_key'] ?? '',
    );
    const repoPath = String(
      span.resource['har.repo_path'] ?? span.attributes['har.repo_path'] ?? '',
    );
    const agentId = Number(span.resource['har.agent_id'] ?? span.attributes['har.agent_id'] ?? 0);
    const tool =
      detectAgentTool(span.resource) ?? detectAgentTool(span.attributes) ?? 'claude_code';

    if (!sessionKey || !span.traceId || !span.spanId) {
      dropped += 1;
      reasons.push('missing session/trace/span id');
      continue;
    }

    const repositoryId = await resolveRepositoryId(repoPath || undefined);
    if (!repositoryId) {
      dropped += 1;
      reasons.push(`unknown repository for span ${repoPath || '(empty)'}`);
      continue;
    }

    await prisma.agentSessionSpan.upsert({
      where: {
        repositoryId_traceId_spanId: {
          repositoryId,
          traceId: span.traceId,
          spanId: span.spanId,
        },
      },
      create: {
        repositoryId,
        sessionKey,
        agentId: Number.isFinite(agentId) && agentId > 0 ? agentId : 1,
        agentTool: tool,
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        name: span.name,
        startTime: span.startTime,
        endTime: span.endTime,
        attributes: span.attributes as Prisma.InputJsonValue,
      },
      update: {
        name: span.name,
        endTime: span.endTime,
        attributes: span.attributes as Prisma.InputJsonValue,
      },
    });

    // Also fold key spans into the event timeline for UI without a separate spans section.
    const { upsertSessionEvent } = await import('@/server/session-events');
    await upsertSessionEvent(repositoryId, {
      sessionKey,
      agentId: Number.isFinite(agentId) && agentId > 0 ? agentId : 1,
      agentTool: tool,
      eventName: `span.${span.name}`,
      sequence: Math.abs(
        Number.parseInt(span.spanId.replace(/\D/g, '').slice(-8) || '0', 16) || accepted + 1,
      ),
      timestamp: span.startTime,
      attributes: {
        ...span.attributes,
        traceId: span.traceId,
        spanId: span.spanId,
      } as Prisma.InputJsonValue,
      source: 'otel',
    });
    accepted += 1;
  }

  return { accepted, dropped, reasons };
}

export async function ingestOtelTracesBody(
  body: Buffer,
  contentType: string | null,
): Promise<OtelIngestResult> {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('json') || body[0] === 0x7b) {
    try {
      return ingestOtelTracesJson(JSON.parse(body.toString('utf8')));
    } catch (err) {
      return {
        accepted: 0,
        dropped: 1,
        reasons: [`json parse failed: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
  }
  return {
    accepted: 0,
    dropped: 1,
    reasons: ['protobuf traces body not decoded; prefer http/json'],
  };
}
