import type { AgentSessionUsage, Prisma, WorkAttempt } from '@prisma/client';
import { prisma } from '@/lib/db';
import { inWindow, legacyWindow, type LegacyWindow } from '@/server/attempt-record';
import { occupancyKeyForAttempt } from '@/server/occupancy';
import { toCostSource, type CostSource } from '@/server/usage';

export interface WorkUnitUsage {
  tokensTotal: bigint | null;
  costUsd: number | null;
  /** How the cost was obtained across the unit's sessions. */
  costSource: CostSource | 'mixed' | null;
  sessionCount: number;
}

/** Pure part of the attribution, unit-tested: which usage rows belong to the unit. */
export function selectWorkUnitUsageRows<T extends Pick<AgentSessionUsage, 'workUnitId' | 'attemptId' | 'occupancyKey' | 'agentId' | 'workDir' | 'firstSeenAt'>>(
  rows: T[],
  workUnitId: string,
  attempts: Array<Pick<WorkAttempt, 'attemptId'>>,
  windows: LegacyWindow[],
): T[] {
  const attemptIds = new Set(attempts.map((attempt) => attempt.attemptId));
  const keys = new Set(attempts.map((attempt) => occupancyKeyForAttempt(attempt.attemptId)));
  return rows.filter(
    (row) =>
      row.workUnitId === workUnitId ||
      (row.attemptId != null && attemptIds.has(row.attemptId)) ||
      (row.occupancyKey != null && keys.has(row.occupancyKey)) ||
      (row.workUnitId == null &&
        row.attemptId == null &&
        row.occupancyKey == null &&
        windows.some((window) => inWindow(window, { agentId: row.agentId, workDir: row.workDir, at: row.firstSeenAt }))),
  );
}

export function summarizeWorkUnitUsage(
  rows: Array<{ tokensTotal: bigint | number; costUsd: Prisma.Decimal | number | null; costSource: string | null }>,
): WorkUnitUsage {
  let tokens = BigInt(0);
  let cost = 0;
  let hasCost = false;
  const sources = new Set<CostSource>();
  for (const row of rows) {
    tokens += BigInt(row.tokensTotal);
    if (row.costUsd != null) {
      cost += Number(row.costUsd);
      hasCost = true;
      const source = toCostSource(row.costSource);
      if (source) sources.add(source);
    }
  }
  return {
    tokensTotal: rows.length ? tokens : null,
    costUsd: hasCost ? cost : null,
    costSource: sources.size > 1 ? 'mixed' : ([...sources][0] ?? null),
    sessionCount: rows.length,
  };
}

/**
 * Usage of a work unit through its attempts (#339, #348): sessions stamped with the
 * unit, an attempt, or an attempt's occupancy key, plus legacy rows that fall in the
 * window an attempt owned its work dir. `workUnitId` alone misses every session that
 * OTEL attributed to a slot before the work binding was known.
 */
export async function attributeWorkUnitUsage(
  repositoryId: string,
  workUnitId: string,
  attempts: WorkAttempt[],
): Promise<WorkUnitUsage> {
  const [rows, windows] = await Promise.all([
    prisma.agentSessionUsage.findMany({
      where: {
        repositoryId,
        OR: [
          { workUnitId },
          ...(attempts.length
            ? [
                { attemptId: { in: attempts.map((attempt) => attempt.attemptId) } },
                { occupancyKey: { in: attempts.map((attempt) => occupancyKeyForAttempt(attempt.attemptId)) } },
                { workUnitId: null, attemptId: null, occupancyKey: null, agentId: { in: [...new Set(attempts.map((a) => a.agentId))] } },
              ]
            : []),
        ],
      },
    }),
    Promise.all(attempts.map((attempt) => legacyWindow(repositoryId, attempt))).then((list) =>
      list.filter((window): window is LegacyWindow => window != null),
    ),
  ]);
  return summarizeWorkUnitUsage(selectWorkUnitUsageRows(rows, workUnitId, attempts, windows));
}
