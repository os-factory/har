import { createRequire } from 'node:module';
import {
  AgentTrajectoryRecordSchema,
  MAIN_CHECKOUT_AGENT_ID,
  unresolvedWorkspaceOccupancyKey,
  type AgentSessionRef,
  type AgentTool,
} from '@har/schemas';
import { prisma } from '@/lib/db';
import {
  appendTrajectoryRecord,
  stableTrajectoryKey,
} from '@/server/trajectory-ledger';
import {
  claudeApiRequestObservation,
  codexSseObservation,
  isUsageOnlyLogRecord,
  otelHookGenerationObservation,
  providerSessionRef,
  repositoryForProviderSession,
  resolveNonSlotWorktree,
  resolveTargetSlot,
  targetBindingKind,
  timelineSlotAt,
  type SlotEvidence,
} from '@/server/otel-attribution';
import {
  recordBindings,
  recordObservations,
  recordReportedUsage,
  type ObservationInput,
} from '@/server/session-attribution';
import {
  boundTrajectoryPayload,
  hidesTrajectoryContent,
  redactSecretAttributes,
} from '@/lib/trajectory-privacy';
import { linkedWorktreesOf, REPOSITORY_WORKTREE_COLUMNS } from '@/server/git-worktrees';
import {
  deleteParkedOtelRecord,
  parkOtelRecord,
  parkedOtelRecords,
} from '@/server/parked-otel';
import {
  isWorkspaceUnderPath,
  normalizeOtelPath,
  otelWorkspaceIdForPath,
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

export function decodeOtlpProtobufJson(
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
      bytes: String,
      defaults: true,
      arrays: true,
      objects: true,
    });
  } catch {
    return null;
  }
}

export function normalizeOtelId(value: unknown, byteLength: number): string {
  const bytes =
    typeof value === 'string'
      ? /^[0-9a-f]{2,}$/i.test(value) && value.length === byteLength * 2
        ? Buffer.from(value, 'hex')
        : Buffer.from(value, 'base64')
      : value instanceof Uint8Array
        ? Buffer.from(value)
        : null;
  if (!bytes || bytes.length !== byteLength || bytes.every((b) => b === 0)) return '';
  return bytes.toString('hex');
}

export interface AttrMap {
  [key: string]: string | number | boolean;
}

interface ParsedMetricPoint {
  name: string;
  attributes: AttrMap;
  value: number;
  /** OTLP AggregationTemporality: 1 delta, 2 cumulative, 0 unspecified (gauges). */
  temporality: number;
  startTimeUnixNano: string;
  timeUnixNano: string;
  time: Date;
}

function temporalityOf(data: unknown): number {
  const raw =
    (data as { aggregationTemporality?: unknown; aggregation_temporality?: unknown } | undefined)
      ?.aggregationTemporality ??
    (data as { aggregation_temporality?: unknown } | undefined)?.aggregation_temporality;
  if (raw === 1 || raw === 2) return raw;
  if (typeof raw === 'string') {
    if (raw.endsWith('DELTA') || raw === '1') return 1;
    if (raw.endsWith('CUMULATIVE') || raw === '2') return 2;
  }
  return 0;
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
  // Histogram points carry their total in `sum`.
  if (typeof point.sum === 'number') return point.sum;
  if (typeof point.sum === 'string' && Number.isFinite(Number(point.sum))) return Number(point.sum);
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
        const temporality = temporalityOf(data);
        for (const dp of dataPoints) {
          if (!dp || typeof dp !== 'object') continue;
          const record = dp as Record<string, unknown>;
          const time = record.timeUnixNano ?? record.time_unix_nano;
          points.push({
            name,
            attributes: attrsFromOtel(record.attributes),
            value: numberFromDataPoint(record),
            temporality,
            startTimeUnixNano: String(record.startTimeUnixNano ?? record.start_time_unix_nano ?? ''),
            timeUnixNano: String(time ?? ''),
            time: otelTimeToDate(time),
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

interface WorkspaceSlotMatch extends SlotEvidence {
  repositoryId: string;
}

const SLOT_COLUMNS = {
  repositoryId: true,
  slotId: true,
  workDir: true,
  worktreePath: true,
  branch: true,
  suffix: true,
  workUnitId: true,
  attemptId: true,
  occupancyKey: true,
} as const;

function slotMatch(slot: {
  repositoryId: string;
  slotId: number;
  workDir: string | null;
  worktreePath: string | null;
  branch: string | null;
  suffix: string | null;
  workUnitId: string | null;
  attemptId: string | null;
  occupancyKey: string | null;
}): WorkspaceSlotMatch {
  return {
    repositoryId: slot.repositoryId,
    slotId: slot.slotId,
    occupancyKey: slot.occupancyKey,
    branch: slot.branch,
    workDir: slot.workDir ?? slot.worktreePath,
    suffix: slot.suffix,
    workUnitId: slot.workUnitId,
    attemptId: slot.attemptId,
  };
}

/** The slot whose work dir the session itself runs in (workspace evidence). */
async function resolveSlotByWorkspace(workspace: string): Promise<WorkspaceSlotMatch | null> {
  if (!workspace) return null;
  const normalized = normalizePath(workspace);
  const slots = await prisma.agentSlot.findMany({
    where: {
      OR: [
        { workDir: { not: null } },
        { worktreePath: { not: null } },
      ],
    },
    select: SLOT_COLUMNS,
  });

  const match = slots.find((slot) => {
    const candidates = [slot.workDir, slot.worktreePath]
      .filter((p): p is string => Boolean(p))
      .map(normalizePath);
    return candidates.some((slotPath) => isWorkspaceUnderPath(normalized, slotPath));
  });
  return match ? slotMatch(match) : null;
}

export interface ResolvedSessionContext {
  repositoryId: string;
  sessionKey: string;
  /** The slot the record happened in, or `MAIN_CHECKOUT_AGENT_ID` (ADR 0003). */
  agentId: number;
  agentTool: AgentTool;
  workDir?: string;
  branch?: string;
  suffix?: string;
  workUnitId?: string;
  attemptId?: string;
  /** One occupancy of the slot (#316) — null when the slot is idle/unknown. */
  occupancyKey?: string;
  /** The provider session (and subagent) the record belongs to, when it names one. */
  sessionRef?: AgentSessionRef;
  /** Set when the session runs inside a slot's work dir: evidence for a `workspace` binding. */
  workspaceSlot?: SlotEvidence;
}

async function resolveRepositoryByWorkspacePath(
  workspace: string,
): Promise<{ repositoryId: string; path: string } | null> {
  const repos = await prisma.repository.findMany({ select: REPOSITORY_WORKTREE_COLUMNS });
  const best = pickBestRepoPathMatch(
    workspace,
    repos.map((r) => r.path),
  );
  // A linked worktree outside the checkout (`git worktree add ../x`) belongs to its repository too.
  const match = best
    ? repos.find((r) => normalizePath(r.path) === best)
    : repos.find((r) =>
        linkedWorktreesOf(r).worktrees.some((worktree) => isWorkspaceUnderPath(workspace, worktree.path)),
      );
  return match ? { repositoryId: match.id, path: match.path } : null;
}

const WORKTREE_MISS_REFRESH_MS = 1_000;

/**
 * Map otel-hook's opaque workspace id back to a registered path. A slot's work
 * dir wins over its parent checkout, and is then workspace evidence for that slot.
 */
async function resolveRepositoryByWorkspaceId(
  workspaceId: string,
): Promise<{ repositoryId: string; path: string; matchedPath: string; slot: WorkspaceSlotMatch | null } | null> {
  const [repos, slots] = await Promise.all([
    prisma.repository.findMany({ select: REPOSITORY_WORKTREE_COLUMNS }),
    prisma.agentSlot.findMany({
      where: {
        OR: [{ workDir: { not: null } }, { worktreePath: { not: null } }],
      },
      select: SLOT_COLUMNS,
    }),
  ]);

  const candidates: Array<{ repositoryId: string; path: string; candidate: string; slot: WorkspaceSlotMatch | null }> = [];
  for (const repo of repos) {
    candidates.push({ repositoryId: repo.id, path: repo.path, candidate: repo.path, slot: null });
  }
  for (const slot of slots) {
    const repo = repos.find((r) => r.id === slot.repositoryId);
    if (!repo) continue;
    for (const candidate of [slot.workDir, slot.worktreePath]) {
      if (candidate) {
        candidates.push({ repositoryId: repo.id, path: repo.path, candidate, slot: slotMatch(slot) });
      }
    }
  }
  // otel-hook sends only the hashed id of the session's cwd, so a non-slot git
  // worktree (`git worktree add`, Claude Code's EnterWorktree) is found only if
  // its path is a candidate too, as resolveRepositoryByWorkspacePath does for a
  // raw path — read from the repository's git directory, or, in docker, from
  // the listing the CLI reported. Slot work dirs were added first and keep
  // winning on a tie.
  const withWorktrees = (maxAgeMs?: number) => [
    ...candidates,
    ...repos.flatMap((repo) =>
      linkedWorktreesOf(repo, Date.now(), maxAgeMs).worktrees.map((worktree) => ({
        repositoryId: repo.id,
        path: repo.path,
        candidate: worktree.path,
        slot: null,
      })),
    ),
  ];
  let all = withWorktrees();
  let matchedPath = pickPathForWorkspaceId(workspaceId, all.map((c) => c.candidate));
  if (!matchedPath) {
    // A session that just created its worktree (EnterWorktree) reports from it
    // within the listing cache's lifetime: re-read listings older than a second.
    all = withWorktrees(WORKTREE_MISS_REFRESH_MS);
    matchedPath = pickPathForWorkspaceId(workspaceId, all.map((c) => c.candidate));
  }
  if (!matchedPath) return null;
  const hit = all.find((c) => normalizePath(c.candidate) === matchedPath);
  return hit
    ? { repositoryId: hit.repositoryId, path: hit.path, matchedPath, slot: hit.slot }
    : null;
}

function contextFromSlot(
  base: Pick<ResolvedSessionContext, 'repositoryId' | 'sessionKey' | 'agentTool' | 'sessionRef'>,
  slot: SlotEvidence,
  fallbackWorkDir?: string,
): ResolvedSessionContext {
  return {
    ...base,
    agentId: slot.slotId,
    workDir: slot.workDir ?? fallbackWorkDir,
    branch: slot.branch ?? undefined,
    suffix: slot.suffix ?? undefined,
    workUnitId: slot.workUnitId ?? undefined,
    attemptId: slot.attemptId ?? undefined,
    occupancyKey: slot.occupancyKey ?? undefined,
  };
}

/**
 * Where a record happened (ADR 0003), from evidence only. The record's own
 * evidence — its session's cwd is a slot work dir (`workspace`), or its tool
 * event targeted a slot worktree (`vcs.ref.head.name` / hashed target
 * workspace: `observed`, or `workspace` for `otelhook.target.source =
 * session-cwd`) — joins the session's binding timeline, and the record goes to
 * the binding in force at its time; with none, to the main checkout
 * (`MAIN_CHECKOUT_AGENT_ID`). A record with no provider session id is placed by
 * its own evidence only.
 *
 * The repo's single active slot, the most recent slot and slot 1 are never
 * used as a fallback, and nor is the slot of the session's first event.
 * The evidence is returned so the caller records it as bindings.
 */
export async function resolveSessionContext(
  resource: AttrMap,
  attributes: AttrMap = {},
  options: { at?: Date } = {},
): Promise<{ context: ResolvedSessionContext | null; reason?: string; evidence?: SlotBindingEvidence[] }> {
  const tool =
    detectAgentTool(attributes) ?? detectAgentTool(resource) ?? null;
  const harSessionKey = String(
    resource['har.session_key'] ?? attributes['har.session_key'] ?? '',
  );
  const repoPath = String(resource['har.repo_path'] ?? attributes['har.repo_path'] ?? '');
  const workspace = workspaceFromAttrs(attributes, resource);
  const workspaceId = workspaceIdFromAttrs(attributes, resource);
  const providerSessionId = sessionIdFromAttrs(attributes, resource);
  const at = options.at ?? new Date();

  let repository: { repositoryId: string; workDir?: string; sessionKey: string } | null = null;
  let workspaceSlot: WorkspaceSlotMatch | null = null;

  // Prefer live workspace/slot matching over stale global har.session_key
  // resource attributes left behind by the last `har env launch`.
  if (workspace) {
    workspaceSlot = await resolveSlotByWorkspace(workspace);
    if (workspaceSlot) {
      // #316: the matched slot's own key wins over `har.session_key`. That
      // resource attribute is written once per launch and survives the
      // occupancy that wrote it (Claude Code also reuses `session.id` across
      // a resume), so preferring it merged a new worktree's events into the
      // previous session. The workspace match is live evidence; the attribute
      // is not.
      repository = {
        repositoryId: workspaceSlot.repositoryId,
        workDir: workspaceSlot.workDir ?? workspace,
        sessionKey: workspaceSlot.branch || `agent-${workspaceSlot.slotId}`,
      };
    } else {
      const byRepo = await resolveRepositoryByWorkspacePath(workspace);
      if (byRepo) {
        repository = {
          repositoryId: byRepo.repositoryId,
          workDir: workspace,
          sessionKey: harSessionKey || providerSessionId || `ide:${normalizePath(byRepo.path)}`,
        };
      }
    }
  }

  if (!repository && workspaceId) {
    const byId = await resolveRepositoryByWorkspaceId(workspaceId);
    if (byId) {
      workspaceSlot = byId.slot;
      repository = {
        repositoryId: byId.repositoryId,
        workDir: byId.matchedPath,
        sessionKey: byId.slot
          ? byId.slot.branch || `agent-${byId.slot.slotId}`
          : harSessionKey || providerSessionId || `ide:${normalizePath(byId.path)}`,
      };
    }
  }

  if (!repository && harSessionKey) {
    const repositoryId = await resolveRepositoryId(repoPath || undefined);
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
    repository = {
      repositoryId,
      workDir: resource['har.work_dir'] ? String(resource['har.work_dir']) : workspace || undefined,
      sessionKey: harSessionKey,
    };
  }

  // A session Mission Control already knows (its earlier records were placed),
  // now reporting from a place no repository path, slot or listed worktree
  // names: a worktree not listed yet (docker sees no `.git`, and the CLI
  // reports listings only when it syncs) or a subdirectory. The session's
  // repository is known, so the record stays there, in an explicit
  // unresolved-place bucket — never dropped.
  let unresolvedWorkspaceId: string | null = null;
  if (!repository && (workspace || workspaceId) && tool) {
    const ref = providerSessionRef(tool, attributes, resource);
    const known = ref ? await repositoryForProviderSession(ref) : null;
    if (ref && known) {
      unresolvedWorkspaceId = workspaceId || otelWorkspaceIdForPath(normalizeOtelPath(workspace));
      repository = { repositoryId: known, sessionKey: providerSessionId || ref.sessionId };
    }
  }

  if (!repository) {
    return {
      context: null,
      reason: `no repository matched workspace ${workspace || workspaceId || '(empty)'}`,
    };
  }

  const agentTool = tool ?? 'cursor';
  const sessionRef = providerSessionRef(agentTool, attributes, resource) ?? undefined;
  const base = {
    repositoryId: repository.repositoryId,
    sessionKey: repository.sessionKey,
    agentTool,
    ...(sessionRef ? { sessionRef } : {}),
  };

  // Evidence this record carries: the session's own cwd is a slot work dir
  // (`workspace`), or its tool event targeted a slot worktree (`observed`, or
  // `workspace` when otel-hook derived the target from the session cwd).
  const evidence: SlotBindingEvidence[] = [];
  if (workspaceSlot) evidence.push({ kind: 'workspace', slot: workspaceSlot });
  const targetSlot = await resolveTargetSlot(repository.repositoryId, attributes);
  if (targetSlot) evidence.push({ kind: targetBindingKind(attributes), slot: targetSlot });
  // What no slot claimed may still be a non-slot git worktree: recorded so its
  // usage splits from the main checkout's, never placed on a slot.
  // The session's cwd: its raw path, or the path its opaque workspace id matched.
  const sessionCwd = workspace || (workspaceId ? repository.workDir : undefined);
  const worktree = await resolveNonSlotWorktree(repository.repositoryId, {
    workspace: workspaceSlot ? undefined : sessionCwd,
    attrs: targetSlot ? undefined : attributes,
  });
  if (worktree) evidence.push(worktree);
  if (unresolvedWorkspaceId && !evidence.some((item) => item.kind === 'workspace')) {
    evidence.push({ kind: 'workspace', slot: unresolvedPlaceEvidence(unresolvedWorkspaceId) });
  }

  // With a provider session, the record goes where the session's timeline —
  // including this evidence — puts it at that time, so repeating cwd evidence
  // never overrides a later move elsewhere. Without one, only direct evidence
  // places it.
  const placed = sessionRef
    ? await timelineSlotAt(
        repository.repositoryId,
        sessionRef,
        at,
        evidence.map(({ kind, slot }) => evidenceBinding(sessionRef, kind, slot, at)),
      )
    : (() => {
        const slotEvidence = evidence.filter((item) => item.slot.slotId !== MAIN_CHECKOUT_AGENT_ID);
        return (slotEvidence.find((item) => item.kind === 'observed') ?? slotEvidence[0])?.slot ?? null;
      })();

  const context: ResolvedSessionContext = placed
    ? contextFromSlot(base, placed, repository.workDir)
    : {
        ...base,
        agentId: MAIN_CHECKOUT_AGENT_ID,
        workDir: repository.workDir,
        branch: resource['har.branch'] ? String(resource['har.branch']) : undefined,
        suffix: undefined,
        workUnitId: undefined,
        attemptId: undefined,
      };
  if (workspaceSlot) context.workspaceSlot = workspaceSlot;
  return { context, evidence };
}

/** The session's cwd is a place of the repository Mission Control cannot name yet. */
function unresolvedPlaceEvidence(workspaceId: string): SlotEvidence {
  return {
    slotId: MAIN_CHECKOUT_AGENT_ID,
    occupancyKey: unresolvedWorkspaceOccupancyKey(workspaceId),
    branch: null,
    workDir: null,
    suffix: null,
    workUnitId: null,
    attemptId: null,
  };
}

export interface SlotBindingEvidence {
  kind: 'workspace' | 'observed';
  slot: SlotEvidence;
}

function evidenceBinding(
  ref: AgentSessionRef,
  kind: SlotBindingEvidence['kind'],
  slot: SlotEvidence,
  at: Date,
) {
  return {
    agentTool: ref.agentTool,
    sessionId: ref.sessionId,
    subagentId: ref.subagentId ?? null,
    kind,
    slotId: slot.slotId,
    occupancyKey: slot.occupancyKey,
    branch: slot.branch,
    at,
  };
}

/** Record the slot evidence a resolved record carries as bindings of its session. */
async function recordContextEvidence(
  context: ResolvedSessionContext,
  evidence: SlotBindingEvidence[] | undefined,
  at: Date,
): Promise<void> {
  const ref = context.sessionRef;
  if (!ref || !evidence?.length) return;
  await recordBindings(
    context.repositoryId,
    evidence.map(({ kind, slot }) => evidenceBinding(ref, kind, slot, at)),
    'otel',
  );
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
  if (!promptText || agentId === MAIN_CHECKOUT_AGENT_ID) return;
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
  /** Kept for replay: their session's place is not known yet (never dropped). */
  parked?: number;
  reasons: string[];
}

/**
 * Repository of a provider session: where its earlier evidence was placed, else
 * whatever the record's own resource/attributes resolve to.
 */
async function repositoryForRecord(
  ref: AgentSessionRef,
  resource: AttrMap,
  attributes: AttrMap,
): Promise<{ repositoryId: string | null; reason?: string }> {
  const known = await repositoryForProviderSession(ref);
  if (known) return { repositoryId: known };
  const resolved = await resolveSessionContext(resource, attributes);
  return { repositoryId: resolved.context?.repositoryId ?? null, reason: resolved.reason };
}

function isClaudeCostPoint(point: ParsedMetricPoint): boolean {
  return point.name === 'claude_code.cost.usage' || point.name.endsWith('cost.usage');
}

function isClaudeTokenPoint(point: ParsedMetricPoint): boolean {
  return point.name === 'claude_code.token.usage' || point.name.endsWith('token.usage');
}

/**
 * Claude Code's native metrics are session totals (`claude_code.cost.usage`,
 * `claude_code.token.usage`), not units of usage: they are kept per session as
 * a cross-check against the sum of its `api_request` observations and never
 * booked on a slot (ADR 0003).
 */
async function ingestClaudeSessionTotals(
  resource: AttrMap,
  points: ParsedMetricPoint[],
): Promise<OtelIngestResult> {
  const result: OtelIngestResult = { accepted: 0, dropped: 0, reasons: [] };
  const bySession = new Map<string, ParsedMetricPoint[]>();
  for (const point of points) {
    const sessionId = String(point.attributes['session.id'] ?? '');
    const list = bySession.get(sessionId) ?? [];
    list.push(point);
    bySession.set(sessionId, list);
  }
  for (const [sessionId, sessionPoints] of bySession) {
    const ref = sessionId ? providerSessionRef('claude_code', { 'session.id': sessionId }) : null;
    if (!ref) {
      result.dropped += 1;
      result.reasons.push('Claude metrics without session.id');
      continue;
    }
    const { repositoryId, reason } = await repositoryForRecord(ref, resource, sessionPoints[0].attributes);
    if (!repositoryId) {
      result.dropped += 1;
      result.reasons.push(reason ?? `no repository known for Claude session ${sessionId}`);
      continue;
    }
    const costPoints = sessionPoints.filter(isClaudeCostPoint);
    const tokenPoints = sessionPoints.filter(isClaudeTokenPoint);
    if (costPoints.length === 0 && tokenPoints.length === 0) {
      result.dropped += 1;
      result.reasons.push(`no token/cost points for ${sessionId}`);
      continue;
    }
    const temporality = sessionPoints.some((point) => point.temporality === 1) ? 'delta' : 'cumulative';
    const at = new Date(Math.max(...sessionPoints.map((point) => point.time.getTime())));
    await recordReportedUsage(repositoryId, {
      agentTool: 'claude_code',
      sessionId: ref.sessionId,
      costUsd: costPoints.length ? costPoints.reduce((sum, point) => sum + point.value, 0) : null,
      tokensTotal: tokenPoints.reduce((sum, point) => sum + point.value, 0),
      at,
      temporality,
    });
    result.accepted += 1;
  }
  return result;
}

/** Store observations, grouped per repository of their session. */
async function storeObservations(
  observations: ObservationInput[],
  resource: AttrMap,
  attributes: (observation: ObservationInput) => AttrMap,
): Promise<OtelIngestResult> {
  const result: OtelIngestResult = { accepted: 0, dropped: 0, reasons: [] };
  for (const observation of observations) {
    const { repositoryId, reason } = await repositoryForRecord(observation as AgentSessionRef, resource, attributes(observation));
    if (!repositoryId) {
      result.dropped += 1;
      result.reasons.push(reason ?? `no repository known for session ${observation.sessionId}`);
      continue;
    }
    await recordObservations(repositoryId, [observation]);
    result.accepted += 1;
  }
  return result;
}

export async function ingestOtelMetricsJson(payload: unknown): Promise<OtelIngestResult> {
  const result: OtelIngestResult = { accepted: 0, dropped: 0, reasons: [] };
  const merge = (part: OtelIngestResult) => {
    result.accepted += part.accepted;
    result.dropped += part.dropped;
    result.reasons.push(...part.reasons);
  };

  for (const group of extractPointsFromResourceMetrics(payload)) {
    const tool = detectAgentTool(group.resource);
    if (tool === 'claude_code') {
      merge(await ingestClaudeSessionTotals(group.resource, group.points));
      continue;
    }
    // Other agents' metrics name no unit of usage and no session to bind it to
    // (Codex `codex.turn.token_usage` carries no thread id): their usage comes
    // from otel-hook generation spans and harvest (ADR 0003).
    result.dropped += 1;
    result.reasons.push(`metrics from ${tool ?? 'an unknown agent'} carry no attributable usage`);
  }

  return result;
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
          traceId: normalizeOtelId(record.traceId ?? record.trace_id, 16) || undefined,
          spanId: normalizeOtelId(record.spanId ?? record.span_id, 8) || undefined,
          parentSpanId:
            normalizeOtelId(record.parentSpanId ?? record.parent_span_id, 8) || undefined,
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

function isSpanMirrorLogRecord(record: ParsedLogRecord): boolean {
  return record.eventName.startsWith('span.') && Boolean(record.spanId ?? record.attributes['span_id']);
}

export async function ingestOtelLogsJson(
  payload: unknown,
  options: IngestOptions = {},
): Promise<OtelIngestResult> {
  const records = extractLogRecords(payload);
  const park = options.park ?? true;
  const sessions = new Set<string>();
  let accepted = 0;
  let dropped = 0;
  let parked = 0;
  const reasons: string[] = [];

  for (const record of records) {
    // Per-request usage events (Claude `api_request`, Codex `sse_event`) are
    // usage observations, attributed when read — not trajectory facts.
    if (isUsageOnlyLogRecord(record)) {
      const observation = claudeApiRequestObservation(record) ?? codexSseObservation(record);
      if (!observation) {
        dropped += 1;
        reasons.push(`usage event ${record.eventName} without session id or tokens`);
        continue;
      }
      const stored = await storeObservations([observation], record.resource, () => record.attributes);
      accepted += stored.accepted;
      if (stored.accepted > 0) sessions.add(observation.sessionId);
      reasons.push(...stored.reasons);
      // Its session's place is not known yet: kept for replay, never dropped.
      const kept = stored.dropped > 0 && park && await tryPark({
        signal: 'log',
        agentTool: observation.agentTool,
        sessionId: observation.sessionId,
        workspaceId: workspaceIdFromAttrs(record.attributes, record.resource) || null,
        record: otlpLogsPayload(record),
      });
      if (kept) parked += stored.dropped;
      else dropped += stored.dropped;
      continue;
    }

    const at = record.timestamp.getTime() > 0 ? record.timestamp : new Date();
    const resolved = await resolveSessionContext(record.resource, record.attributes, { at });
    if (!resolved.context) {
      dropped += 1;
      reasons.push(resolved.reason ?? 'unresolved session for log');
      continue;
    }
    const { context } = resolved;
    // A `span.*` event mirrors a span at the span's start time, with the cwd
    // seen at its end; the span itself records that evidence at the right time.
    if (!isSpanMirrorLogRecord(record)) await recordContextEvidence(context, resolved.evidence, at);
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
        occupancyKey: context.occupancyKey,
      }),
    );

    await maybeSetDerivedPurpose(context.repositoryId, context.agentId, promptText);
    if (context.sessionRef) sessions.add(context.sessionRef.sessionId);
    accepted += 1;
  }

  if (park) await replayParkedForSessions(sessions);
  return { accepted, dropped, ...(parked ? { parked } : {}), reasons };
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

export function extractSpans(payload: unknown): ParsedSpan[] {
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
          traceId: normalizeOtelId(record.traceId ?? record.trace_id, 16),
          spanId: normalizeOtelId(record.spanId ?? record.span_id, 8),
          parentSpanId: normalizeOtelId(record.parentSpanId ?? record.parent_span_id, 8) || null,
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

export async function ingestOtelTracesJson(
  payload: unknown,
  options: IngestOptions = {},
): Promise<OtelIngestResult> {
  const spans = extractSpans(payload);
  const park = options.park ?? true;
  const sessions = new Set<string>();
  let accepted = 0;
  let dropped = 0;
  let parked = 0;
  const reasons: string[] = [];

  for (const span of spans) {
    if (!span.traceId || !span.spanId) {
      dropped += 1;
      reasons.push('missing trace/span id');
      continue;
    }

    // otel-hook exports a span when it ends, with the cwd it saw then: the
    // session span carries the cwd at session end over the session's whole
    // duration. Its evidence holds from the end, or it would move every
    // earlier request of a session that later entered a worktree.
    const evidenceAt = span.endTime ?? span.startTime;
    const resolved = await resolveSessionContext(span.resource, span.attributes, { at: evidenceAt });
    if (!resolved.context) {
      reasons.push(resolved.reason ?? 'unresolved session for span');
      // A span that carries usage is kept for replay (its own workspace id
      // places it then), never dropped; other spans are.
      const tool = detectAgentTool(span.attributes) ?? detectAgentTool(span.resource);
      const usage = tool ? otelHookGenerationObservation(span, tool) : null;
      const kept = usage && park && await tryPark({
        signal: 'span',
        agentTool: tool,
        sessionId: usage.sessionId,
        workspaceId: workspaceIdFromAttrs(span.attributes, span.resource) || null,
        record: otlpTracesPayload(span),
      });
      if (kept) parked += 1;
      else dropped += 1;
      continue;
    }
    const { context } = resolved;
    await recordContextEvidence(context, resolved.evidence, evidenceAt);
    const observation = otelHookGenerationObservation(span, context.agentTool);
    if (observation) await recordObservations(context.repositoryId, [observation]);
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
        occupancyKey: context.occupancyKey,
      }),
    );

    await maybeSetDerivedPurpose(context.repositoryId, context.agentId, canonical.promptText);
    if (context.sessionRef) sessions.add(context.sessionRef.sessionId);
    accepted += 1;
  }

  if (park) await replayParkedForSessions(sessions);
  return { accepted, dropped, ...(parked ? { parked } : {}), reasons };
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

// ---------------------------------------------------------------------------
// Parked records (Mission Control in docker cannot see `.git`, FE-2058)

interface IngestOptions {
  /** Park a usage-bearing record no repository resolves for yet, instead of dropping it (default). */
  park?: boolean;
}

function otlpAttrs(map: AttrMap): Array<{ key: string; value: Record<string, unknown> }> {
  return Object.entries(map).map(([key, value]) => ({
    key,
    value:
      typeof value === 'number'
        ? Number.isInteger(value) ? { intValue: value } : { doubleValue: value }
        : typeof value === 'boolean'
          ? { boolValue: value }
          : { stringValue: String(value) },
  }));
}

function unixNano(date: Date | null): string | undefined {
  return date ? `${date.getTime()}000000` : undefined;
}

/** One parsed span as a one-span OTLP JSON document, re-ingested on replay. */
function otlpTracesPayload(span: ParsedSpan) {
  return {
    resourceSpans: [
      {
        resource: { attributes: otlpAttrs(span.resource) },
        scopeSpans: [
          {
            spans: [
              {
                traceId: span.traceId,
                spanId: span.spanId,
                ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
                name: span.name,
                startTimeUnixNano: unixNano(span.startTime),
                ...(span.endTime ? { endTimeUnixNano: unixNano(span.endTime) } : {}),
                attributes: otlpAttrs(span.attributes),
              },
            ],
          },
        ],
      },
    ],
  };
}

/** One parsed log record as a one-record OTLP JSON document, re-ingested on replay. */
function otlpLogsPayload(record: ParsedLogRecord) {
  return {
    resourceLogs: [
      {
        resource: { attributes: otlpAttrs(record.resource) },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: unixNano(record.timestamp),
                eventName: record.eventName,
                ...(record.body != null ? { body: record.body } : {}),
                ...(record.traceId ? { traceId: record.traceId } : {}),
                ...(record.spanId ? { spanId: record.spanId } : {}),
                ...(record.parentSpanId ? { parentSpanId: record.parentSpanId } : {}),
                attributes: otlpAttrs(record.attributes),
              },
            ],
          },
        ],
      },
    ],
  };
}

async function tryPark(input: Parameters<typeof parkOtelRecord>[0]): Promise<boolean> {
  try {
    await parkOtelRecord(input);
    return true;
  } catch (err) {
    console.warn('[otel] could not park an unresolved record:', err instanceof Error ? err.message : err);
    return false;
  }
}

/** Records just accepted made their sessions known: their parked records may resolve now. Never fails ingest. */
async function replayParkedForSessions(sessions: Set<string>): Promise<void> {
  if (sessions.size === 0) return;
  try {
    await replayParkedOtelRecords({ sessionIds: [...sessions] });
  } catch (err) {
    console.warn('[otel] parked record replay failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Re-ingest parked records (all, or those of the given sessions). A record
 * that now resolves — a worktree listing names its workspace, or its session
 * became known — is stored and leaves the park; the rest stay.
 */
export async function replayParkedOtelRecords(
  filter: { sessionIds?: string[] } = {},
): Promise<{ replayed: number; remaining: number }> {
  let replayed = 0;
  let remaining = 0;
  for (const row of await parkedOtelRecords(filter)) {
    const result = row.signal === 'span'
      ? await ingestOtelTracesJson(row.payload, { park: false })
      : await ingestOtelLogsJson(row.payload, { park: false });
    if (result.accepted > 0 && result.dropped === 0) {
      await deleteParkedOtelRecord(row.id);
      replayed += 1;
    } else {
      remaining += 1;
    }
  }
  return { replayed, remaining };
}
