import { Prisma } from '@prisma/client';
import type { AgentSessionUsage as AgentSessionUsageRow } from '@prisma/client';
import {
  SyncSessionBindingsInputSchema,
  SyncUsageObservationsInputSchema,
  USAGE_HARVEST_VERSION,
  type SessionBindingKind,
  type SessionSlotBinding,
  type UsageObservation,
  legacyRowSuperseded,
  UNPRICED_AGENT_TOOLS,
  mergeRepeatedObservation,
  producerFamily,
  runningTotalDelta,
  subtractTotals,
  type TokenTotals,
  observationCoverage,
  occupancyEventsFromContext,
  projectUsage,
  type ObservationFact,
  type OccupancyEvent,
  type SlotUsageBucket,
  type TimelineBinding,
  type UsageBucket,
} from '@har/schemas';
import { prisma } from '@/lib/db';
import { attemptIdFromOccupancyKey } from '@/server/occupancy';
import { repositoryOfPlaceAt } from '@/server/otel-attribution';

/**
 * Storage and read model of session → slot attribution (ADR 0003).
 *
 * Bindings and usage observations are stored as facts. Slot usage is never
 * written: every read derives it from the facts through the pure core in
 * `@har/schemas` (`usage-attribution`, shared with har-portal), so late evidence corrects earlier attribution.
 */

// ---------------------------------------------------------------------------
// Bindings

export type BindingOrigin = 'sync' | 'otel';

export interface BindingInput {
  agentTool: string;
  sessionId: string;
  subagentId?: string | null;
  kind: SessionBindingKind;
  slotId: number;
  occupancyKey?: string | null;
  branch?: string | null;
  at: Date;
}

/**
 * A binding that names a slot's branch but no occupancy belongs to the slot's
 * current occupancy when that occupancy is on the same branch — the branch
 * carries a per-occupancy suffix, so this is evidence, not a guess.
 */
async function withOccupancy(repositoryId: string, binding: BindingInput): Promise<BindingInput> {
  if (binding.occupancyKey || !binding.branch) return binding;
  const slot = await prisma.agentSlot.findUnique({
    where: { repositoryId_slotId: { repositoryId, slotId: binding.slotId } },
    select: { branch: true, occupancyKey: true },
  });
  return slot?.occupancyKey && slot.branch === binding.branch
    ? { ...binding, occupancyKey: slot.occupancyKey }
    : binding;
}

/** Idempotent per (agentTool, sessionId, subagentId, kind, slotId, at). Returns how many were new. */
export async function recordBindings(
  repositoryId: string,
  bindings: BindingInput[],
  origin: BindingOrigin,
): Promise<{ synced: number; created: number }> {
  let created = 0;
  for (const raw of bindings) {
    const binding = await withOccupancy(repositoryId, raw);
    const subagentId = binding.subagentId ?? '';
    const where = {
      repositoryId_agentTool_sessionId_subagentId_kind_slotId_at: {
        repositoryId,
        agentTool: binding.agentTool,
        sessionId: binding.sessionId,
        subagentId,
        kind: binding.kind,
        slotId: binding.slotId,
        at: binding.at,
      },
    };
    const existing = await prisma.sessionSlotBinding.findUnique({ where, select: { id: true, occupancyKey: true, branch: true } });
    if (existing) {
      // A repeat may only add what the first copy lacked.
      if ((!existing.occupancyKey && binding.occupancyKey) || (!existing.branch && binding.branch)) {
        await prisma.sessionSlotBinding.update({
          where: { id: existing.id },
          data: {
            occupancyKey: existing.occupancyKey ?? binding.occupancyKey ?? null,
            branch: existing.branch ?? binding.branch ?? null,
          },
        });
      }
      continue;
    }
    try {
      await prisma.sessionSlotBinding.create({
        data: {
          repositoryId,
          agentTool: binding.agentTool,
          sessionId: binding.sessionId,
          subagentId,
          kind: binding.kind,
          slotId: binding.slotId,
          occupancyKey: binding.occupancyKey ?? null,
          branch: binding.branch ?? null,
          at: binding.at,
          origin,
        },
      });
      created += 1;
    } catch (error) {
      // A concurrent delivery of the same binding won the insert.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
    }
  }
  return { synced: bindings.length, created };
}

export function bindingInputFromContract(binding: SessionSlotBinding): BindingInput {
  return {
    agentTool: binding.agentTool,
    sessionId: binding.sessionId,
    subagentId: binding.subagentId ?? null,
    kind: binding.kind,
    slotId: binding.slotId,
    occupancyKey: binding.occupancyKey ?? null,
    branch: binding.branch ?? null,
    at: new Date(binding.at),
  };
}

export async function syncSessionBindings(repositoryId: string, input: unknown) {
  const { bindings } = SyncSessionBindingsInputSchema.parse(input);
  return recordBindings(repositoryId, bindings.map(bindingInputFromContract), 'sync');
}

export interface SessionBindingFilter {
  agentTool?: string;
  sessionId?: string;
}

export async function listSessionBindings(repositoryId: string, filter: SessionBindingFilter = {}) {
  const rows = await prisma.sessionSlotBinding.findMany({
    where: { repositoryId, ...filter },
    orderBy: [{ at: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map(bindingView);
}

function bindingView(row: {
  agentTool: string;
  sessionId: string;
  subagentId: string;
  kind: string;
  slotId: number;
  occupancyKey: string | null;
  branch: string | null;
  at: Date;
  origin: string;
}) {
  return {
    agentTool: row.agentTool,
    sessionId: row.sessionId,
    ...(row.subagentId ? { subagentId: row.subagentId } : {}),
    kind: row.kind as SessionBindingKind,
    slotId: row.slotId,
    ...(row.occupancyKey ? { occupancyKey: row.occupancyKey } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    at: row.at.toISOString(),
    origin: row.origin,
  };
}

// ---------------------------------------------------------------------------
// Observations

export interface ObservationInput {
  agentTool: string;
  sessionId: string;
  subagentId?: string | null;
  observationKey: string;
  observedAt: Date;
  granularity: string;
  source: 'otel' | 'harvest';
  producer: string;
  model?: string | null;
  tokensInput?: number;
  tokensOutput?: number;
  tokensCacheRead?: number;
  tokensCacheCreation?: number;
  costUsd?: number | null;
  /**
   * The session running total the provider reported at this unit (Codex hooks).
   * The unit's own usage is then its difference from the previous unit of the
   * same producer and session, computed when stored; token fields are ignored.
   */
  runningTotal?: TokenTotals;
}

function toBigInt(value: number | undefined): bigint {
  return BigInt(Math.max(0, Math.floor(Number(value ?? 0) || 0)));
}

export { mergeRepeatedObservation };

const STORED_OBSERVATION = { id: true, producer: true, source: true, costUsd: true } as const;

/**
 * One request = one place = one repository (FE-2058): a request another
 * repository holds — stored before its place there was known — moves here,
 * and the session's remaining rows there are touched so its next sync
 * replaces them. A running total stays in its series.
 */
async function moveFromAnotherRepository(repositoryId: string, observation: ObservationInput) {
  const session = { agentTool: observation.agentTool, sessionId: observation.sessionId };
  const elsewhere = await prisma.usageObservation.findFirst({
    where: { ...session, observationKey: observation.observationKey, reportsTotal: false, repositoryId: { not: repositoryId } },
    select: { ...STORED_OBSERVATION, repositoryId: true },
  });
  if (!elsewhere) return null;
  const { repositoryId: from, ...stored } = elsewhere;
  await prisma.usageObservation.update({ where: { id: stored.id }, data: { repositoryId } });
  await prisma.usageObservation.updateMany({ where: { ...session, repositoryId: from }, data: { updatedAt: new Date() } });
  return stored;
}

/**
 * Idempotent per (agentTool, sessionId, observationKey) across repositories;
 * repeats merge by `mergeRepeatedObservation`.
 */
export async function recordObservations(
  repositoryId: string,
  observations: ObservationInput[],
): Promise<{ synced: number; created: number }> {
  let created = 0;
  for (const observation of observations) {
    const incomingCost =
      observation.costUsd == null || !Number.isFinite(observation.costUsd) ? null : observation.costUsd;
    const data = {
      subagentId: observation.subagentId ?? '',
      observedAt: observation.observedAt,
      granularity: observation.granularity,
      source: observation.source,
      producer: observation.producer,
      model: observation.model ?? null,
      tokensInput: toBigInt(observation.tokensInput),
      tokensOutput: toBigInt(observation.tokensOutput),
      tokensCacheRead: toBigInt(observation.tokensCacheRead),
      tokensCacheCreation: toBigInt(observation.tokensCacheCreation),
      costUsd: incomingCost == null ? null : new Prisma.Decimal(incomingCost),
      reportedTotals: observation.runningTotal
        ? (observation.runningTotal as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      reportsTotal: Boolean(observation.runningTotal),
    };
    const where = {
      repositoryId_agentTool_sessionId_observationKey: {
        repositoryId,
        agentTool: observation.agentTool,
        sessionId: observation.sessionId,
        observationKey: observation.observationKey,
      },
    };
    if (observation.runningTotal) {
      Object.assign(data, tokenColumns(await runningTotalUnit(repositoryId, observation, observation.runningTotal)));
    }
    const existing =
      (await prisma.usageObservation.findUnique({ where, select: STORED_OBSERVATION })) ??
      (observation.runningTotal ? null : await moveFromAnotherRepository(repositoryId, observation));
    if (existing) {
      const merge = mergeRepeatedObservation(
        { ...existing, costUsd: existing.costUsd == null ? null : Number(existing.costUsd) },
        { producer: observation.producer, source: observation.source, costUsd: incomingCost },
      );
      if (merge) {
        const costUsd = merge.costUsd == null ? null : new Prisma.Decimal(merge.costUsd);
        await prisma.usageObservation.update({
          where: { id: existing.id },
          data: merge.replace ? { ...data, costUsd } : { costUsd },
        });
      }
      continue;
    }
    try {
      await prisma.usageObservation.create({
        data: {
          repositoryId,
          agentTool: observation.agentTool,
          sessionId: observation.sessionId,
          observationKey: observation.observationKey,
          ...data,
        },
      });
      created += 1;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
    }
    await refreshNextRunningTotalUnit(repositoryId, observation);
  }
  return { synced: observations.length, created };
}

function tokenColumns(totals: TokenTotals) {
  return {
    tokensInput: toBigInt(totals.tokensInput),
    tokensOutput: toBigInt(totals.tokensOutput),
    tokensCacheRead: toBigInt(totals.tokensCacheRead),
    tokensCacheCreation: toBigInt(totals.tokensCacheCreation),
  };
}

function asTokenTotals(value: Prisma.JsonValue | null): TokenTotals | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const n = (key: string) => (typeof record[key] === 'number' ? (record[key] as number) : 0);
  return {
    tokensInput: n('tokensInput'),
    tokensOutput: n('tokensOutput'),
    tokensCacheRead: n('tokensCacheRead'),
    tokensCacheCreation: n('tokensCacheCreation'),
  };
}

interface SeriesUnit {
  agentTool: string;
  sessionId: string;
  producer: string;
  observationKey: string;
  observedAt: Date;
}

/**
 * This unit's own usage from its running total: the difference from the
 * previous unit that reported a total, less the units of the same keyspace
 * stored in between without one (turns only the harvest saw). The first
 * reported total of a session is thus not double-counted against harvested
 * turns before it.
 */
async function runningTotalUnit(repositoryId: string, unit: SeriesUnit, total: TokenTotals): Promise<TokenTotals> {
  const sameSession = { repositoryId, agentTool: unit.agentTool, sessionId: unit.sessionId };
  const previous = await prisma.usageObservation.findFirst({
    where: {
      ...sameSession,
      producer: unit.producer,
      reportsTotal: true,
      observationKey: { not: unit.observationKey },
      observedAt: { lte: unit.observedAt },
    },
    orderBy: [{ observedAt: 'desc' }, { observationKey: 'desc' }],
    select: { reportedTotals: true, observedAt: true },
  });
  const family = producerFamily(unit.agentTool, unit.producer);
  const between = (
    await prisma.usageObservation.findMany({
      where: {
        ...sameSession,
        reportsTotal: false,
        observationKey: { not: unit.observationKey },
        observedAt: { lt: unit.observedAt, ...(previous ? { gt: previous.observedAt } : {}) },
      },
      select: { producer: true, tokensInput: true, tokensOutput: true, tokensCacheRead: true, tokensCacheCreation: true },
    })
  )
    .filter((row) => producerFamily(unit.agentTool, row.producer) === family)
    .map((row) => ({
      tokensInput: Number(row.tokensInput),
      tokensOutput: Number(row.tokensOutput),
      tokensCacheRead: Number(row.tokensCacheRead),
      tokensCacheCreation: Number(row.tokensCacheCreation),
    }));
  return subtractTotals(runningTotalDelta(previous ? asTokenTotals(previous.reportedTotals) : null, total), between);
}

/**
 * A unit stored before a later unit that reported a running total changes what
 * that later unit's own usage is: recompute it, so out-of-order delivery and
 * late harvests never count the same tokens twice.
 */
async function refreshNextRunningTotalUnit(repositoryId: string, unit: SeriesUnit): Promise<void> {
  const family = producerFamily(unit.agentTool, unit.producer);
  const candidates = await prisma.usageObservation.findMany({
    where: {
      repositoryId,
      agentTool: unit.agentTool,
      sessionId: unit.sessionId,
      reportsTotal: true,
      observedAt: { gt: unit.observedAt },
    },
    orderBy: [{ observedAt: 'asc' }, { observationKey: 'asc' }],
    take: 20,
    select: { id: true, producer: true, observationKey: true, observedAt: true, reportedTotals: true },
  });
  const next = candidates.find((row) => producerFamily(unit.agentTool, row.producer) === family);
  const nextTotal = next ? asTokenTotals(next.reportedTotals) : null;
  if (!next || !nextTotal) return;
  const own = await runningTotalUnit(
    repositoryId,
    { agentTool: unit.agentTool, sessionId: unit.sessionId, producer: next.producer, observationKey: next.observationKey, observedAt: next.observedAt },
    nextTotal,
  );
  await prisma.usageObservation.update({ where: { id: next.id }, data: tokenColumns(own) });
}

export function observationInputFromContract(observation: UsageObservation): ObservationInput {
  return {
    agentTool: observation.agentTool,
    sessionId: observation.sessionId,
    subagentId: observation.subagentId ?? null,
    observationKey: observation.observationKey,
    observedAt: new Date(observation.observedAt),
    granularity: observation.granularity,
    source: observation.source,
    // Posted observations are their own stream. Where they share keys with a
    // live stream (Claude request ids) they merge per key; otherwise the two
    // de-duplicate by time window (see `dedupeProducers`).
    producer: `sync.${observation.source}`,
    model: observation.model ?? null,
    tokensInput: observation.tokensInput,
    tokensOutput: observation.tokensOutput,
    tokensCacheRead: observation.tokensCacheRead,
    tokensCacheCreation: observation.tokensCacheCreation,
    costUsd: observation.costUsd ?? null,
  };
}

/**
 * Observations the CLI harvested for a repository. Each request is stored in
 * the repository of its session's place at its time (FE-2058) — a session may
 * span repositories, and each one harvesting it posts all of its requests —
 * and in this one only when no place is known then.
 */
export async function syncUsageObservations(repositoryId: string, input: unknown) {
  const { observations } = SyncUsageObservationsInputSchema.parse(input);
  let created = 0;
  for (const contract of observations) {
    const observation = observationInputFromContract(contract);
    const placed = await repositoryOfPlaceAt(contract, observation.observedAt);
    created += (await recordObservations(placed ?? repositoryId, [observation])).created;
  }
  return { synced: observations.length, created };
}

export interface UsageObservationFilter {
  agentTool?: string;
  sessionId?: string;
  since?: Date;
}

export async function listUsageObservations(
  repositoryId: string,
  filter: UsageObservationFilter = {},
  limit = 1000,
) {
  const rows = await prisma.usageObservation.findMany({
    where: {
      repositoryId,
      ...(filter.agentTool ? { agentTool: filter.agentTool } : {}),
      ...(filter.sessionId ? { sessionId: filter.sessionId } : {}),
      ...(filter.since ? { observedAt: { gte: filter.since } } : {}),
    },
    orderBy: [{ observedAt: 'asc' }, { id: 'asc' }],
    take: limit,
  });
  return rows.map(observationView);
}

function observationView(row: {
  agentTool: string;
  sessionId: string;
  subagentId: string;
  observationKey: string;
  observedAt: Date;
  granularity: string;
  source: string;
  producer: string;
  model: string | null;
  tokensInput: bigint;
  tokensOutput: bigint;
  tokensCacheRead: bigint;
  tokensCacheCreation: bigint;
  costUsd: Prisma.Decimal | null;
  reportedTotals: Prisma.JsonValue | null;
}) {
  return {
    agentTool: row.agentTool,
    sessionId: row.sessionId,
    ...(row.subagentId ? { subagentId: row.subagentId } : {}),
    observationKey: row.observationKey,
    observedAt: row.observedAt.toISOString(),
    granularity: row.granularity,
    source: row.source,
    producer: row.producer,
    ...(row.model ? { model: row.model } : {}),
    tokensInput: Number(row.tokensInput),
    tokensOutput: Number(row.tokensOutput),
    tokensCacheRead: Number(row.tokensCacheRead),
    tokensCacheCreation: Number(row.tokensCacheCreation),
    ...(row.costUsd != null ? { costUsd: Number(row.costUsd) } : {}),
    ...(row.reportedTotals ? { reportedTotals: row.reportedTotals } : {}),
  };
}

// ---------------------------------------------------------------------------
// Provider-reported session totals (cross-check only)

export interface ReportedUsageInput {
  agentTool: string;
  sessionId: string;
  costUsd: number | null;
  tokensTotal: number;
  at: Date;
  /** `cumulative` points are running totals (max-merge); `delta` points add up. */
  temporality: 'cumulative' | 'delta';
}

export async function recordReportedUsage(repositoryId: string, input: ReportedUsageInput) {
  const where = {
    repositoryId_agentTool_sessionId: {
      repositoryId,
      agentTool: input.agentTool,
      sessionId: input.sessionId,
    },
  };
  const existing = await prisma.sessionReportedUsage.findUnique({ where });
  const previousCost = existing?.costUsd == null ? null : Number(existing.costUsd);
  const previousTokens = Number(existing?.tokensTotal ?? 0);
  const combine = (a: number | null, b: number | null): number | null => {
    if (a == null) return b;
    if (b == null) return a;
    return input.temporality === 'delta' ? a + b : Math.max(a, b);
  };
  const costUsd = combine(previousCost, input.costUsd);
  const tokensTotal = combine(previousTokens, input.tokensTotal) ?? 0;
  const data = {
    costUsd: costUsd == null ? null : new Prisma.Decimal(costUsd),
    tokensTotal: toBigInt(tokensTotal),
    firstSeenAt: existing && existing.firstSeenAt < input.at ? existing.firstSeenAt : input.at,
    lastSeenAt: existing && existing.lastSeenAt > input.at ? existing.lastSeenAt : input.at,
  };
  return prisma.sessionReportedUsage.upsert({
    where,
    create: { repositoryId, agentTool: input.agentTool, sessionId: input.sessionId, ...data },
    update: data,
  });
}

// ---------------------------------------------------------------------------
// Read model: the projection, merged with legacy session totals

/** Same shape as a stored `AgentSessionUsage` row, so every usage reader takes either. */
export type UsageRowView = Omit<AgentSessionUsageRow, 'sources'> & {
  sources: string[];
  /** `observations`: derived from the timeline; `legacy`: a stored session total. */
  origin: 'observations' | 'legacy';
  /**
   * Last time anything this row is derived from was stored: the latest
   * observation write or binding of its session (a late harvest or launch
   * record changes a session's split without a newer `lastSeenAt`). A mirror
   * re-reads every row of a session whose `changedAt` passed its watermark.
   */
  changedAt: Date;
};

export interface UnassignedUsageView {
  repositoryId: string;
  agentTool: string;
  sessionId: string;
  /** The non-slot git worktree this usage happened in; null for the main checkout or when only its branch is known. */
  workDir: string | null;
  /** That worktree's branch; null for the main checkout. */
  branch: string | null;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheCreation: number;
  tokensTotal: number;
  costUsd: number | null;
  costSource: string | null;
  observationCount: number;
  modelBreakdown: Record<string, unknown>;
  sources: string[];
  harvestVersion: number;
  /** False when the provider reported only a session total and no unit of it has been observed. */
  itemized: boolean;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** See `UsageRowView.changedAt`. */
  changedAt: Date;
}

export interface SessionCrossCheck {
  repositoryId: string;
  agentTool: string;
  sessionId: string;
  /** Sum of the session's observations, assigned and unassigned. */
  observedCostUsd: number | null;
  /** What the provider reported as the session total. */
  reportedCostUsd: number | null;
  observationCount: number;
}

export interface UsageView {
  rows: UsageRowView[];
  unassigned: UnassignedUsageView[];
  crossChecks: SessionCrossCheck[];
}

function decimal(value: number | null): Prisma.Decimal | null {
  return value == null ? null : new Prisma.Decimal(value);
}

function bucketCostSource(source: UsageBucket['costSource']): string | null {
  // "mixed" reads high where estimated, like an estimated row (#339).
  return source === 'mixed' ? 'estimated' : source;
}

interface SlotContext {
  slotId: number;
  occupancyKey: string | null;
  workDir: string | null;
  worktreePath: string | null;
  branch: string | null;
  suffix: string | null;
  workUnitId: string | null;
  attemptId: string | null;
  sessionCreatedAt: Date | null;
}

interface AttemptContext {
  attemptId: string;
  agentId: number;
  workDir: string | null;
  worktreePath: string | null;
  branch: string | null;
  workUnitId: string;
  sourceCreatedAt: Date;
}

export function slotRowFromBucket(
  repositoryId: string,
  bucket: SlotUsageBucket,
  slots: SlotContext[],
  attempts: AttemptContext[],
  changedAt: Date = bucket.lastSeenAt,
): UsageRowView {
  const slot = slots.find(
    (candidate) =>
      candidate.slotId === bucket.slotId &&
      ((bucket.occupancyKey && candidate.occupancyKey === bucket.occupancyKey) ||
        (!bucket.occupancyKey && bucket.branch && candidate.branch === bucket.branch)),
  );
  const attemptId = attemptIdFromOccupancyKey(bucket.occupancyKey) ?? slot?.attemptId ?? null;
  const attempt = attemptId ? attempts.find((candidate) => candidate.attemptId === attemptId) : undefined;
  return {
    id: `obs:${bucket.agentTool}:${bucket.sessionId}:${bucket.slotId}:${bucket.occupancyKey ?? ''}`,
    repositoryId,
    sessionKey: bucket.sessionId,
    agentId: bucket.slotId,
    agentTool: bucket.agentTool,
    workDir: slot?.workDir ?? slot?.worktreePath ?? attempt?.workDir ?? attempt?.worktreePath ?? null,
    branch: bucket.branch ?? slot?.branch ?? attempt?.branch ?? null,
    suffix: slot?.suffix ?? null,
    occupancyKey: bucket.occupancyKey ?? slot?.occupancyKey ?? null,
    workUnitId: slot?.workUnitId ?? attempt?.workUnitId ?? null,
    attemptId,
    tokensInput: BigInt(bucket.tokensInput),
    tokensOutput: BigInt(bucket.tokensOutput),
    tokensCacheRead: BigInt(bucket.tokensCacheRead),
    tokensCacheCreation: BigInt(bucket.tokensCacheCreation),
    tokensTotal: BigInt(bucket.tokensTotal),
    costUsd: decimal(bucket.costUsd),
    costSource: bucketCostSource(bucket.costSource),
    modelBreakdown: bucket.modelBreakdown as unknown as Prisma.JsonValue,
    sources: bucket.sources,
    harvestVersion: USAGE_HARVEST_VERSION,
    firstSeenAt: bucket.firstSeenAt,
    lastSeenAt: bucket.lastSeenAt,
    updatedAt: bucket.lastSeenAt,
    origin: 'observations',
    changedAt,
  };
}

function toStringArray(value: Prisma.JsonValue | null | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function factFromRow(row: {
  agentTool: string;
  sessionId: string;
  subagentId: string;
  observationKey: string;
  observedAt: Date;
  granularity: string;
  source: string;
  producer: string;
  model: string | null;
  tokensInput: bigint;
  tokensOutput: bigint;
  tokensCacheRead: bigint;
  tokensCacheCreation: bigint;
  costUsd: Prisma.Decimal | null;
}): ObservationFact {
  return {
    agentTool: row.agentTool,
    sessionId: row.sessionId,
    subagentId: row.subagentId || null,
    observationKey: row.observationKey,
    observedAt: row.observedAt,
    granularity: row.granularity,
    source: row.source,
    producer: row.producer,
    model: row.model,
    tokensInput: Number(row.tokensInput),
    tokensOutput: Number(row.tokensOutput),
    tokensCacheRead: Number(row.tokensCacheRead),
    tokensCacheCreation: Number(row.tokensCacheCreation),
    costUsd: row.costUsd == null ? null : Number(row.costUsd),
  };
}

export interface UsageViewInputs {
  repositoryId: string;
  bindings: TimelineBinding[];
  observations: ObservationFact[];
  slots: SlotContext[];
  attempts: AttemptContext[];
  legacy: AgentSessionUsageRow[];
  reported: Array<{ agentTool: string; sessionId: string; costUsd: number | null; tokensTotal: number; firstSeenAt: Date; lastSeenAt: Date }>;
  /** Per session (`agentTool\0sessionId`): when its facts last changed; defaults to the row's `lastSeenAt`. */
  sessionChangedAt?: Map<string, Date>;
}

/** Pure assembly of the read model from loaded facts (unit-tested). */
export function buildUsageView(inputs: UsageViewInputs): UsageView {
  const { repositoryId } = inputs;
  const occupancyEvents: OccupancyEvent[] = occupancyEventsFromContext(inputs.slots, inputs.attempts);
  const projection = projectUsage(inputs.bindings, inputs.observations, occupancyEvents);
  const coverage = observationCoverage(inputs.observations);

  const sessionKey = (agentTool: string, sessionId: string) => `${agentTool}\0${sessionId}`;
  const changedAt = (agentTool: string, sessionId: string, lastSeenAt: Date) => {
    const changed = inputs.sessionChangedAt?.get(sessionKey(agentTool, sessionId));
    return changed && changed > lastSeenAt ? changed : lastSeenAt;
  };

  const rows: UsageRowView[] = [
    ...projection.slots.map((bucket) =>
      slotRowFromBucket(
        repositoryId,
        bucket,
        inputs.slots,
        inputs.attempts,
        changedAt(bucket.agentTool, bucket.sessionId, bucket.lastSeenAt),
      ),
    ),
    ...inputs.legacy
      .filter((row) => !legacyRowSuperseded(row, coverage))
      .map((row) => ({
        ...row,
        costUsd: UNPRICED_AGENT_TOOLS.has(row.agentTool) ? null : row.costUsd,
        sources: toStringArray(row.sources),
        origin: 'legacy' as const,
        changedAt: row.updatedAt,
      })),
  ].sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());

  const observed = new Map<string, { cost: number | null; count: number }>();
  for (const bucket of [...projection.slots, ...projection.unassigned]) {
    const key = sessionKey(bucket.agentTool, bucket.sessionId);
    const entry = observed.get(key) ?? { cost: null, count: 0 };
    if (bucket.costUsd != null) entry.cost = (entry.cost ?? 0) + bucket.costUsd;
    entry.count += bucket.observationCount;
    observed.set(key, entry);
  }

  const unassigned: UnassignedUsageView[] = projection.unassigned.map((bucket) => ({
    repositoryId,
    agentTool: bucket.agentTool,
    sessionId: bucket.sessionId,
    workDir: bucket.workDir,
    branch: bucket.branch,
    tokensInput: bucket.tokensInput,
    tokensOutput: bucket.tokensOutput,
    tokensCacheRead: bucket.tokensCacheRead,
    tokensCacheCreation: bucket.tokensCacheCreation,
    tokensTotal: bucket.tokensTotal,
    costUsd: bucket.costUsd,
    costSource: bucketCostSource(bucket.costSource),
    observationCount: bucket.observationCount,
    modelBreakdown: bucket.modelBreakdown,
    sources: bucket.sources,
    harvestVersion: USAGE_HARVEST_VERSION,
    itemized: true,
    firstSeenAt: bucket.firstSeenAt,
    lastSeenAt: bucket.lastSeenAt,
    changedAt: changedAt(bucket.agentTool, bucket.sessionId, bucket.lastSeenAt),
  }));
  // A session the provider reported a total for, with no unit observed: its
  // cost exists but cannot be placed — shown with the unassigned usage.
  for (const total of inputs.reported) {
    if (observed.has(sessionKey(total.agentTool, total.sessionId))) continue;
    unassigned.push({
      repositoryId,
      agentTool: total.agentTool,
      sessionId: total.sessionId,
      workDir: null,
      branch: null,
      tokensInput: 0,
      tokensOutput: 0,
      tokensCacheRead: 0,
      tokensCacheCreation: 0,
      tokensTotal: total.tokensTotal,
      costUsd: total.costUsd,
      costSource: total.costUsd == null ? null : 'reported',
      observationCount: 0,
      modelBreakdown: {},
      sources: [],
      harvestVersion: USAGE_HARVEST_VERSION,
      itemized: false,
      firstSeenAt: total.firstSeenAt,
      lastSeenAt: total.lastSeenAt,
      changedAt: changedAt(total.agentTool, total.sessionId, total.lastSeenAt),
    });
  }
  unassigned.sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());

  const crossChecks: SessionCrossCheck[] = inputs.reported
    .filter((total) => observed.has(sessionKey(total.agentTool, total.sessionId)))
    .map((total) => {
      const entry = observed.get(sessionKey(total.agentTool, total.sessionId))!;
      return {
        repositoryId,
        agentTool: total.agentTool,
        sessionId: total.sessionId,
        observedCostUsd: entry.cost,
        reportedCostUsd: total.costUsd,
        observationCount: entry.count,
      };
    });

  return { rows, unassigned, crossChecks };
}

/** Load a repository's facts and derive its usage. */
export async function loadUsageView(repositoryId: string): Promise<UsageView> {
  const [bindings, observations, slots, attempts, legacy, reported] = await Promise.all([
    prisma.sessionSlotBinding.findMany({ where: { repositoryId } }),
    prisma.usageObservation.findMany({
      where: { repositoryId },
      select: {
        agentTool: true,
        sessionId: true,
        subagentId: true,
        observationKey: true,
        observedAt: true,
        granularity: true,
        source: true,
        producer: true,
        model: true,
        tokensInput: true,
        tokensOutput: true,
        tokensCacheRead: true,
        tokensCacheCreation: true,
        costUsd: true,
        updatedAt: true,
      },
    }),
    prisma.agentSlot.findMany({
      where: { repositoryId },
      select: {
        slotId: true,
        occupancyKey: true,
        workDir: true,
        worktreePath: true,
        branch: true,
        suffix: true,
        workUnitId: true,
        attemptId: true,
        sessionCreatedAt: true,
      },
    }),
    prisma.workAttempt.findMany({
      where: { repositoryId },
      select: {
        attemptId: true,
        agentId: true,
        workDir: true,
        worktreePath: true,
        branch: true,
        sourceCreatedAt: true,
        workUnit: { select: { workUnitId: true } },
      },
    }),
    prisma.agentSessionUsage.findMany({ where: { repositoryId } }),
    prisma.sessionReportedUsage.findMany({ where: { repositoryId } }),
  ]);

  const sessionChangedAt = new Map<string, Date>();
  const touch = (agentTool: string, sessionId: string, at: Date) => {
    const key = `${agentTool}\0${sessionId}`;
    const current = sessionChangedAt.get(key);
    if (!current || at > current) sessionChangedAt.set(key, at);
  };
  for (const row of observations) touch(row.agentTool, row.sessionId, row.updatedAt);
  // A release or launch also closes other sessions' bindings to its slot, so it
  // changes every session bound to that slot. (Evidence bindings repeat on
  // every record; they only move their own session.)
  const sessionsBySlot = new Map<number, Map<string, { agentTool: string; sessionId: string }>>();
  for (const row of bindings) {
    const sessions = sessionsBySlot.get(row.slotId) ?? new Map();
    sessions.set(`${row.agentTool}\0${row.sessionId}`, row);
    sessionsBySlot.set(row.slotId, sessions);
  }
  for (const row of bindings) {
    touch(row.agentTool, row.sessionId, row.createdAt);
    if (row.kind !== 'release' && row.kind !== 'launch') continue;
    for (const other of sessionsBySlot.get(row.slotId)?.values() ?? []) {
      touch(other.agentTool, other.sessionId, row.createdAt);
    }
  }
  for (const row of reported) touch(row.agentTool, row.sessionId, row.updatedAt);

  return buildUsageView({
    repositoryId,
    sessionChangedAt,
    bindings: bindings.map((row) => ({
      agentTool: row.agentTool,
      sessionId: row.sessionId,
      subagentId: row.subagentId || null,
      kind: row.kind as SessionBindingKind,
      slotId: row.slotId,
      occupancyKey: row.occupancyKey,
      branch: row.branch,
      at: row.at,
    })),
    observations: observations.map(factFromRow),
    slots,
    attempts: attempts.map(({ workUnit, ...attempt }) => ({ ...attempt, workUnitId: workUnit.workUnitId })),
    legacy,
    reported: reported.map((row) => ({
      agentTool: row.agentTool,
      sessionId: row.sessionId,
      costUsd: row.costUsd == null ? null : Number(row.costUsd),
      tokensTotal: Number(row.tokensTotal),
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
    })),
  });
}

/** Derived usage of every registered repository. */
export async function loadAllUsageViews(): Promise<Array<{ repository: { id: string; path: string }; view: UsageView }>> {
  const repositories = await prisma.repository.findMany({ select: { id: true, path: true } });
  return Promise.all(
    repositories.map(async (repository) => ({ repository, view: await loadUsageView(repository.id) })),
  );
}
