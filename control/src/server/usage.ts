import { Prisma } from '@prisma/client';
import type { AgentSessionUsage, UsageSource } from '@har/schemas';
import { enrichUsageWithPricing } from '@har/schemas';
import { prisma } from '@/lib/db';

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

/** Max-merge upsert so OTEL and harvest never double-count cumulative counters. */
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

  const tokensInput = maxBigInt(toBigInt(existing?.tokensInput), toBigInt(input.tokensInput));
  const tokensOutput = maxBigInt(toBigInt(existing?.tokensOutput), toBigInt(input.tokensOutput));
  const tokensCacheRead = maxBigInt(
    toBigInt(existing?.tokensCacheRead),
    toBigInt(input.tokensCacheRead),
  );
  const tokensCacheCreation = maxBigInt(
    toBigInt(existing?.tokensCacheCreation),
    toBigInt(input.tokensCacheCreation),
  );
  const tokensTotal = maxBigInt(
    toBigInt(existing?.tokensTotal),
    toBigInt(input.tokensTotal) || tokensInput + tokensOutput + tokensCacheRead + tokensCacheCreation,
  );
  const firstSeenAt = existing
    ? new Date(
        Math.min(existing.firstSeenAt.getTime(), new Date(input.firstSeenAt).getTime()),
      )
    : new Date(input.firstSeenAt);
  const lastSeenAt = existing
    ? new Date(Math.max(existing.lastSeenAt.getTime(), new Date(input.lastSeenAt).getTime()))
    : new Date(input.lastSeenAt);

  const mergedModelBreakdown = mergeModelBreakdown(existing?.modelBreakdown, input.modelBreakdown);
  const reportedCost = maxCost(existing?.costUsd, input.costUsd ?? null);

  const priced = enrichUsageWithPricing({
    agentTool: input.agentTool,
    costUsd: reportedCost == null ? null : Number(reportedCost),
    modelBreakdown: mergedModelBreakdown as AgentSessionUsage['modelBreakdown'],
  });

  const costUsd =
    priced.costUsd == null
      ? reportedCost
      : new Prisma.Decimal(
          Math.max(Number(reportedCost ?? 0), priced.costUsd) || priced.costUsd,
        );

  const fields = {
    agentId: input.agentId,
    workDir: input.workDir ?? existing?.workDir ?? null,
    branch: input.branch ?? existing?.branch ?? null,
    suffix: input.suffix ?? existing?.suffix ?? null,
    workUnitId: input.workUnitId ?? existing?.workUnitId ?? null,
    attemptId: input.attemptId ?? existing?.attemptId ?? null,
    tokensInput,
    tokensOutput,
    tokensCacheRead,
    tokensCacheCreation,
    tokensTotal,
    costUsd,
    modelBreakdown: (priced.modelBreakdown ?? mergedModelBreakdown) as Prisma.InputJsonValue | undefined,
    sources: mergeSources(existing?.sources, input.sources ?? []),
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

export async function listSessionUsageForRepo(repositoryId: string) {
  const rows = await prisma.agentSessionUsage.findMany({
    where: { repositoryId },
    orderBy: { lastSeenAt: 'desc' },
  });
  return rows.map((row) => ({ ...row, sources: toStringArray(row.sources) }));
}

export async function listSessionUsageForSlot(repositoryId: string, agentId: number) {
  const rows = await prisma.agentSessionUsage.findMany({
    where: { repositoryId, agentId },
    orderBy: { lastSeenAt: 'desc' },
  });
  return rows.map((row) => ({ ...row, sources: toStringArray(row.sources) }));
}

export async function summarizeUsageForBranch(
  repositoryId: string,
  branch: string | null | undefined,
  suffix: string | null | undefined,
) {
  const or: Array<{ branch?: string; sessionKey?: string; suffix?: string }> = [];
  if (branch) {
    or.push({ branch });
    or.push({ sessionKey: branch });
  }
  if (suffix) or.push({ suffix });

  const rawRows =
    or.length === 0
      ? []
      : await prisma.agentSessionUsage.findMany({
          where: { repositoryId, OR: or },
        });
  const rows = rawRows.map((row) => ({ ...row, sources: toStringArray(row.sources) }));

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

export async function listAllSessionUsage() {
  const rows = await prisma.agentSessionUsage.findMany({
    orderBy: { lastSeenAt: 'desc' },
    include: {
      repository: { select: { id: true, path: true } },
    },
  });
  return rows.map((row) => ({
    ...row,
    sources: toStringArray(row.sources),
  }));
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
