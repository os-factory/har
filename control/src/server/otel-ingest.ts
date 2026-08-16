import { createRequire } from 'node:module';
import {
  AgentTrajectoryRecordSchema,
  type AgentSessionUsage,
  type AgentTool,
} from '@har/schemas';
import { prisma } from '@/lib/db';
import {
  appendTrajectoryRecord,
  stableTrajectoryKey,
} from '@/server/trajectory-ledger';
import { upsertSessionUsage } from '@/server/usage';
import {
  boundTrajectoryPayload,
  hidesTrajectoryContent,
  redactSecretAttributes,
} from '@/lib/trajectory-privacy';
import {
  isWorkspaceUnderPath,
  normalizeOtelPath,
  pickBestRepoPathMatch,
  pickPathForWorkspaceId,
} from '@/server/otel-workspace';

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

export interface AttrMap {
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

export function detectAgentTool(resource: AttrMap, serviceName?: string): AgentTool | null {
  const candidates = [
    String(resource['har.agent_tool'] ?? ''),
    String(resource['otelhook.provider.id'] ?? ''),
    String(resource['otelhook.agent.name'] ?? ''),
    String(resource['otelhook.provider'] ?? ''),
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
  return normalizeOtelPath(value);
}

function workspaceFromAttrs(...maps: AttrMap[]): string {
  for (const map of maps) {
    for (const key of [
      'gen_ai.client.workspace',
      'gen_ai.client.repository_root',
      'har.work_dir',
      'har.repo_path',
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

function workspaceIdFromAttrs(...maps: AttrMap[]): string {
  for (const map of maps) {
    const raw = map['otelhook.workspace.id'];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  }
  return '';
}

function sessionIdFromAttrs(...maps: AttrMap[]): string {
  for (const map of maps) {
    const raw = map['session.id'];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
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
    return candidates.some((slotPath) => isWorkspaceUnderPath(normalized, slotPath));
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

export interface ResolvedSessionContext {
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

async function resolveRepositoryByWorkspacePath(
  workspace: string,
): Promise<{ repositoryId: string; path: string } | null> {
  const repos = await prisma.repository.findMany({ select: { id: true, path: true } });
  const best = pickBestRepoPathMatch(
    workspace,
    repos.map((r) => r.path),
  );
  if (!best) return null;
  const match = repos.find((r) => normalizePath(r.path) === best);
  return match ? { repositoryId: match.id, path: match.path } : null;
}

async function resolveRepositoryByWorkspaceId(
  workspaceId: string,
): Promise<{ repositoryId: string; path: string; matchedPath: string } | null> {
  const [repos, slots] = await Promise.all([
    prisma.repository.findMany({ select: { id: true, path: true } }),
    prisma.agentSlot.findMany({
      where: {
        OR: [{ workDir: { not: null } }, { worktreePath: { not: null } }],
      },
      select: { repositoryId: true, workDir: true, worktreePath: true },
    }),
  ]);

  const candidates: Array<{ repositoryId: string; path: string; candidate: string }> = [];
  for (const repo of repos) {
    candidates.push({ repositoryId: repo.id, path: repo.path, candidate: repo.path });
  }
  for (const slot of slots) {
    const repo = repos.find((r) => r.id === slot.repositoryId);
    if (!repo) continue;
    for (const candidate of [slot.workDir, slot.worktreePath]) {
      if (candidate) {
        candidates.push({ repositoryId: repo.id, path: repo.path, candidate });
      }
    }
  }

  const matchedPath = pickPathForWorkspaceId(
    workspaceId,
    candidates.map((c) => c.candidate),
  );
  if (!matchedPath) return null;
  const hit = candidates.find((c) => normalizePath(c.candidate) === matchedPath);
  return hit
    ? { repositoryId: hit.repositoryId, path: hit.path, matchedPath }
    : null;
}

async function defaultAgentIdForRepo(repositoryId: string): Promise<number> {
  const active = await prisma.agentSlot.findFirst({
    where: { repositoryId, active: true },
    orderBy: { updatedAt: 'desc' },
    select: { slotId: true },
  });
  return active?.slotId ?? 1;
}

interface ActiveSlotAttribution {
  agentId: number;
  workDir?: string;
  branch?: string;
  suffix?: string;
  workUnitId?: string;
  attemptId?: string;
}

/**
 * The repo's one active slot, when there is exactly one.
 *
 * Cursor's OTEL workspace is the main checkout, not a HAR session worktree —
 * `resolveSlotByWorkspace` only matches a slot's own workDir/worktreePath, so
 * activity from Cursor running against the main checkout never correlates to
 * the worktree an agent is actually working in. When a repo has exactly one
 * active slot, that correlation is unambiguous; two or more active slots make
 * a guess as likely wrong as right, so this returns null and callers keep
 * attributing to the raw workspace path instead.
 */
async function resolveUnambiguousActiveSlot(
  repositoryId: string,
): Promise<ActiveSlotAttribution | null> {
  const active = await prisma.agentSlot.findMany({
    where: { repositoryId, active: true },
    select: {
      slotId: true,
      workDir: true,
      worktreePath: true,
      branch: true,
      suffix: true,
      workUnitId: true,
      attemptId: true,
    },
  });
  if (active.length !== 1) return null;
  const slot = active[0];
  return {
    agentId: slot.slotId,
    workDir: slot.workDir ?? slot.worktreePath ?? undefined,
    branch: slot.branch ?? undefined,
    suffix: slot.suffix ?? undefined,
    workUnitId: slot.workUnitId ?? undefined,
    attemptId: slot.attemptId ?? undefined,
  };
}

export async function resolveSessionContext(
  resource: AttrMap,
  attributes: AttrMap = {},
): Promise<{ context: ResolvedSessionContext | null; reason?: string }> {
  const tool =
    detectAgentTool(attributes) ?? detectAgentTool(resource) ?? null;
  const harSessionKey = String(
    resource['har.session_key'] ?? attributes['har.session_key'] ?? '',
  );
  const repoPath = String(resource['har.repo_path'] ?? attributes['har.repo_path'] ?? '');
  const agentIdRaw = Number(resource['har.agent_id'] ?? attributes['har.agent_id'] ?? 0);
  const workspace = workspaceFromAttrs(attributes, resource);
  const workspaceId = workspaceIdFromAttrs(attributes, resource);
  const providerSessionId = sessionIdFromAttrs(attributes, resource);
  const explicitAgentId =
    Number.isFinite(agentIdRaw) && agentIdRaw > 0 ? agentIdRaw : undefined;

  // Prefer live workspace/slot matching over stale global har.session_key
  // resource attributes left behind by the last `har env launch`.
  if (workspace) {
    const byWs = await resolveSlotByWorkspace(workspace);
    if (byWs) {
      return {
        context: {
          repositoryId: byWs.repositoryId,
          sessionKey: harSessionKey || byWs.sessionKey || providerSessionId,
          agentId: explicitAgentId ?? byWs.agentId,
          agentTool: tool ?? 'cursor',
          workDir: byWs.workDir ?? workspace,
          branch: byWs.branch,
          suffix: byWs.suffix,
          workUnitId: byWs.workUnitId,
          attemptId: byWs.attemptId,
        },
      };
    }

    const byRepo = await resolveRepositoryByWorkspacePath(workspace);
    if (byRepo) {
      const activeSlot = await resolveUnambiguousActiveSlot(byRepo.repositoryId);
      return {
        context: {
          repositoryId: byRepo.repositoryId,
          sessionKey:
            harSessionKey || providerSessionId || `ide:${normalizePath(byRepo.path)}`,
          agentId:
            explicitAgentId ??
            activeSlot?.agentId ??
            (await defaultAgentIdForRepo(byRepo.repositoryId)),
          agentTool: tool ?? 'cursor',
          workDir: activeSlot?.workDir ?? workspace,
          branch:
            activeSlot?.branch ??
            (resource['har.branch'] ? String(resource['har.branch']) : undefined),
          suffix:
            activeSlot?.suffix ??
            (resource['har.suffix'] ? String(resource['har.suffix']) : undefined),
          workUnitId:
            activeSlot?.workUnitId ??
            (resource['har.work_unit_id'] ? String(resource['har.work_unit_id']) : undefined),
          attemptId:
            activeSlot?.attemptId ??
            (resource['har.attempt_id'] ? String(resource['har.attempt_id']) : undefined),
        },
      };
    }
  }

  if (workspaceId) {
    const byId = await resolveRepositoryByWorkspaceId(workspaceId);
    if (byId) {
      const activeSlot = await resolveUnambiguousActiveSlot(byId.repositoryId);
      return {
        context: {
          repositoryId: byId.repositoryId,
          sessionKey:
            harSessionKey || providerSessionId || `ide:${normalizePath(byId.path)}`,
          agentId:
            explicitAgentId ??
            activeSlot?.agentId ??
            (await defaultAgentIdForRepo(byId.repositoryId)),
          agentTool: tool ?? 'cursor',
          workDir: activeSlot?.workDir ?? byId.matchedPath,
          branch:
            activeSlot?.branch ??
            (resource['har.branch'] ? String(resource['har.branch']) : undefined),
          suffix:
            activeSlot?.suffix ??
            (resource['har.suffix'] ? String(resource['har.suffix']) : undefined),
          workUnitId: activeSlot?.workUnitId,
          attemptId: activeSlot?.attemptId,
        },
      };
    }
  }

  if (harSessionKey) {
    let repositoryId = await resolveRepositoryId(repoPath || undefined);
    if (!repositoryId && workspace) {
      const byWs = await resolveSlotByWorkspace(workspace);
      repositoryId = byWs?.repositoryId ?? null;
    }
    if (!repositoryId) {
      return {
        context: null,
        reason: `unknown repository for ${repoPath || workspace || workspaceId || '(empty)'}`,
      };
    }
    if (!tool) {
      return {
        context: null,
        reason: `unknown agent tool for session key ${harSessionKey}`,
      };
    }
    return {
      context: {
        repositoryId,
        sessionKey: harSessionKey,
        agentId: explicitAgentId ?? 1,
        agentTool: tool,
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

  return {
    context: null,
    reason: `no repository matched workspace ${workspace || workspaceId || '(empty)'}`,
  };
}

const PURPOSE_MAX_CHARS = 160;

/** Unwrap GenAI messages JSON (`[{role, parts:[{content}]}]`) into plain text. */
function textFromGenAiMessages(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const parts: string[] = [];
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;
      const record = msg as { content?: unknown; parts?: unknown[]; text?: unknown };
      if (typeof record.content === 'string' && record.content.trim()) {
        parts.push(record.content.trim());
        continue;
      }
      if (typeof record.text === 'string' && record.text.trim()) {
        parts.push(record.text.trim());
        continue;
      }
      if (Array.isArray(record.parts)) {
        for (const part of record.parts) {
          if (!part || typeof part !== 'object') continue;
          const content =
            (part as { content?: unknown; text?: unknown }).content ??
            (part as { text?: unknown }).text;
          if (typeof content === 'string' && content.trim()) parts.push(content.trim());
        }
      }
    }
    return parts.length > 0 ? parts.join('\n') : null;
  } catch {
    return trimmed;
  }
}

export function extractPromptText(attributes: AttrMap, eventName?: string, bodyText?: string | null): string | null {
  const keys = [
    'gen_ai.client.prompt.text',
    'gen_ai.prompt.0.content',
    'gen_ai.prompt',
    'user.prompt',
    'prompt',
  ];
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const inputMessages = attributes['gen_ai.input.messages'];
  if (typeof inputMessages === 'string' && inputMessages.trim()) {
    const unwrapped = textFromGenAiMessages(inputMessages);
    if (unwrapped) return unwrapped;
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
  // @osfactory/otel-hook canonical log mapping: one record per content fact,
  // `otelhook.event.type` names the canonical event and `otelhook.content.kind`
  // names the fact. A withheld body (`otelhook.content.withheld` set) carries no
  // `body` — the record states *why* rather than leaving an ambiguous absence, so
  // it must not be read as an empty prompt.
  const otelHookEventType = String(attributes['otelhook.event.type'] ?? '').toLowerCase();
  const otelHookContentKind = String(attributes['otelhook.content.kind'] ?? '').toLowerCase();
  const otelHookWithheld = attributes['otelhook.content.withheld'];
  if (
    otelHookEventType === 'prompt.submitted' &&
    otelHookContentKind === 'prompt' &&
    !otelHookWithheld &&
    bodyText?.trim()
  ) {
    return bodyText.trim();
  }
  return null;
}

export function extractResponseText(
  attributes: AttrMap,
  eventName?: string,
  bodyText?: string | null,
): string | null {
  const keys = [
    'gen_ai.client.response.text',
    'assistant.response',
    'gen_ai.completion',
    'response',
  ];
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const outputMessages = attributes['gen_ai.output.messages'];
  if (typeof outputMessages === 'string' && outputMessages.trim()) {
    const unwrapped = textFromGenAiMessages(outputMessages);
    if (unwrapped) return unwrapped;
  }
  if (String(eventName ?? '').toLowerCase().includes('assistant') && bodyText?.trim()) {
    return bodyText.trim();
  }
  const otelHookEventType = String(attributes['otelhook.event.type'] ?? '').toLowerCase();
  const otelHookContentKind = String(attributes['otelhook.content.kind'] ?? '').toLowerCase();
  if (
    otelHookEventType === 'generation.end' &&
    (otelHookContentKind === 'response' || otelHookContentKind === 'output') &&
    !attributes['otelhook.content.withheld'] &&
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
  const safeInput = Number.isFinite(input) && input > 0 ? input : 0;
  const safeOutput = Number.isFinite(output) && output > 0 ? output : 0;
  const safeCacheRead = Number.isFinite(cacheRead) && cacheRead > 0 ? cacheRead : 0;
  const safeCacheCreate = Number.isFinite(cacheCreate) && cacheCreate > 0 ? cacheCreate : 0;
  if (safeInput > 0) usage.tokensInput += safeInput;
  if (safeOutput > 0) usage.tokensOutput += safeOutput;
  if (safeCacheRead > 0) usage.tokensCacheRead += safeCacheRead;
  if (safeCacheCreate > 0) usage.tokensCacheCreation += safeCacheCreate;

  // Associate usage with model id for later pricing (even when this span has no token attrs).
  const model = String(
    attributes['gen_ai.request.model'] ?? attributes['gen_ai.response.model'] ?? '',
  ).trim();
  if (!model) return;
  const breakdown = (usage.modelBreakdown ??= {}) as Record<
    string,
    {
      tokensInput: number;
      tokensOutput: number;
      tokensCacheRead: number;
      tokensCacheCreation: number;
      tokensTotal: number;
    }
  >;
  const totals = (breakdown[model] ??= {
    tokensInput: 0,
    tokensOutput: 0,
    tokensCacheRead: 0,
    tokensCacheCreation: 0,
    tokensTotal: 0,
  });
  totals.tokensInput += safeInput;
  totals.tokensOutput += safeOutput;
  totals.tokensCacheRead += safeCacheRead;
  totals.tokensCacheCreation += safeCacheCreate;
  totals.tokensTotal += safeInput + safeOutput + safeCacheRead + safeCacheCreate;
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

function otelTimeToDate(value: unknown, fallback = new Date()): Date {
  if (typeof value === 'string' || typeof value === 'number') {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) {
      // OTLP uses nanoseconds; JS Date wants ms.
      if (n > 1e15) return new Date(Math.floor(n / 1e6));
      if (n > 1e12) return new Date(Math.floor(n / 1e3));
      return new Date(n);
    }
  }
  return fallback;
}

function bodyToText(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  if (typeof record.stringValue === 'string') return record.stringValue;
  if (typeof record.string_value === 'string') return record.string_value;
  return null;
}

export interface ParsedLogRecord {
  resource: AttrMap;
  eventName: string;
  attributes: AttrMap;
  timestamp: Date;
  body: unknown;
  bodyText: string | null;
  sequence: number;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
}

export function extractLogRecords(payload: unknown): ParsedLogRecord[] {
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
          record.eventName ??
            record.event_name ??
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
          timestamp: otelTimeToDate(ts, new Date(0)),
          body: record.body ?? null,
          bodyText: bodyToText(record.body),
          sequence: Number(
            attributes['otelhook.event.sequence'] ??
              attributes['har.sequence'] ??
              attributes.sequence ??
              seq,
          ),
          traceId: record.traceId || record.trace_id
            ? String(record.traceId ?? record.trace_id)
            : undefined,
          spanId: record.spanId || record.span_id
            ? String(record.spanId ?? record.span_id)
            : undefined,
          parentSpanId: record.parentSpanId || record.parent_span_id
            ? String(record.parentSpanId ?? record.parent_span_id)
            : undefined,
        });
      }
    }
  }
  return out;
}

function canonicalContentDisclosure(attributes: AttrMap, bodyText: string | null) {
  const explicit = String(attributes['otelhook.content.disclosure'] ?? '').toLowerCase();
  if (attributes['otelhook.content.withheld']) return 'withheld' as const;
  if (
    attributes['otelhook.content.truncated'] ||
    attributes['otelhook.content.body_truncated']
  ) return 'truncated' as const;
  if (explicit === 'redact' || explicit === 'redacted') return 'redacted' as const;
  if (explicit === 'mask' || explicit === 'masked') return 'masked' as const;
  if (explicit === 'raw' || explicit === 'full') return 'full' as const;
  if (explicit === 'truncated' || explicit === 'withheld' || explicit === 'metadata_only') {
    return explicit;
  }
  return bodyText == null ? 'metadata_only' as const : 'full' as const;
}

function canonicalContentKind(attributes: AttrMap): string {
  return String(attributes['otelhook.content.kind'] ?? 'event').trim().toLowerCase() || 'event';
}

export function canonicalEventType(record: ParsedLogRecord): string {
  return String(record.attributes['otelhook.event.type'] ?? record.eventName).trim() || 'log';
}

export function canonicalSequence(record: ParsedLogRecord): number {
  return Number.isFinite(record.sequence) && record.sequence >= 0
    ? Math.floor(record.sequence)
    : 0;
}

function canonicalSourceEventId(record: ParsedLogRecord, eventType: string, sequence: number): string {
  const explicit = String(record.attributes['otelhook.event.id'] ?? '').trim();
  if (explicit) return explicit;
  return stableTrajectoryKey({
    eventType,
    sequence,
    timestamp: record.timestamp.toISOString(),
    traceId: record.traceId ?? null,
    spanId: record.spanId ?? null,
    resource: record.resource,
  });
}

function canonicalContentKey(record: ParsedLogRecord, contentKind: string): string {
  const explicitHash = String(record.attributes['otelhook.content.hash'] ?? '').trim();
  const ordinal = record.attributes['otelhook.content.ordinal'];
  return stableTrajectoryKey({
    contentKind,
    hash: explicitHash || null,
    label: record.attributes['otelhook.content.label'] ?? null,
    ordinal: ordinal ?? null,
    body: explicitHash ? null : record.body,
    withheld: record.attributes['otelhook.content.withheld'] ?? null,
    truncated: record.attributes['otelhook.content.truncated'] ?? null,
  });
}

export function canonicalizeOtelLogRecord(record: ParsedLogRecord) {
  const eventType = canonicalEventType(record);
  const sequence = canonicalSequence(record);
  const contentKind = canonicalContentKind(record.attributes);
  const contentDisclosure = canonicalContentDisclosure(record.attributes, record.bodyText);
  const generationId =
    String(record.attributes['otelhook.generation.id'] ?? '').trim() || undefined;
  const toolCallId =
    String(
      record.attributes['gen_ai.tool.call.id'] ??
        record.attributes['tool.call.id'] ??
        record.attributes.tool_call_id ??
        '',
    ).trim() || undefined;
  return {
    eventType,
    sequence,
    contentKind,
    contentDisclosure,
    sourceEventId: canonicalSourceEventId(record, eventType, sequence),
    contentKey: canonicalContentKey(record, contentKind),
    contentLabel: String(record.attributes['otelhook.content.label'] ?? '').trim() || undefined,
    correlationId:
      String(
        record.attributes['otelhook.correlation.id'] ??
          record.attributes['correlation.id'] ??
          record.attributes['gen_ai.conversation.id'] ??
          toolCallId ??
          generationId ??
          '',
      ).trim() || undefined,
    generationId,
    toolCallId,
    payload: {
      body: hidesTrajectoryContent(contentDisclosure) ? null : record.body,
      attributes: redactSecretAttributes(record.attributes),
      resource: record.resource,
      recordEventName: record.eventName,
      disclosure: {
        status: contentDisclosure,
        withheld: record.attributes['otelhook.content.withheld'] ?? null,
        truncated: record.attributes['otelhook.content.truncated'] ?? null,
        bodyTruncated: record.attributes['otelhook.content.body_truncated'] ?? null,
        characterLength: record.attributes['otelhook.content.character_length'] ?? null,
        byteLength: record.attributes['otelhook.content.byte_length'] ?? null,
        originalDisclosure: record.attributes['otelhook.content.disclosure'] ?? null,
      },
    },
  };
}

export function canonicalSpanSequence(attributes: AttrMap): number {
  const raw =
    attributes['otelhook.event.sequence'] ??
    attributes['har.sequence'] ??
    attributes.sequence;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

export function canonicalizeOtelSpan(span: ParsedSpan) {
  const sequence = canonicalSpanSequence(span.attributes);
  const promptText = extractPromptText(span.attributes, span.name);
  const responseText = extractResponseText(span.attributes, span.name);
  const contentKind = promptText ? 'prompt' : responseText ? 'response' : 'span';
  const withheld = Boolean(span.attributes['otelhook.content.withheld']);
  const contentDisclosure = withheld
    ? 'withheld' as const
    : promptText || responseText
      ? 'full' as const
      : 'metadata_only' as const;
  const bounded = boundTrajectoryPayload({
    attributes: redactSecretAttributes(span.attributes),
    body: hidesTrajectoryContent(contentDisclosure) ? null : promptText ?? responseText,
    promptText: contentDisclosure === 'full' ? promptText : null,
    responseText: contentDisclosure === 'full' ? responseText : null,
    span: {
      name: span.name,
      startTime: span.startTime.toISOString(),
      endTime: span.endTime?.toISOString() ?? null,
    },
  }, contentDisclosure);
  return {
    eventType: `span.${span.name}`,
    sequence,
    sourceEventId: `span:${span.traceId}:${span.spanId}`,
    contentKey: stableTrajectoryKey({
      kind: contentKind,
      traceId: span.traceId,
      spanId: span.spanId,
    }),
    contentKind,
    contentDisclosure: bounded.contentDisclosure,
    payload: bounded.payload,
    promptText: contentDisclosure === 'full' ? promptText : null,
    responseText: contentDisclosure === 'full' ? responseText : null,
  };
}

export async function ingestOtelLogsJson(payload: unknown): Promise<OtelIngestResult> {
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
    const canonical = canonicalizeOtelLogRecord(record);
    const { eventType, sequence } = canonical;
    const promptText = extractPromptText(record.attributes, eventType, record.bodyText);

    await appendTrajectoryRecord(
      context.repositoryId,
      AgentTrajectoryRecordSchema.parse({
        version: 1,
        source: 'otel',
        sourceEventId: canonical.sourceEventId,
        contentKey: canonical.contentKey,
        sessionKey: context.sessionKey,
        agentId: context.agentId,
        agentTool: context.agentTool,
        eventType,
        sequence,
        timestamp: record.timestamp.toISOString(),
        payload: {
          ...canonical.payload,
          session: {
            workDir: context.workDir,
            branch: context.branch,
            suffix: context.suffix,
          },
        },
        contentKind: canonical.contentKind,
        contentDisclosure: canonical.contentDisclosure,
        contentLabel: canonical.contentLabel,
        traceId: record.traceId,
        spanId: record.spanId,
        parentSpanId: record.parentSpanId,
        generationId: canonical.generationId,
        toolCallId: canonical.toolCallId,
        correlationId: canonical.correlationId,
        workUnitId: context.workUnitId,
        attemptId: context.attemptId,
      }),
    );

    await maybeSetDerivedPurpose(context.repositoryId, context.agentId, promptText);
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
    const canonical = canonicalizeOtelSpan(span);

    await appendTrajectoryRecord(
      context.repositoryId,
      AgentTrajectoryRecordSchema.parse({
        version: 1,
        source: 'otel',
        sourceEventId: canonical.sourceEventId,
        contentKey: canonical.contentKey,
        sessionKey: context.sessionKey,
        agentId: context.agentId,
        agentTool: context.agentTool,
        eventType: canonical.eventType,
        sequence: canonical.sequence,
        timestamp: span.startTime.toISOString(),
        payload: {
          ...canonical.payload,
          session: {
            workDir: context.workDir,
            branch: context.branch,
            suffix: context.suffix,
          },
        },
        contentKind: canonical.contentKind,
        contentDisclosure: canonical.contentDisclosure,
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId ?? undefined,
        workUnitId: context.workUnitId,
        attemptId: context.attemptId,
      }),
    );

    await maybeSetDerivedPurpose(context.repositoryId, context.agentId, canonical.promptText);
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
