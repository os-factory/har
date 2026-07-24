import { createRequire } from 'node:module';
import type { Prisma } from '@prisma/client';
import type { AgentSessionUsage, AgentTool } from '@har/schemas';
import { prisma } from '@/lib/db';
import { upsertSessionUsage } from '@/server/usage';

const nodeRequire = createRequire(__filename);

type ProtobufDecoder = {
  decode: (data: Uint8Array) => unknown;
  toObject: (
    message: unknown,
    options?: Record<string, unknown>,
  ) => Record<string, unknown>;
};

function loadOtlpProtobufDecoder(
  kind: 'trace' | 'logs' | 'metrics',
): ProtobufDecoder | null {
  try {
    // Generated protobuf root ships with @opentelemetry/otlp-transformer.
    // Newer package versions no longer expose deserializeRequest on serializers.
    const root = nodeRequire(
      '@opentelemetry/otlp-transformer/build/src/generated/root.js',
    ) as {
      opentelemetry?: {
        proto?: {
          collector?: {
            trace?: { v1?: { ExportTraceServiceRequest?: ProtobufDecoder } };
            logs?: { v1?: { ExportLogsServiceRequest?: ProtobufDecoder } };
            metrics?: { v1?: { ExportMetricsServiceRequest?: ProtobufDecoder } };
          };
        };
      };
    };
    const collector = root.opentelemetry?.proto?.collector;
    if (kind === 'trace') return collector?.trace?.v1?.ExportTraceServiceRequest ?? null;
    if (kind === 'logs') return collector?.logs?.v1?.ExportLogsServiceRequest ?? null;
    return collector?.metrics?.v1?.ExportMetricsServiceRequest ?? null;
  } catch {
    return null;
  }
}

function decodeOtlpProtobufJson(
  kind: 'trace' | 'logs' | 'metrics',
  body: Buffer,
): unknown | null {
  const decoder = loadOtlpProtobufDecoder(kind);
  if (!decoder?.decode || !decoder?.toObject) return null;
  try {
    const message = decoder.decode(body);
    return decoder.toObject(message, {
      longs: String,
      enums: String,
      bytes: (value: Uint8Array) => Buffer.from(value).toString('hex'),
      defaults: true,
      arrays: true,
      objects: true,
    });
  } catch {
    return null;
  }
}

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
  const candidates = [
    String(resource['har.agent_tool'] ?? ''),
    String(resource['gen_ai.client.name'] ?? ''),
    serviceName ?? String(resource['service.name'] ?? ''),
  ]
    .map((v) => v.toLowerCase().trim())
    .filter(Boolean);

  for (const value of candidates) {
    if (value === 'cursor' || value.includes('cursor')) return 'cursor';
    if (value === 'codex' || value.includes('codex')) return 'codex';
    if (
      value === 'claude' ||
      value === 'claude_code' ||
      value === 'claude-code' ||
      value.includes('claude')
    ) {
      return 'claude_code';
    }
  }
  return null;
}

function normalizePath(value: string): string {
  return value.replace(/\/$/, '');
}

function workspaceFromAttrs(...maps: AttrMap[]): string {
  for (const map of maps) {
    for (const key of [
      'gen_ai.client.workspace',
      'har.work_dir',
      'code.filepath',
      'cwd',
      'process.cwd',
    ]) {
      const raw = map[key];
      if (typeof raw === 'string' && raw.trim()) return raw.trim();
    }
  }
  return '';
}

async function resolveSlotByWorkspace(workspace: string): Promise<{
  repositoryId: string;
  sessionKey: string;
  agentId: number;
  workDir?: string;
  branch?: string;
  suffix?: string;
  workUnitId?: string;
  attemptId?: string;
} | null> {
  if (!workspace) return null;
  const normalized = normalizePath(workspace);
  const slots = await prisma.agentSlot.findMany({
    where: {
      OR: [
        { workDir: { not: null } },
        { worktreePath: { not: null } },
      ],
    },
    select: {
      repositoryId: true,
      slotId: true,
      workDir: true,
      worktreePath: true,
      branch: true,
      suffix: true,
      workUnitId: true,
      attemptId: true,
    },
  });

  const match = slots.find((slot) => {
    const candidates = [slot.workDir, slot.worktreePath]
      .filter((p): p is string => Boolean(p))
      .map(normalizePath);
    return candidates.some(
      (path) =>
        path === normalized ||
        normalized.startsWith(`${path}/`) ||
        path.startsWith(`${normalized}/`),
    );
  });
  if (!match) return null;

  return {
    repositoryId: match.repositoryId,
    sessionKey: match.branch || `agent-${match.slotId}`,
    agentId: match.slotId,
    workDir: match.workDir ?? undefined,
    branch: match.branch ?? undefined,
    suffix: match.suffix ?? undefined,
    workUnitId: match.workUnitId ?? undefined,
    attemptId: match.attemptId ?? undefined,
  };
}

interface ResolvedSessionContext {
  repositoryId: string;
  sessionKey: string;
  agentId: number;
  agentTool: AgentTool;
  workDir?: string;
  branch?: string;
  suffix?: string;
  workUnitId?: string;
  attemptId?: string;
}

async function resolveSessionContext(
  resource: AttrMap,
  attributes: AttrMap = {},
): Promise<{ context: ResolvedSessionContext | null; reason?: string }> {
  const tool =
    detectAgentTool(attributes) ?? detectAgentTool(resource) ?? null;
  const sessionKey = String(
    resource['har.session_key'] ?? attributes['har.session_key'] ?? '',
  );
  const repoPath = String(resource['har.repo_path'] ?? attributes['har.repo_path'] ?? '');
  const agentIdRaw = Number(resource['har.agent_id'] ?? attributes['har.agent_id'] ?? 0);
  const workspace = workspaceFromAttrs(attributes, resource);

  if (sessionKey) {
    let repositoryId = await resolveRepositoryId(repoPath || undefined);
    if (!repositoryId && workspace) {
      const byWs = await resolveSlotByWorkspace(workspace);
      repositoryId = byWs?.repositoryId ?? null;
    }
    if (!repositoryId) {
      return { context: null, reason: `unknown repository for ${repoPath || workspace || '(empty)'}` };
    }
    return {
      context: {
        repositoryId,
        sessionKey,
        agentId: Number.isFinite(agentIdRaw) && agentIdRaw > 0 ? agentIdRaw : 1,
        agentTool: tool ?? 'claude_code',
        workDir: resource['har.work_dir']
          ? String(resource['har.work_dir'])
          : workspace || undefined,
        branch: resource['har.branch'] ? String(resource['har.branch']) : undefined,
        suffix: resource['har.suffix'] ? String(resource['har.suffix']) : undefined,
        workUnitId: resource['har.work_unit_id']
          ? String(resource['har.work_unit_id'])
          : undefined,
        attemptId: resource['har.attempt_id']
          ? String(resource['har.attempt_id'])
          : undefined,
      },
    };
  }

  if (workspace) {
    const byWs = await resolveSlotByWorkspace(workspace);
    if (byWs) {
      return {
        context: {
          repositoryId: byWs.repositoryId,
          sessionKey: byWs.sessionKey,
          agentId: byWs.agentId,
          agentTool: tool ?? 'cursor',
          workDir: byWs.workDir ?? workspace,
          branch: byWs.branch,
          suffix: byWs.suffix,
          workUnitId: byWs.workUnitId,
          attemptId: byWs.attemptId,
        },
      };
    }
    return { context: null, reason: `no slot matched workspace ${workspace}` };
  }

  return { context: null, reason: 'missing har.session_key and workspace' };
}

const PURPOSE_MAX_CHARS = 160;

function extractPromptText(attributes: AttrMap, eventName?: string, bodyText?: string | null): string | null {
  const keys = [
    'gen_ai.prompt.0.content',
    'gen_ai.prompt',
    'user.prompt',
    'prompt',
    'gen_ai.input.messages',
  ];
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const hookEvent = String(attributes['gen_ai.client.hook.event'] ?? eventName ?? '').toLowerCase();
  if (
    (hookEvent.includes('userprompt') ||
      hookEvent.includes('beforesubmitprompt') ||
      hookEvent.includes('user_prompt')) &&
    bodyText?.trim()
  ) {
    return bodyText.trim();
  }
  return null;
}

async function maybeSetDerivedPurpose(
  repositoryId: string,
  agentId: number,
  promptText: string | null,
): Promise<void> {
  if (!promptText) return;
  const truncated =
    promptText.length > PURPOSE_MAX_CHARS
      ? `${promptText.slice(0, PURPOSE_MAX_CHARS - 1)}…`
      : promptText;
  const existing = await prisma.agentSlot.findUnique({
    where: { repositoryId_slotId: { repositoryId, slotId: agentId } },
    select: { purpose: true },
  });
  if (!existing || (existing.purpose && existing.purpose.trim())) return;
  await prisma.agentSlot.update({
    where: { repositoryId_slotId: { repositoryId, slotId: agentId } },
    data: { purpose: truncated },
  });
}

function applyHooksUsageFromAttrs(usage: AgentSessionUsage, attributes: AttrMap): void {
  const input = Number(
    attributes['gen_ai.usage.input_tokens'] ?? attributes['gen_ai.usage.prompt_tokens'] ?? 0,
  );
  const output = Number(
    attributes['gen_ai.usage.output_tokens'] ?? attributes['gen_ai.usage.completion_tokens'] ?? 0,
  );
  const cacheRead = Number(attributes['gen_ai.usage.cache_read.input_tokens'] ?? 0);
  const cacheCreate = Number(attributes['gen_ai.usage.cache_creation.input_tokens'] ?? 0);
  if (Number.isFinite(input) && input > 0) usage.tokensInput += input;
  if (Number.isFinite(output) && output > 0) usage.tokensOutput += output;
  if (Number.isFinite(cacheRead) && cacheRead > 0) usage.tokensCacheRead += cacheRead;
  if (Number.isFinite(cacheCreate) && cacheCreate > 0) usage.tokensCacheCreation += cacheCreate;
}

function emptyUsage(
  base: Pick<AgentSessionUsage, 'sessionKey' | 'agentId' | 'agentTool' | 'workDir' | 'branch' | 'suffix'> &
    Partial<Pick<AgentSessionUsage, 'workUnitId' | 'attemptId'>>,
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
    const resolved = await resolveSessionContext(group.resource);
    if (!resolved.context) {
      dropped += 1;
      reasons.push(resolved.reason ?? 'unresolved session for metrics');
      continue;
    }
    const { context } = resolved;
    const tool = context.agentTool;

    const usage = emptyUsage({
      sessionKey: context.sessionKey,
      agentId: context.agentId,
      agentTool: tool,
      workDir: context.workDir,
      branch: context.branch,
      suffix: context.suffix,
      workUnitId: context.workUnitId,
      attemptId: context.attemptId,
    });

    for (const point of group.points) {
      applyHooksUsageFromAttrs(usage, point.attributes);
      if (tool === 'claude_code') applyClaudePoint(usage, point);
      else if (tool === 'codex') applyCodexPoint(usage, point);
      else applyCodexPoint(usage, point); // cursor / generic metric names
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
      reasons.push(`no token/cost points for ${context.sessionKey}`);
      continue;
    }

    await upsertSessionUsage(context.repositoryId, usage);
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

  // Protobuf: decode via generated OTLP protos (hooks send proto.http by default).
  try {
    const { ProtobufMetricsSerializer } = nodeRequire('@opentelemetry/otlp-transformer') as {
      ProtobufMetricsSerializer?: {
        deserializeRequest?: (data: Uint8Array) => unknown;
      };
    };
    if (ProtobufMetricsSerializer?.deserializeRequest) {
      const decoded = ProtobufMetricsSerializer.deserializeRequest(body);
      return ingestOtelMetricsJson(decoded);
    }
  } catch {
    // fall through to generated root decoder
  }

  const decoded = decodeOtlpProtobufJson('metrics', body);
  if (decoded) return ingestOtelMetricsJson(decoded);

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
    const resolved = await resolveSessionContext(record.resource, record.attributes);
    if (!resolved.context) {
      dropped += 1;
      reasons.push(resolved.reason ?? 'unresolved session for log');
      continue;
    }
    const { context } = resolved;

    const promptText =
      extractPromptText(record.attributes, record.eventName, record.bodyText) ??
      (typeof record.attributes.prompt === 'string'
        ? record.attributes.prompt
        : typeof record.attributes['user.prompt'] === 'string'
          ? String(record.attributes['user.prompt'])
          : typeof record.attributes['gen_ai.prompt'] === 'string'
            ? String(record.attributes['gen_ai.prompt'])
            : record.eventName.includes('user_prompt')
              ? record.bodyText
              : null);
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

    await upsertSessionEvent(context.repositoryId, {
      sessionKey: context.sessionKey,
      agentId: context.agentId,
      agentTool: context.agentTool,
      eventName: record.eventName,
      sequence: Number.isFinite(record.sequence) ? Math.floor(record.sequence) : accepted + 1,
      timestamp: record.timestamp,
      attributes: record.attributes as Prisma.InputJsonValue,
      promptText,
      responseText,
      rawTruncated: record.bodyText,
      source: 'otel',
      workUnitId: context.workUnitId,
      attemptId: context.attemptId,
    });

    await maybeSetDerivedPurpose(context.repositoryId, context.agentId, promptText);

    const usage = emptyUsage({
      sessionKey: context.sessionKey,
      agentId: context.agentId,
      agentTool: context.agentTool,
      workDir: context.workDir,
      branch: context.branch,
      suffix: context.suffix,
      workUnitId: context.workUnitId,
      attemptId: context.attemptId,
    });
    applyHooksUsageFromAttrs(usage, record.attributes);
    usage.tokensTotal =
      usage.tokensInput + usage.tokensOutput + usage.tokensCacheRead + usage.tokensCacheCreation;
    if (usage.tokensTotal > 0) {
      await upsertSessionUsage(context.repositoryId, usage);
    }

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
  const decoded = decodeOtlpProtobufJson('logs', body);
  if (decoded) return ingestOtelLogsJson(decoded);
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
    if (!span.traceId || !span.spanId) {
      dropped += 1;
      reasons.push('missing trace/span id');
      continue;
    }

    const resolved = await resolveSessionContext(span.resource, span.attributes);
    if (!resolved.context) {
      dropped += 1;
      reasons.push(resolved.reason ?? 'unresolved session for span');
      continue;
    }
    const { context } = resolved;

    await prisma.agentSessionSpan.upsert({
      where: {
        repositoryId_traceId_spanId: {
          repositoryId: context.repositoryId,
          traceId: span.traceId,
          spanId: span.spanId,
        },
      },
      create: {
        repositoryId: context.repositoryId,
        sessionKey: context.sessionKey,
        agentId: context.agentId,
        agentTool: context.agentTool,
        workUnitId: context.workUnitId,
        attemptId: context.attemptId,
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
        workUnitId: context.workUnitId,
        attemptId: context.attemptId,
        attributes: span.attributes as Prisma.InputJsonValue,
      },
    });

    // Also fold key spans into the event timeline for UI without a separate spans section.
    const { upsertSessionEvent } = await import('@/server/session-events');
    const promptText = extractPromptText(span.attributes, span.name);
    await upsertSessionEvent(context.repositoryId, {
      sessionKey: context.sessionKey,
      agentId: context.agentId,
      agentTool: context.agentTool,
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
      promptText,
      source: 'otel',
      workUnitId: context.workUnitId,
      attemptId: context.attemptId,
    });

    await maybeSetDerivedPurpose(context.repositoryId, context.agentId, promptText);

    const usage = emptyUsage({
      sessionKey: context.sessionKey,
      agentId: context.agentId,
      agentTool: context.agentTool,
      workDir: context.workDir,
      branch: context.branch,
      suffix: context.suffix,
      workUnitId: context.workUnitId,
      attemptId: context.attemptId,
    });
    applyHooksUsageFromAttrs(usage, span.attributes);
    usage.tokensTotal =
      usage.tokensInput + usage.tokensOutput + usage.tokensCacheRead + usage.tokensCacheCreation;
    if (usage.tokensTotal > 0) {
      await upsertSessionUsage(context.repositoryId, usage);
    }

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
  const decoded = decodeOtlpProtobufJson('trace', body);
  if (decoded) return ingestOtelTracesJson(decoded);
  return {
    accepted: 0,
    dropped: 1,
    reasons: ['protobuf traces body not decoded; prefer http/json'],
  };
}
