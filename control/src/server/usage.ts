import { Prisma } from '@prisma/client';
import type { AgentSessionUsage, UsageSource } from '@har/schemas';
import {
  enrichUsageWithPricing,
  harvestSupersedes,
  mergedHarvestVersion,
  usageHarvestVersion,
} from '@har/schemas';
import { prisma } from '@/lib/db';
import { loadAllUsageViews, loadUsageView, type UsageView } from '@/server/session-attribution';

function toBigInt(n: number | bigint | undefined | null): bigint {
  if (n === undefined || n === null) return 0n;
  return typeof n === 'bigint' ? n : BigInt(Math.max(0, Math.floor(Number(n))));
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function maxCost(
  a: Prisma.Decimal | null | undefined,
  b: number | null | undefined,
): Prisma.Decimal | null {
  const left = a == null ? null : Number(a);
  const right = b == null ? null : Number(b);
  if (left == null && right == null) return null;
  if (left == null) return new Prisma.Decimal(right!);
  if (right == null) return a ?? null;
  return new Prisma.Decimal(Math.max(left, right));
}

/** SQLite stores `sources` as a JSON column; coerce it back to a string[]. */
function toStringArray(value: Prisma.JsonValue | null | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function mergeSources(
  existing: Prisma.JsonValue | string[] | undefined,
  incoming: UsageSource[],
): string[] {
  const base = Array.isArray(existing) ? existing.map(String) : [];
  return [...new Set([...base, ...incoming])];
}

function asBreakdownRecord(
  value: unknown,
): Record<string, Record<string, number>> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, Record<string, number>> = {};
  for (const [model, totals] of Object.entries(value as Record<string, unknown>)) {
    if (!model || !totals || typeof totals !== 'object' || Array.isArray(totals)) {
      out[model] = {};
      continue;
    }
    const numeric: Record<string, number> = {};
    for (const [key, raw] of Object.entries(totals as Record<string, unknown>)) {
      const n = Number(raw);
      if (Number.isFinite(n)) numeric[key] = n;
    }
    out[model] = numeric;
  }
  return out;
}

/** Max-merge per-model counters; always keeps every model id seen. */
function mergeModelBreakdown(
  existing: Prisma.JsonValue | null | undefined,
  incoming: unknown,
): Prisma.InputJsonValue | undefined {
  const left = asBreakdownRecord(existing);
  const right = asBreakdownRecord(incoming);
  if (!left && !right) return undefined;
  const models = new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})]);
  const out: Record<string, Record<string, number>> = {};
  for (const model of models) {
    const a = left?.[model] ?? {};
    const b = right?.[model] ?? {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const merged: Record<string, number> = {};
    for (const key of keys) {
      merged[key] = Math.max(Number(a[key] ?? 0), Number(b[key] ?? 0));
    }
    out[model] = merged;
  }
  return out as Prisma.InputJsonValue;
}

export type UsageUpsertInput = AgentSessionUsage;

/** Provenance of a session's `costUsd` (#339). */
export type CostSource = 'reported' | 'estimated';

export function toCostSource(value: unknown): CostSource | null {
  return value === 'reported' || value === 'estimated' ? value : null;
}

/**
 * Max-merge upsert so OTEL and harvest never double-count cumulative counters,
 * unless a newer `harvestVersion` supersedes the stored row.
 */
export async function upsertSessionUsage(repositoryId: string, input: UsageUpsertInput) {
  const existing = await prisma.agentSessionUsage.findUnique({
    where: {
      repositoryId_sessionKey_agentTool: {
        repositoryId,
        sessionKey: input.sessionKey,
        agentTool: input.agentTool,
      },
    },
  });

  const existingAuthority = existing
    ? { sources: toStringArray(existing.sources), harvestVersion: existing.harvestVersion }
    : null;
  const supersedes = harvestSupersedes(existingAuthority, input);

  const merge = (a: bigint, b: bigint): bigint => (supersedes ? b : maxBigInt(a, b));

  const tokensInput = merge(toBigInt(existing?.tokensInput), toBigInt(input.tokensInput));
  const tokensOutput = merge(toBigInt(existing?.tokensOutput), toBigInt(input.tokensOutput));
  const tokensCacheRead = merge(
    toBigInt(existing?.tokensCacheRead),
    toBigInt(input.tokensCacheRead),
  );
  const tokensCacheCreation = merge(
    toBigInt(existing?.tokensCacheCreation),
    toBigInt(input.tokensCacheCreation),
  );
  const tokensTotal = merge(
    toBigInt(existing?.tokensTotal),
    toBigInt(input.tokensTotal) || tokensInput + tokensOutput + tokensCacheRead + tokensCacheCreation,
  );
  const harvestVersion = supersedes
    ? usageHarvestVersion(input)
    : mergedHarvestVersion(existingAuthority, input);
  // A superseding harvest recomputes the window, so it may also lower it.
  const firstSeenAt =
    existing && !supersedes
      ? new Date(
          Math.min(existing.firstSeenAt.getTime(), new Date(input.firstSeenAt).getTime()),
        )
      : new Date(input.firstSeenAt);
  const lastSeenAt =
    existing && !supersedes
      ? new Date(Math.max(existing.lastSeenAt.getTime(), new Date(input.lastSeenAt).getTime()))
      : new Date(input.lastSeenAt);

  const mergedModelBreakdown = supersedes
    ? mergeModelBreakdown(null, input.modelBreakdown)
    : mergeModelBreakdown(existing?.modelBreakdown, input.modelBreakdown);
  const reportedCost = supersedes
    ? maxCost(null, input.costUsd ?? null)
    : maxCost(existing?.costUsd, input.costUsd ?? null);

  const priced = enrichUsageWithPricing({
    agentTool: input.agentTool,
    costUsd: reportedCost == null ? null : Number(reportedCost),
    modelBreakdown: mergedModelBreakdown as AgentSessionUsage['modelBreakdown'],
  });

  const nextModelBreakdown = priced.modelBreakdown ?? mergedModelBreakdown;

  const costUsd =
    priced.costUsd == null
      ? reportedCost
      : new Prisma.Decimal(
          Math.max(Number(reportedCost ?? 0), priced.costUsd) || priced.costUsd,
        );
  // #339: say where the number comes from. The estimate wins only when it is
  // higher than what the agent reported, so "estimated" means the row reads high.
  const costSource: CostSource | null =
    costUsd == null
      ? null
      : priced.costUsd != null && priced.costUsd > Number(reportedCost ?? 0)
        ? 'estimated'
        : 'reported';

  const fields = {
    agentId: input.agentId,
    workDir: input.workDir ?? existing?.workDir ?? null,
    branch: input.branch ?? existing?.branch ?? null,
    suffix: input.suffix ?? existing?.suffix ?? null,
    workUnitId: input.workUnitId ?? existing?.workUnitId ?? null,
    attemptId: input.attemptId ?? existing?.attemptId ?? null,
    occupancyKey: input.occupancyKey ?? existing?.occupancyKey ?? null,
    tokensInput,
    tokensOutput,
    tokensCacheRead,
    tokensCacheCreation,
    tokensTotal,
    costUsd,
    costSource,
    // Prisma reads `undefined` as "leave unchanged", so a superseding harvest
    // with no breakdown has to clear the stored one explicitly.
    modelBreakdown: nextModelBreakdown
      ? (nextModelBreakdown as Prisma.InputJsonValue)
      : supersedes
        ? Prisma.JsonNull
        : undefined,
    sources: mergeSources(existing?.sources, input.sources ?? []),
    harvestVersion,
    firstSeenAt,
    lastSeenAt,
  };

  return prisma.agentSessionUsage.upsert({
    where: {
      repositoryId_sessionKey_agentTool: {
        repositoryId,
        sessionKey: input.sessionKey,
        agentTool: input.agentTool,
      },
    },
    create: {
      repositoryId,
      sessionKey: input.sessionKey,
      agentTool: input.agentTool,
      ...fields,
    },
    update: fields,
  });
}

export async function syncUsage(repositoryId: string, records: UsageUpsertInput[]) {
  let synced = 0;
  for (const record of records) {
    await upsertSessionUsage(repositoryId, record);
    synced += 1;
  }
  return { synced };
}

/**
 * Usage rows of a repository (ADR 0003): per-slot usage derived from usage
 * observations and the session binding timeline, plus legacy session totals
 * that no observation supersedes. Usage with no binding is not here — it is
 * the sessions' unassigned (main checkout) usage, see `listUnassignedUsage`.
 */
export async function listSessionUsageForRepo(repositoryId: string, view?: UsageView) {
  return (view ?? (await loadUsageView(repositoryId))).rows;
}

/** Usage spent outside any slot, per session — the main checkout. Never booked on a slot. */
export async function listUnassignedUsage(repositoryId: string, view?: UsageView) {
  return (view ?? (await loadUsageView(repositoryId))).unassigned;
}

export async function listSessionUsageForSlot(
  repositoryId: string,
  agentId: number,
  occupancyKey?: string | null,
) {
  // #316: scope to the current occupancy so a relaunched slot does not show the
  // previous session's usage as if it were the same working session.
  const rows = await listSessionUsageForRepo(repositoryId);
  return rows.filter(
    (row) => row.agentId === agentId && (!occupancyKey || row.occupancyKey === occupancyKey),
  );
}

export async function summarizeUsageForBranch(
  repositoryId: string,
  branch: string | null | undefined,
  suffix: string | null | undefined,
  view?: UsageView,
) {
  const rows =
    !branch && !suffix
      ? []
      : (await listSessionUsageForRepo(repositoryId, view)).filter(
          (row) =>
            (branch && (row.branch === branch || row.sessionKey === branch)) ||
            (suffix && row.suffix === suffix),
        );

  let tokensTotal = 0n;
  let costUsd = 0;
  let hasCost = false;
  const tools = new Set<string>();
  const sources = new Set<string>();

  for (const row of rows) {
    tokensTotal += row.tokensTotal;
    if (row.costUsd != null) {
      costUsd += Number(row.costUsd);
      hasCost = true;
    }
    tools.add(row.agentTool);
    for (const s of row.sources) sources.add(s);
  }

  return {
    tokensTotal: Number(tokensTotal),
    costUsd: hasCost ? costUsd : null,
    agentTools: [...tools],
    sources: [...sources],
    rows,
  };
}

/** Every repository's usage rows and unassigned (main checkout) usage, derived once. */
export async function listAllUsage() {
  const views = await loadAllUsageViews();
  const byRecency = (a: { lastSeenAt: Date }, b: { lastSeenAt: Date }) =>
    b.lastSeenAt.getTime() - a.lastSeenAt.getTime();
  return {
    rows: views.flatMap(({ repository, view }) => view.rows.map((row) => ({ ...row, repository }))).sort(byRecency),
    unassigned: views
      .flatMap(({ repository, view }) => view.unassigned.map((row) => ({ ...row, repository })))
      .sort(byRecency),
  };
}

export function summarizeUsageRows(
  rows: Array<{
    tokensTotal: bigint | number;
    costUsd: Prisma.Decimal | number | null;
    agentTool: string;
    sources: string[];
    lastSeenAt: Date;
  }>,
) {
  let tokensTotal = 0;
  let costUsd = 0;
  let hasCost = false;
  const tools = new Set<string>();
  const sources = new Set<string>();
  let lastSeenAt: Date | null = null;

  for (const row of rows) {
    tokensTotal += Number(row.tokensTotal);
    if (row.costUsd != null) {
      costUsd += Number(row.costUsd);
      hasCost = true;
    }
    tools.add(row.agentTool);
    for (const s of row.sources) sources.add(s);
    if (!lastSeenAt || row.lastSeenAt > lastSeenAt) lastSeenAt = row.lastSeenAt;
  }

  return {
    tokensTotal,
    costUsd: hasCost ? costUsd : null,
    agentTools: [...tools],
    sources: [...sources],
    lastSeenAt,
    sessionCount: rows.length,
  };
}
