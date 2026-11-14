import {
  checkUsageInvariants,
  ledgerRowsFromUsageView,
  type UsageInvariantReport,
  type UsageLedger,
} from '@har/schemas';
import { prisma } from '@/lib/db';
import { loadUsageView } from '@/server/session-attribution';

/**
 * Usage invariants over everything Mission Control holds (FE-2058). The checks
 * are `@har/schemas`' `checkUsageInvariants`; this module only loads the
 * ledger: every repository, its observations, and the usage rows its view
 * serves (the rows `har control sync` ships).
 */
export async function loadUsageLedger(): Promise<UsageLedger> {
  const repositories = await prisma.repository.findMany({ select: { id: true, path: true } });
  const [observations, views] = await Promise.all([
    prisma.usageObservation.findMany(),
    Promise.all(repositories.map(async (r) => ({ id: r.id, view: await loadUsageView(r.id) }))),
  ]);
  type Rows = Array<Record<string, unknown>>;
  return {
    repositories,
    observations: observations.map((o) => ({
      ...o,
      subagentId: o.subagentId || null,
      tokensInput: Number(o.tokensInput),
      tokensOutput: Number(o.tokensOutput),
      tokensCacheRead: Number(o.tokensCacheRead),
      tokensCacheCreation: Number(o.tokensCacheCreation),
      costUsd: o.costUsd == null ? null : Number(o.costUsd),
    })),
    rows: views.flatMap(({ id, view }) =>
      ledgerRowsFromUsageView(id, {
        usage: view.rows as unknown as Rows,
        unassigned: view.unassigned as unknown as Rows,
      }),
    ),
  };
}

export class UnknownRepositoryError extends Error {
  constructor(repo: string) {
    super(`unknown repository: ${repo}`);
  }
}

/**
 * The report for every repository, or only the violations touching `repo` (an
 * id or a path). The checks always read every repository: a request stored
 * twice is found from either side.
 */
export async function checkMissionControlUsage(
  repo?: string | null,
): Promise<UsageInvariantReport & { repositories: Array<{ id: string; path: string }> }> {
  const ledger = await loadUsageLedger();
  const trim = (p: string) => p.replace(/\/+$/, '');
  const wanted = repo
    ? ledger.repositories.filter((r) => r.id === repo || trim(r.path) === trim(repo))
    : null;
  if (wanted?.length === 0) throw new UnknownRepositoryError(repo!);
  const report = checkUsageInvariants(
    ledger,
    wanted ? { repositoryIds: wanted.map((r) => r.id) } : {},
  );
  return { ...report, repositories: ledger.repositories };
}
