import { estimateModelCostUsd } from './model-pricing';

/**
 * Evidence-timeline usage attribution (ADR 0003) — pure, no database.
 *
 * Given the bindings and usage observations Mission Control holds, assign each
 * observation to the binding in force at its `observedAt`, and fold the result
 * into per-slot and per-session (unassigned = main checkout) usage. Attribution
 * is recomputed on every read, so a binding that arrives late re-attributes
 * usage already received.
 *
 * Mission Control and har-portal run this same code over the same facts, so
 * the two derive the same split. It is free of zod and of the HAR domain
 * schema on purpose: it ships as the `@osfactory/har/attribution` library
 * entry, which a consumer on another zod major can import.
 */

/**
 * `agentId` of a span, event or trajectory record whose session had no slot
 * binding in force when it happened: the main checkout. Never a slot number
 * (slots start at `HAR_AGENT_SLOT_MIN`), so no slot page claims it.
 */
export const MAIN_CHECKOUT_AGENT_ID = 0;

/** How a binding was established; mirrors `SessionBindingKindSchema`. */
export type TimelineBindingKind = 'launch' | 'release' | 'workspace' | 'observed';

export interface TimelineBinding {
  agentTool: string;
  sessionId: string;
  /** Null / empty for the session itself. */
  subagentId?: string | null;
  kind: TimelineBindingKind;
  slotId: number;
  occupancyKey?: string | null;
  branch?: string | null;
  at: Date;
}

/**
 * A slot occupancy boundary known independently of any one session: a slot row
 * or work attempt (start), or another session's teardown of the slot (end).
 */
export interface OccupancyEvent {
  slotId: number;
  occupancyKey?: string | null;
  at: Date;
  kind: 'start' | 'end';
}

export interface ObservationFact {
  agentTool: string;
  sessionId: string;
  subagentId?: string | null;
  observationKey: string;
  observedAt: Date;
  granularity: string;
  source: string;
  /** Producer stream; streams reporting the same usage under other keys are de-duplicated by it. */
  producer: string;
  model?: string | null;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheCreation: number;
  costUsd?: number | null;
}

const KIND_RANK: Record<TimelineBindingKind, number> = {
  launch: 3,
  workspace: 2,
  observed: 1,
  release: 0,
};

function keysConflict(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a) && Boolean(b) && a !== b;
}

/** Latest first; at the same instant the strongest kind wins (a launch beats an observation). */
function byRecency(a: TimelineBinding, b: TimelineBinding): number {
  const dt = b.at.getTime() - a.at.getTime();
  return dt !== 0 ? dt : KIND_RANK[b.kind] - KIND_RANK[a.kind];
}

/**
 * Occupancy boundaries implied by the bindings themselves: any session's
 * `release` ends the slot's occupancy; a `launch` / `workspace` binding with a
 * known occupancy key starts one.
 */
export function occupancyEventsFromBindings(bindings: TimelineBinding[]): OccupancyEvent[] {
  const out: OccupancyEvent[] = [];
  for (const binding of bindings) {
    if (binding.kind === 'release') {
      out.push({ slotId: binding.slotId, occupancyKey: binding.occupancyKey, at: binding.at, kind: 'end' });
    } else if ((binding.kind === 'launch' || binding.kind === 'workspace') && binding.occupancyKey) {
      out.push({ slotId: binding.slotId, occupancyKey: binding.occupancyKey, at: binding.at, kind: 'start' });
    }
  }
  return out;
}

/**
 * A binding never outlives its slot occupancy: it is closed by an end of that
 * occupancy (a release, from this session or another) at or before `t` — even
 * one before the binding, when both name the same occupancy — or by the start
 * of a different known occupancy of the same slot after the binding.
 */
function closedAt(binding: TimelineBinding, t: number, events: OccupancyEvent[]): boolean {
  const from = binding.at.getTime();
  return events.some((event) => {
    if (event.slotId !== binding.slotId) return false;
    const at = event.at.getTime();
    if (at > t) return false;
    if (event.kind === 'end') {
      if (keysConflict(event.occupancyKey, binding.occupancyKey)) return false;
      const sameOccupancy = Boolean(event.occupancyKey) && event.occupancyKey === binding.occupancyKey;
      return sameOccupancy || at > from;
    }
    return at > from && keysConflict(event.occupancyKey, binding.occupancyKey);
  });
}

/**
 * Binding in force for exactly one context (session or one subagent), ignoring
 * the parent. `bindings` are latest first.
 *
 * Releases are occupancy ends: they close a binding to the released slot only,
 * so tearing down another slot while working in this one does not move the
 * session to main. `workspace` evidence (the session's own cwd) repeats on
 * every event, so it counts from its first sighting per occupancy: a stronger
 * binding made after that (a launch, a tool event in another worktree) is
 * never overridden by the cwd evidence that keeps arriving.
 */
function inForceForContext(
  bindings: TimelineBinding[],
  t: number,
  events: OccupancyEvent[],
): TimelineBinding | null {
  const upTo = bindings.filter((binding) => binding.kind !== 'release' && binding.at.getTime() <= t);
  const strong = upTo.find((binding) => binding.kind !== 'workspace') ?? null;
  const firstSeen = new Map<string, TimelineBinding>();
  for (const binding of upTo) {
    if (binding.kind !== 'workspace') continue;
    // Latest first, so the last write per occupancy is its first sighting.
    firstSeen.set(`${binding.slotId}\0${binding.occupancyKey ?? ''}`, binding);
  }
  const workspace = [...firstSeen.values()].sort(byRecency)[0] ?? null;
  const candidate =
    !workspace ? strong : !strong ? workspace : workspace.at.getTime() > strong.at.getTime() ? workspace : strong;
  if (!candidate) return null;
  return closedAt(candidate, t, events) ? null : candidate;
}

export interface AgentContextRef {
  agentTool: string;
  sessionId: string;
  subagentId?: string | null;
}

/**
 * Index of a repository's bindings for timeline lookups. Build once per read,
 * then resolve many observations against it.
 */
export class BindingTimeline {
  private readonly byContext = new Map<string, TimelineBinding[]>();
  private readonly events: OccupancyEvent[];

  constructor(bindings: TimelineBinding[], occupancyEvents: OccupancyEvent[] = []) {
    for (const binding of bindings) {
      const key = contextKey(binding);
      const list = this.byContext.get(key) ?? [];
      list.push(binding);
      this.byContext.set(key, list);
    }
    for (const list of this.byContext.values()) list.sort(byRecency);
    this.events = [...occupancyEventsFromBindings(bindings), ...occupancyEvents];
  }

  /**
   * The binding in force at `at`: the latest one at or before it for the
   * subagent, else for its parent session. Null means unassigned (main checkout).
   */
  resolve(ref: AgentContextRef, at: Date): TimelineBinding | null {
    const t = at.getTime();
    if (ref.subagentId) {
      const own = inForceForContext(this.byContext.get(contextKey(ref)) ?? [], t, this.events);
      if (own) return own;
    }
    const parent = { agentTool: ref.agentTool, sessionId: ref.sessionId, subagentId: null };
    return inForceForContext(this.byContext.get(contextKey(parent)) ?? [], t, this.events);
  }
}

function contextKey(ref: AgentContextRef): string {
  return `${ref.agentTool}\0${ref.sessionId}\0${ref.subagentId || ''}`;
}

function sessionKeyOf(ref: { agentTool: string; sessionId: string }): string {
  return `${ref.agentTool}\0${ref.sessionId}`;
}

export interface TokenTotals {
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheCreation: number;
}

const TOKEN_FIELDS = ['tokensInput', 'tokensOutput', 'tokensCacheRead', 'tokensCacheCreation'] as const;

/**
 * Usage of one unit from a running total (Codex reports the session's total
 * on every turn): the difference from the previous unit's total. A counter
 * that goes down means the series restarted, and the total is then the unit's
 * own usage — never a negative one.
 */
export function runningTotalDelta(previous: TokenTotals | null, current: TokenTotals): TokenTotals {
  if (!previous || TOKEN_FIELDS.some((field) => current[field] < previous[field])) return { ...current };
  return {
    tokensInput: current.tokensInput - previous.tokensInput,
    tokensOutput: current.tokensOutput - previous.tokensOutput,
    tokensCacheRead: current.tokensCacheRead - previous.tokensCacheRead,
    tokensCacheCreation: current.tokensCacheCreation - previous.tokensCacheCreation,
  };
}

/**
 * Producer priority when several streams report the same session's usage
 * under different keys (lower first): per-request native events, then
 * otel-hook generations/turns, then harvest.
 */
const PRODUCER_PRIORITY: Array<(producer: string) => boolean> = [
  (p) => p === 'claude.api_request' || p === 'codex.sse_event',
  (p) => p.startsWith('otelhook.'),
  (p) => p.startsWith('sync.'),
];

function producerRank(producer: string): number {
  const index = PRODUCER_PRIORITY.findIndex((match) => match(producer));
  return index === -1 ? PRODUCER_PRIORITY.length : index;
}

/**
 * Streams that key the same unit the same way form one family: their copies of
 * a unit are already one stored row (idempotency), so they never compete.
 * Claude's live `api_request` and its transcript harvest both key by the API
 * request id; Codex hook turns (`otelhook.generation.id`) and the rollout
 * harvest both key by `turn_id`.
 */
export function producerFamily(agentTool: string, producer: string): string {
  if (agentTool === 'claude_code' && (producer === 'claude.api_request' || producer.startsWith('sync.'))) {
    return 'claude.request-id';
  }
  if (agentTool === 'codex' && (producer === 'otelhook.generation' || producer.startsWith('sync.'))) {
    return 'codex.turn-id';
  }
  return producer;
}

/** Subtract `parts` from `total`, field by field, never below zero. */
export function subtractTotals(total: TokenTotals, parts: TokenTotals[]): TokenTotals {
  const out = { ...total };
  for (const part of parts) {
    for (const field of TOKEN_FIELDS) out[field] = Math.max(0, out[field] - part[field]);
  }
  return out;
}

/**
 * One stream per instant: within a session, the highest-priority family is
 * authoritative over the time window it covers, and lower-priority families
 * only fill the time outside every higher one's window. Codex harvest (keyed
 * by turn id) and otel-hook turns (keyed by span) are such competing families.
 */
export function dedupeProducers(observations: ObservationFact[]): ObservationFact[] {
  const bySession = new Map<string, Map<string, ObservationFact[]>>();
  for (const observation of observations) {
    const session = sessionKeyOf(observation);
    const families = bySession.get(session) ?? new Map<string, ObservationFact[]>();
    const family = producerFamily(observation.agentTool, observation.producer);
    const list = families.get(family) ?? [];
    list.push(observation);
    families.set(family, list);
    bySession.set(session, families);
  }
  const out: ObservationFact[] = [];
  for (const families of bySession.values()) {
    if (families.size === 1) {
      out.push(...[...families.values()][0]);
      continue;
    }
    const rank = (list: ObservationFact[]) => Math.min(...list.map((o) => producerRank(o.producer)));
    const ordered = [...families.entries()].sort(
      ([a, left], [b, right]) => rank(left) - rank(right) || a.localeCompare(b),
    );
    const windows: Array<[number, number]> = [];
    for (const [, list] of ordered) {
      const times = list.map((o) => o.observedAt.getTime());
      for (const observation of list) {
        const t = observation.observedAt.getTime();
        if (!windows.some(([from, to]) => t >= from && t <= to)) out.push(observation);
      }
      windows.push([Math.min(...times), Math.max(...times)]);
    }
  }
  return out;
}

export interface PricedObservation extends ObservationFact {
  /** Provider cost when reported, else the genai-prices estimate, else null. */
  pricedCostUsd: number | null;
  costSource: 'reported' | 'estimated' | null;
}

export function priceObservation(observation: ObservationFact): PricedObservation {
  if (observation.costUsd != null && Number.isFinite(observation.costUsd)) {
    return { ...observation, pricedCostUsd: observation.costUsd, costSource: 'reported' };
  }
  const estimate = observation.model
    ? estimateModelCostUsd(
        observation.model,
        {
          tokensInput: observation.tokensInput,
          tokensOutput: observation.tokensOutput,
          tokensCacheRead: observation.tokensCacheRead,
          tokensCacheCreation: observation.tokensCacheCreation,
        },
        observation.agentTool,
      )
    : null;
  return {
    ...observation,
    pricedCostUsd: estimate,
    costSource: estimate == null ? null : 'estimated',
  };
}

export interface ModelTotals {
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheCreation: number;
  tokensTotal: number;
  costUsd?: number;
}

export interface UsageBucket {
  agentTool: string;
  sessionId: string;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheCreation: number;
  tokensTotal: number;
  costUsd: number | null;
  costSource: 'reported' | 'estimated' | 'mixed' | null;
  modelBreakdown: Record<string, ModelTotals>;
  sources: string[];
  observationCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface SlotUsageBucket extends UsageBucket {
  slotId: number;
  occupancyKey: string | null;
  branch: string | null;
}

function emptyBucket(observation: ObservationFact): UsageBucket {
  return {
    agentTool: observation.agentTool,
    sessionId: observation.sessionId,
    tokensInput: 0,
    tokensOutput: 0,
    tokensCacheRead: 0,
    tokensCacheCreation: 0,
    tokensTotal: 0,
    costUsd: null,
    costSource: null,
    modelBreakdown: {},
    sources: [],
    observationCount: 0,
    firstSeenAt: observation.observedAt,
    lastSeenAt: observation.observedAt,
  };
}

function addToBucket(bucket: UsageBucket, observation: PricedObservation): void {
  const total =
    observation.tokensInput +
    observation.tokensOutput +
    observation.tokensCacheRead +
    observation.tokensCacheCreation;
  bucket.tokensInput += observation.tokensInput;
  bucket.tokensOutput += observation.tokensOutput;
  bucket.tokensCacheRead += observation.tokensCacheRead;
  bucket.tokensCacheCreation += observation.tokensCacheCreation;
  bucket.tokensTotal += total;
  bucket.observationCount += 1;
  if (observation.pricedCostUsd != null) {
    bucket.costUsd = (bucket.costUsd ?? 0) + observation.pricedCostUsd;
    bucket.costSource =
      bucket.costSource == null || bucket.costSource === observation.costSource
        ? observation.costSource
        : 'mixed';
  }
  if (!bucket.sources.includes(observation.source)) bucket.sources.push(observation.source);
  if (observation.observedAt < bucket.firstSeenAt) bucket.firstSeenAt = observation.observedAt;
  if (observation.observedAt > bucket.lastSeenAt) bucket.lastSeenAt = observation.observedAt;
  if (observation.model) {
    const model = (bucket.modelBreakdown[observation.model] ??= {
      tokensInput: 0,
      tokensOutput: 0,
      tokensCacheRead: 0,
      tokensCacheCreation: 0,
      tokensTotal: 0,
    });
    model.tokensInput += observation.tokensInput;
    model.tokensOutput += observation.tokensOutput;
    model.tokensCacheRead += observation.tokensCacheRead;
    model.tokensCacheCreation += observation.tokensCacheCreation;
    model.tokensTotal += total;
    if (observation.pricedCostUsd != null) {
      model.costUsd = (model.costUsd ?? 0) + observation.pricedCostUsd;
    }
  }
}

export interface AttributedObservation {
  observation: PricedObservation;
  binding: TimelineBinding | null;
}

/** Normalize (one producer per instant), price, and assign each observation. */
export function attributeObservations(
  timeline: BindingTimeline,
  observations: ObservationFact[],
): AttributedObservation[] {
  return dedupeProducers(observations).map((observation) => ({
    observation: priceObservation(observation),
    binding: timeline.resolve(observation, observation.observedAt),
  }));
}

export interface UsageProjection {
  /** One bucket per (agentTool, session, slot, occupancy). */
  slots: SlotUsageBucket[];
  /** One bucket per session: usage with no binding in force — the main checkout. */
  unassigned: UsageBucket[];
}

export function projectUsage(
  bindings: TimelineBinding[],
  observations: ObservationFact[],
  occupancyEvents: OccupancyEvent[] = [],
): UsageProjection {
  const timeline = new BindingTimeline(bindings, occupancyEvents);
  const slots = new Map<string, SlotUsageBucket>();
  const unassigned = new Map<string, UsageBucket>();
  for (const { observation, binding } of attributeObservations(timeline, observations)) {
    if (!binding) {
      const key = sessionKeyOf(observation);
      const bucket = unassigned.get(key) ?? emptyBucket(observation);
      addToBucket(bucket, observation);
      unassigned.set(key, bucket);
      continue;
    }
    const key = `${sessionKeyOf(observation)}\0${binding.slotId}\0${binding.occupancyKey ?? ''}`;
    let bucket = slots.get(key);
    if (!bucket) {
      bucket = {
        ...emptyBucket(observation),
        slotId: binding.slotId,
        occupancyKey: binding.occupancyKey ?? null,
        branch: binding.branch ?? null,
      };
      slots.set(key, bucket);
    }
    if (!bucket.branch && binding.branch) bucket.branch = binding.branch;
    addToBucket(bucket, observation);
  }
  return { slots: [...slots.values()], unassigned: [...unassigned.values()] };
}

/** Observation coverage of one agent tool: its sessions and the time each spans. */
export interface ObservationCoverage {
  sessions: Set<string>;
  windows: Array<[number, number]>;
}

export function observationCoverage(observations: ObservationFact[]): Map<string, ObservationCoverage> {
  const spans = new Map<string, { agentTool: string; sessionId: string; from: number; to: number }>();
  for (const observation of observations) {
    const key = sessionKeyOf(observation);
    const t = observation.observedAt.getTime();
    const span = spans.get(key);
    if (!span) spans.set(key, { agentTool: observation.agentTool, sessionId: observation.sessionId, from: t, to: t });
    else {
      span.from = Math.min(span.from, t);
      span.to = Math.max(span.to, t);
    }
  }
  const out = new Map<string, ObservationCoverage>();
  for (const span of spans.values()) {
    const coverage = out.get(span.agentTool) ?? { sessions: new Set<string>(), windows: [] };
    coverage.sessions.add(span.sessionId);
    coverage.windows.push([span.from, span.to]);
    out.set(span.agentTool, coverage);
  }
  return out;
}

/**
 * Legacy session totals (`AgentSessionUsage`, one max-merged row per session)
 * coexist with observations: a row stays as it is unless observations of the
 * same agent tool cover it — same session id, or any overlap in time (legacy
 * rows are often keyed by slot branch, not by provider session, so time is the
 * only join). A covered row is superseded by the derived projection; counting
 * both would double the usage.
 */
export function legacyRowSuperseded(
  row: { agentTool: string; sessionKey: string; firstSeenAt: Date; lastSeenAt: Date },
  coverage: Map<string, ObservationCoverage>,
): boolean {
  const tool = coverage.get(row.agentTool);
  if (!tool) return false;
  if (tool.sessions.has(row.sessionKey)) return true;
  const from = row.firstSeenAt.getTime();
  const to = row.lastSeenAt.getTime();
  return tool.windows.some(([start, end]) => from <= end && to >= start);
}

/**
 * How a repeat of a stored observation (same agentTool, sessionId,
 * observationKey) merges into it. A key names one unit of usage, so a repeat
 * is the same fact, possibly from another producer — e.g. Claude's live
 * `api_request` and its transcript harvest share the API request id.
 *
 * - The live report (`otel`) is authoritative over a harvested copy: it
 *   replaces a stored harvest copy, and a harvest never replaces it.
 * - A provider-reported cost is never erased: a repeat without a cost keeps
 *   the stored one, and a stored fact without a cost takes the repeat's.
 * - The same producer may correct its own fact (a re-harvest).
 *
 * Returns the fields to write, or null when the stored fact stays as it is.
 */
export function mergeRepeatedObservation(
  existing: { producer: string; source: string; costUsd: number | null },
  incoming: { producer: string; source: string; costUsd: number | null },
): { replace: boolean; costUsd: number | null } | null {
  const costUsd = incoming.costUsd ?? existing.costUsd;
  const replace =
    existing.producer === incoming.producer ||
    (incoming.source === 'otel' && existing.source !== 'otel');
  if (replace) return { replace: true, costUsd };
  if (existing.costUsd == null && incoming.costUsd != null) return { replace: false, costUsd };
  return null;
}
