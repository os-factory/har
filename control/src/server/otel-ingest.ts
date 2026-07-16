import { createRequire } from 'node:module';
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
