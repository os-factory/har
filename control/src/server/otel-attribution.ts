import {
  AgentSessionRefSchema,
  SESSION_ID_ATTR,
  SUBAGENT_ID_ATTR,
  TARGET_BRANCH_ATTR,
  TARGET_REPOSITORY_ID_ATTR,
  TARGET_SOURCE_ATTR,
  TARGET_WORKSPACE_ID_ATTR,
  TARGET_WORKTREE_KIND_ATTR,
  type AgentSessionRef,
  type AgentTool,
  type SessionBindingKind,
  BindingTimeline,
  MAIN_CHECKOUT_AGENT_ID,
  worktreeOccupancyKey,
  type OccupancyEvent,
  type TimelineBinding,
} from '@har/schemas';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { findTimelinePoints, TIMELINE_POINT_WHERE } from '@/server/timeline-points';
import { occupancyKeyForAttempt } from '@/server/occupancy';
import {
  isWorkspaceUnderPath,
  normalizeOtelPath,
  otelWorkspaceIdForPath,
  pathAsWrittenAndResolved,
  pickPathForWorkspaceId,
} from '@/server/otel-workspace';
import { WORKTREE_MISS_REFRESH_MS, listLinkedWorktrees } from '@/server/git-worktrees';
import type { ObservationInput } from '@/server/session-attribution';

/**
 * OTLP → evidence-timeline producers (ADR 0003): which provider session an
 * OTLP record belongs to, which slot it is evidence for, and which usage
 * observation it reports. Extractors are pure; lookups read the database.
 */

export type OtelAttrs = Record<string, string | number | boolean>;

function str(maps: OtelAttrs[], keys: string[]): string | undefined {
  for (const map of maps) {
    for (const key of keys) {
      const raw = map[key];
      if (typeof raw === 'string' && raw.trim()) return raw.trim();
      if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
    }
  }
  return undefined;
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function int(value: unknown): number {
  return Math.floor(num(value));
}

/**
 * The launch's session key: the Resource `session.id` HAR puts on every agent
 * session it launches (`OTEL_RESOURCE_ATTRIBUTES`). Empty when none was set.
 */
export function harnessSessionKey(resource: OtelAttrs): string {
  const raw = resource[SESSION_ID_ATTR];
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * A Resource without the launch's `session.id`, for provider session lookups:
 * that key names the HAR session, never the provider's, so it must not stand
 * in for a record that carries no provider session id of its own.
 */
export function providerResource(resource: OtelAttrs): OtelAttrs {
  if (!(SESSION_ID_ATTR in resource)) return resource;
  const rest: OtelAttrs = {};
  for (const [key, value] of Object.entries(resource)) if (key !== SESSION_ID_ATTR) rest[key] = value;
  return rest;
}

/**
 * Provider session ids, most specific first. otel-hook puts a HAR session key
 * on a record's `session.id` when one is configured and keeps the provider's own id on
 * `otelhook.session.id` / `gen_ai.conversation.id`; Claude Code native events
 * carry it on `session.id`; Codex native events on `conversation.id`.
 */
const SESSION_ID_KEYS = [
  'otelhook.session.id',
  'gen_ai.conversation.id',
  'conversation.id',
  'conversation_id',
  'thread.id',
  'thread_id',
  'session.id',
];

/** Subagent id: otel-hook's provider-neutral attribute, or Claude Code native `agent_id`. */
const SUBAGENT_ID_KEYS = [SUBAGENT_ID_ATTR, 'agent_id'];

export function providerSessionRef(agentTool: AgentTool, ...maps: OtelAttrs[]): AgentSessionRef | null {
  const sessionId = str(maps, SESSION_ID_KEYS);
  if (!sessionId || !AgentSessionRefSchema.shape.sessionId.safeParse(sessionId).success) return null;
  const subagentId = str(maps, SUBAGENT_ID_KEYS);
  return {
    agentTool,
    sessionId,
    ...(subagentId && subagentId !== sessionId ? { subagentId: subagentId.slice(0, 256) } : {}),
  };
}

function shortHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

function isoAttr(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface OtelLogLike {
  eventName: string;
  bodyText: string | null;
  attributes: OtelAttrs;
  resource: OtelAttrs;
  timestamp: Date;
}

function eventIs(record: OtelLogLike, fullName: string): boolean {
  const short = fullName.slice(fullName.indexOf('.') + 1);
  const names = [record.eventName, record.bodyText ?? '', String(record.attributes['event.name'] ?? '')];
  return names.some((name) => name === fullName || name === short);
}

/**
 * Claude Code's native `claude_code.api_request` event (OTLP logs exporter),
 * which HAR before 2.0 turned on. Claude Code usage comes from otel-hook
 * generations only (ADR 0005 section 5), so these are dropped, never booked.
 */
export function isClaudeNativeUsageRecord(record: OtelLogLike): boolean {
  return eventIs(record, 'claude_code.api_request');
}

/** Whether a log record only reports usage (it becomes an observation, not a trajectory fact). */
export function isUsageOnlyLogRecord(record: OtelLogLike): boolean {
  return isCodexCompletedResponse(record);
}

function isCodexCompletedResponse(record: OtelLogLike): boolean {
  if (!eventIs(record, 'codex.sse_event')) return false;
  const kind = String(record.attributes['event.kind'] ?? record.attributes.kind ?? '');
  return kind === 'response.completed' || record.attributes.input_token_count != null;
}

/**
 * Codex native OTLP `codex.sse_event` for `response.completed`: one model
 * response, the finest unit Codex reports. Codex input counts include cached
 * input and output counts include reasoning, so they are split into HAR's
 * disjoint buckets here.
 */
export function codexSseObservation(record: OtelLogLike): ObservationInput | null {
  if (!isCodexCompletedResponse(record)) return null;
  const attrs = record.attributes;
  const ref = providerSessionRef('codex', attrs, providerResource(record.resource));
  if (!ref) return null;
  const input = int(attrs.input_token_count);
  const cached = Math.min(int(attrs.cached_token_count), input);
  const output = int(attrs.output_token_count);
  if (input + output === 0) return null;
  const observedAt = isoAttr(attrs['event.timestamp']) ?? record.timestamp;
  const responseId = str([attrs], ['response.id', 'response_id']);
  return {
    ...ref,
    observationKey:
      responseId ?? `codex-sse:${shortHash([observedAt.toISOString(), input, cached, output, attrs['event.sequence'] ?? null])}`,
    observedAt,
    granularity: 'request',
    source: 'otel',
    producer: 'codex.sse_event',
    model: str([attrs, record.resource], ['model', 'slug']) ?? null,
    tokensInput: input - cached,
    tokensOutput: output,
    tokensCacheRead: cached,
    tokensCacheCreation: 0,
    costUsd: null,
  };
}

export interface OtelSpanLike {
  name: string;
  traceId: string;
  spanId: string;
  startTime: Date;
  endTime: Date | null;
  attributes: OtelAttrs;
  resource: OtelAttrs;
}

/**
 * otel-hook generation span (Claude Code and Codex `Stop`, Claude Code
 * `SubagentStop`, Cursor `stop`, ...) carrying `gen_ai.usage.*`: the only
 * source of agent usage (ADR 0005 section 5). Keyed by `otelhook.generation.id`
 * (Cursor `generation_id`, Codex `turn_id`), so a span delivered twice is one fact.
 * otel-hook's input count is inclusive of cache reads (and of cache writes
 * where the provider bills them inside input), so the uncached part is what
 * remains. With `otelhook.usage.temporality = cumulative` (Codex) the counts
 * are the session's running total: they are stored as such and the turn's own
 * usage is its difference from the previous turn. Session, subagent and
 * compaction spans carry rollups, never units.
 *
 * Claude Code reports one generation per turn and one per subagent run (its
 * tokens read from the transcript, `otelhook.usage.temporality = delta`); a
 * subagent's carries `otelhook.subagent.id` and is booked on the subagent.
 */
export function otelHookGenerationObservation(
  span: OtelSpanLike,
  agentTool: AgentTool,
): ObservationInput | null {
  if (!(span.name === 'generation' || span.name.startsWith('generation '))) return null;
  const attrs = span.attributes;
  const hasUsage = Object.keys(attrs).some((key) => key.startsWith('gen_ai.usage.'));
  if (!hasUsage) return null;
  const ref = providerSessionRef(agentTool, attrs, providerResource(span.resource));
  if (!ref) return null;
  const input = int(attrs['gen_ai.usage.input_tokens'] ?? attrs['gen_ai.usage.prompt_tokens']);
  const cacheRead = int(attrs['gen_ai.usage.cache_read.input_tokens']);
  const cacheCreation = int(attrs['gen_ai.usage.cache_creation.input_tokens']);
  const output = int(attrs['gen_ai.usage.output_tokens'] ?? attrs['gen_ai.usage.completion_tokens']);
  const tokens = {
    tokensInput: Math.max(0, input - cacheRead - cacheCreation),
    tokensOutput: output,
    tokensCacheRead: cacheRead,
    tokensCacheCreation: cacheCreation,
  };
  const temporality = str([attrs], ['otelhook.usage.temporality']);
  // Before otel-hook stamped the temporality, only Codex reported running totals.
  const cumulative = temporality ? temporality === 'cumulative' : agentTool === 'codex';
  const generationId = str([attrs], ['otelhook.generation.id']);
  return {
    ...ref,
    // Without a generation id the span id is the only stable key; it cannot
    // merge with a harvest, so it is a stream of its own.
    observationKey: generationId ?? `otelhook-generation:${span.spanId}`,
    observedAt: span.endTime ?? span.startTime,
    granularity: agentTool === 'codex' || agentTool === 'claude_code' ? 'turn' : 'generation',
    source: 'otel',
    producer: generationId ? 'otelhook.generation' : 'otelhook.generation-span',
    model: str([attrs], ['gen_ai.response.model', 'gen_ai.request.model']) ?? null,
    ...tokens,
    costUsd: null,
    ...(cumulative ? { runningTotal: tokens } : {}),
  };
}

// ---------------------------------------------------------------------------
// Lookups

export interface SlotEvidence {
  slotId: number;
  occupancyKey: string | null;
  branch: string | null;
  workDir: string | null;
  suffix: string | null;
  workUnitId: string | null;
  attemptId: string | null;
}

interface SlotRow {
  slotId: number;
  active: boolean;
  occupancyKey: string | null;
  branch: string | null;
  workDir: string | null;
  worktreePath: string | null;
  suffix: string | null;
  workUnitId: string | null;
  attemptId: string | null;
}

function evidenceFromSlot(slot: SlotRow): SlotEvidence {
  return {
    slotId: slot.slotId,
    occupancyKey: slot.occupancyKey,
    branch: slot.branch,
    workDir: slot.workDir ?? slot.worktreePath,
    suffix: slot.suffix,
    workUnitId: slot.workUnitId,
    attemptId: slot.attemptId,
  };
}

const SLOT_SELECT = {
  slotId: true,
  active: true,
  occupancyKey: true,
  branch: true,
  workDir: true,
  worktreePath: true,
  suffix: true,
  workUnitId: true,
  attemptId: true,
} as const;

/**
 * How the target was derived (`otelhook.target.source`): `tool-path` and
 * `shell-cwd` are evidence the session moved into that worktree (`observed`);
 * `session-cwd` is only the session's own cwd (`workspace`).
 */
export function targetBindingKind(attrs: OtelAttrs): 'observed' | 'workspace' {
  return str([attrs], [TARGET_SOURCE_ATTR]) === 'session-cwd' ? 'workspace' : 'observed';
}

/**
 * Whether a target in another repository is where the session now works: its
 * own or its shell's cwd. A file it only touched there (`tool-path`, a Read of
 * that repository's README) is not (FE-2058).
 */
export function targetMovesPlace(attrs: OtelAttrs): boolean {
  const source = str([attrs], [TARGET_SOURCE_ATTR]);
  return source === 'session-cwd' || source === 'shell-cwd';
}

/** Where a tool event's target is, by repository: its main checkout or a linked worktree of it. */
export interface TargetRepository {
  repositoryId: string;
  path: string;
  linked: boolean;
}

interface RegisteredRepository {
  id: string;
  path: string;
}

let repositoryIndex: { key: string; byOtelId: Map<string, RegisteredRepository> } | null = null;

/**
 * Registered repositories by otel-hook repository id, each path hashed as
 * written and resolved. Every tool event looks one up: the hashes (and
 * `realpath`s) are computed again only when the registered repositories change.
 */
function repositoriesByOtelId(repos: RegisteredRepository[]): Map<string, RegisteredRepository> {
  const key = JSON.stringify(repos.map((repo) => [repo.id, repo.path]));
  if (repositoryIndex?.key !== key) {
    const byOtelId = new Map<string, RegisteredRepository>();
    for (const repo of repos) {
      for (const candidate of pathAsWrittenAndResolved(repo.path)) {
        const id = otelWorkspaceIdForPath(normalizeOtelPath(candidate), 'git-root');
        if (!byOtelId.has(id)) byOtelId.set(id, repo);
      }
    }
    repositoryIndex = { key, byOtelId };
  }
  return repositoryIndex.byOtelId;
}

/**
 * The registered repository a tool event targeted, from otel-hook's
 * `otelhook.target.repository.id` (the git-root hash of its main checkout),
 * so a linked worktree is placed in its repository without reading `.git`.
 * A registered path is hashed as written and resolved: git names a linked
 * worktree's repository by its real path. Null without a repository id (a
 * bare repository, or a linked worktree whose main checkout is gone) or for
 * an unregistered repository.
 */
export async function resolveTargetRepository(attrs: OtelAttrs): Promise<TargetRepository | null> {
  const repositoryId = str([attrs], [TARGET_REPOSITORY_ID_ATTR]);
  if (!repositoryId) return null;
  const repos: RegisteredRepository[] = await prisma.repository.findMany({ select: { id: true, path: true } });
  const repo = repositoriesByOtelId(repos).get(repositoryId);
  if (!repo) return null;
  const kind = str([attrs], [TARGET_WORKTREE_KIND_ATTR]);
  const linked = kind ? kind === 'linked' : str([attrs], [TARGET_WORKSPACE_ID_ATTR]) !== repositoryId;
  return { repositoryId: repo.id, path: repo.path, linked };
}

/**
 * The slot a tool event targeted, from otel-hook's target attributes: the
 * worktree's branch (each occupancy has its own), else the salted hash of the
 * worktree root matched against the repository's slot worktrees. A branch no
 * slot is on — the main checkout's, typically — is not slot evidence.
 */
export async function resolveTargetSlot(
  repositoryId: string,
  attrs: OtelAttrs,
): Promise<SlotEvidence | null> {
  const branch = str([attrs], [TARGET_BRANCH_ATTR]);
  const workspaceId = str([attrs], [TARGET_WORKSPACE_ID_ATTR]);
  if (!branch && !workspaceId) return null;
  const slots: SlotRow[] = await prisma.agentSlot.findMany({ where: { repositoryId }, select: SLOT_SELECT });
  if (branch) {
    const onBranch = slots.filter((slot) => slot.branch === branch).sort((a, b) => Number(b.active) - Number(a.active));
    if (onBranch[0]) return evidenceFromSlot(onBranch[0]);
    const attempt = await prisma.attempt.findFirst({
      where: { repositoryId, branch, agentId: { not: null } },
      orderBy: { startedAt: 'desc' },
      select: { attemptId: true, agentId: true, workDir: true, worktreePath: true, branch: true, workUnitId: true },
    });
    if (attempt && attempt.agentId != null) {
      return {
        slotId: attempt.agentId,
        occupancyKey: occupancyKeyForAttempt(attempt.attemptId),
        branch: attempt.branch,
        workDir: attempt.workDir ?? attempt.worktreePath,
        suffix: null,
        workUnitId: attempt.workUnitId,
        attemptId: attempt.attemptId,
      };
    }
  }
  if (workspaceId) {
    const paths = slots.flatMap((slot) => [slot.workDir, slot.worktreePath]).filter((p): p is string => Boolean(p));
    const hit = pickPathForWorkspaceId(workspaceId, paths, 'git-root');
    if (hit) {
      const slot = slots.find((candidate) =>
        [candidate.workDir, candidate.worktreePath].some((p) => p && normalizeOtelPath(p) === hit),
      );
      if (slot) return evidenceFromSlot(slot);
    }
  }
  return null;
}

/**
 * A git worktree of the repository that is not a slot, which a record is
 * evidence the session worked in: a tool event's target (its salted hash
 * matched against the repository's linked worktrees), else the session's own
 * cwd inside one. Recorded as a binding to `MAIN_CHECKOUT_AGENT_ID` naming the
 * worktree, so its usage is unassigned yet split from the main checkout's.
 *
 * Callers pass only what no slot claimed. A linked target Mission Control
 * cannot find among the repository's worktrees (its git directory is not
 * mounted) is named by its branch alone.
 */
export async function resolveNonSlotWorktree(
  repositoryId: string,
  input: { workspace?: string; attrs?: OtelAttrs },
): Promise<{ kind: 'workspace' | 'observed'; slot: SlotEvidence } | null> {
  const attrs = input.attrs ?? {};
  const workspaceId = str([attrs], [TARGET_WORKSPACE_ID_ATTR]);
  const targetBranch = str([attrs], [TARGET_BRANCH_ATTR]);
  if (!input.workspace && !workspaceId) return null;
  const repo = (await prisma.repository.findMany({ select: { id: true, path: true } })).find(
    (candidate) => candidate.id === repositoryId,
  );
  if (!repo) return null;
  const slots = await prisma.agentSlot.findMany({ where: { repositoryId }, select: SLOT_SELECT });
  const slotPaths = slots
    .flatMap((slot) => [slot.workDir, slot.worktreePath])
    .filter((p): p is string => Boolean(p))
    .map(normalizeOtelPath);
  const listing = (maxAgeMs?: number) => {
    const { readable, worktrees } = listLinkedWorktrees(repo.path, Date.now(), maxAgeMs);
    return { readable, candidates: worktrees.filter((worktree) => !slotPaths.includes(normalizeOtelPath(worktree.path))) };
  };
  let { readable, candidates } = listing();
  const evidence = (kind: 'workspace' | 'observed', workDir: string | null, branch: string | null) => ({
    kind,
    slot: {
      slotId: MAIN_CHECKOUT_AGENT_ID,
      occupancyKey: worktreeOccupancyKey({ workDir, branch }),
      branch,
      workDir,
      suffix: null,
      workUnitId: null,
      attemptId: null,
    },
  });

  if (workspaceId) {
    const listed = () => {
      const hit = pickPathForWorkspaceId(workspaceId, candidates.map((worktree) => worktree.path), 'git-root');
      return hit ? candidates.find((candidate) => normalizeOtelPath(candidate.path) === hit) : undefined;
    };
    const kind = str([attrs], [TARGET_WORKTREE_KIND_ATTR]);
    let worktree = listed();
    if (!worktree && kind === 'linked' && readable) {
      // A linked worktree newer than the listing: re-read it, or this event
      // would name it by branch and later ones by path, two rows for one worktree.
      ({ readable, candidates } = listing(WORKTREE_MISS_REFRESH_MS));
      worktree = listed();
    }
    if (worktree) return evidence(targetBindingKind(attrs), worktree.path, worktree.branch ?? targetBranch ?? null);
    // Not listed here (`.git` not mounted): named by its branch, when
    // otel-hook says the target is a linked worktree of a repository (without
    // a repository id, of none it could name) — or, from an otel-hook that
    // does not say, when its hash is neither the main checkout's nor a slot's
    // and the listing is unreadable.
    const linked = kind
      ? kind === 'linked' && Boolean(str([attrs], [TARGET_REPOSITORY_ID_ATTR]))
      : !readable && !pickPathForWorkspaceId(workspaceId, [repo.path, ...slotPaths], 'git-root');
    if (linked && targetBranch) return evidence(targetBindingKind(attrs), null, targetBranch);
  }
  if (input.workspace) {
    const worktree = candidates.find((candidate) => isWorkspaceUnderPath(input.workspace!, candidate.path));
    if (worktree) return evidence('workspace', worktree.path, worktree.branch);
  }
  return null;
}

/**
 * The slot a session works in at `at`, from its stored binding timeline — the
 * same rule usage attribution applies. Null means the main checkout.
 */
export async function timelineSlotAt(
  repositoryId: string,
  ref: AgentSessionRef,
  at: Date,
  /** Evidence carried by the record being placed, not stored yet. */
  pending: TimelineBinding[] = [],
): Promise<SlotEvidence | null> {
  const stored = await findTimelinePoints({ repositoryId, agentTool: ref.agentTool, sessionId: ref.sessionId, from: { lte: at } });
  if (stored.length === 0 && pending.length === 0) return null;
  const bindings = [
    ...stored,
    ...pending.map((binding) => ({ ...binding, subagentId: binding.subagentId ?? '', occupancyKey: binding.occupancyKey ?? null, branch: binding.branch ?? null })),
  ];
  const slotIds = [...new Set(bindings.map((binding) => binding.slotId))];
  const [releases, slots, attempts] = await Promise.all([
    findTimelinePoints({ repositoryId, kind: 'release', slotId: { in: slotIds }, from: { lte: at } }),
    prisma.agentSlot.findMany({ where: { repositoryId, slotId: { in: slotIds } }, select: { ...SLOT_SELECT, sessionCreatedAt: true } }),
    prisma.attempt.findMany({
      where: { repositoryId, agentId: { in: slotIds }, startedAt: { lte: at } },
      select: { attemptId: true, agentId: true, startedAt: true },
    }),
  ]);
  const toTimeline = (row: (typeof bindings)[number]): TimelineBinding => ({
    agentTool: row.agentTool,
    sessionId: row.sessionId,
    subagentId: row.subagentId || null,
    kind: row.kind as SessionBindingKind,
    slotId: row.slotId,
    occupancyKey: row.occupancyKey,
    branch: row.branch,
    at: row.at,
  });
  const events: OccupancyEvent[] = [
    ...releases.map((row) => ({ slotId: row.slotId, occupancyKey: row.occupancyKey, at: row.at, kind: 'end' as const })),
    ...slots
      .filter((slot) => slot.occupancyKey && slot.sessionCreatedAt)
      .map((slot) => ({ slotId: slot.slotId, occupancyKey: slot.occupancyKey, at: slot.sessionCreatedAt!, kind: 'start' as const })),
    ...attempts.map((attempt) => ({
      slotId: attempt.agentId as number,
      occupancyKey: occupancyKeyForAttempt(attempt.attemptId),
      at: attempt.startedAt,
      kind: 'start' as const,
    })),
  ];
  const binding = new BindingTimeline(bindings.map(toTimeline), events).resolve(ref, at);
  // A non-slot worktree is no slot: the record stays the main checkout's.
  if (!binding || binding.slotId === MAIN_CHECKOUT_AGENT_ID) return null;
  const slot = slots.find(
    (candidate) =>
      candidate.slotId === binding.slotId &&
      (binding.occupancyKey ? candidate.occupancyKey === binding.occupancyKey : candidate.branch === binding.branch),
  );
  return slot
    ? evidenceFromSlot(slot)
    : {
        slotId: binding.slotId,
        occupancyKey: binding.occupancyKey ?? null,
        branch: binding.branch ?? null,
        workDir: null,
        suffix: null,
        workUnitId: null,
        attemptId: null,
      };
}

/** Repository of a provider session's latest binding at or before `at`, in any repository. */
export async function latestBindingRepositoryAt(ref: AgentSessionRef, at: Date): Promise<string | null> {
  const latest = await prisma.sessionSegment.findFirst({
    where: { agentTool: ref.agentTool, sessionId: ref.sessionId, from: { lte: at }, ...TIMELINE_POINT_WHERE },
    orderBy: [{ from: 'desc' }, { createdAt: 'desc' }],
    select: { repositoryId: true },
  });
  return latest?.repositoryId ?? null;
}

/**
 * Repository of a provider session's place at `at` (FE-2058: one request = one
 * place = one repository). A session may work in A, a slot of B, then A again:
 * its latest binding at or before `at` across all repositories, else the
 * repository of its latest hook span then. Null when nothing places it yet.
 */
export async function repositoryOfPlaceAt(ref: AgentSessionRef, at: Date): Promise<string | null> {
  return (await latestBindingRepositoryAt(ref, at)) ?? (await sessionSpanRepository(ref, at));
}

/**
 * Repository of a provider session's hook span: its latest at or before `at`,
 * else its first. A span is keyed by the session id unless a launch's session
 * key (a slot's, or a stale one) named it, so its session attributes match too.
 */
async function sessionSpanRepository(ref: AgentSessionRef, at?: Date): Promise<string | null> {
  const sameSession = Prisma.sql`(sessionKey = ${ref.sessionId}
    OR json_extract(attributes, '$."otelhook.session.id"') = ${ref.sessionId}
    OR json_extract(attributes, '$."session.id"') = ${ref.sessionId})`;
  const rows = await prisma.$queryRaw<{ repositoryId: string }[]>(
    at
      ? Prisma.sql`SELECT repositoryId FROM AgentSessionSpan WHERE ${sameSession} AND startTime <= ${at} ORDER BY startTime DESC LIMIT 1`
      : Prisma.sql`SELECT repositoryId FROM AgentSessionSpan WHERE ${sameSession} ORDER BY startTime ASC LIMIT 1`,
  );
  return rows[0]?.repositoryId ?? null;
}

/**
 * Repository of a provider session whose records carry no workspace (Claude
 * Code native logs and metrics), when no place is known at their time:
 * wherever its bindings (the first), observations or hook spans were already
 * placed.
 */
export async function repositoryForProviderSession(ref: AgentSessionRef): Promise<string | null> {
  const binding = await prisma.sessionSegment.findFirst({
    where: { agentTool: ref.agentTool, sessionId: ref.sessionId, ...TIMELINE_POINT_WHERE },
    orderBy: [{ from: 'asc' }],
    select: { repositoryId: true },
  });
  if (binding?.repositoryId) return binding.repositoryId;
  const observation = await prisma.usageObservation.findFirst({
    where: { agentTool: ref.agentTool, sessionId: ref.sessionId },
    select: { repositoryId: true },
  });
  if (observation) return observation.repositoryId;
  return sessionSpanRepository(ref);
}
