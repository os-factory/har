import * as path from 'path';
import { usageUnitKey, type UsageInvariantId, type UsageInvariantReport } from '../harness/schema';
import { syncFetch } from './sync-request';

/**
 * Client of Mission Control's usage invariants (`GET /api/usage/invariants`,
 * FE-2058). Mission Control holds the facts, so the checks run there; the CLI
 * prints the report (`har control check-usage`) and leaves the blocked units
 * out of the HQ post (`har control sync`).
 */

export type MissionControlUsageReport = UsageInvariantReport & {
  repositories: Array<{ id: string; path: string }>;
};

/** The report, scoped to `repo` (id or path) when given. Throws when Mission Control predates the route. */
export async function fetchUsageInvariantReport(
  apiUrl: string,
  repo?: string,
): Promise<MissionControlUsageReport> {
  const url = `${apiUrl}/api/usage/invariants${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`;
  // The checks read every repository's usage: more than one request's usual budget.
  const response = await syncFetch(url, {}, 120_000);
  if (response.status === 404) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(
      body?.error ??
        'this Mission Control has no usage invariants route (upgrade it: har control up)',
    );
  }
  if (!response.ok) {
    throw new Error(
      `Mission Control ${response.status}: ${(await response.text().catch(() => '')) || response.statusText}`,
    );
  }
  return (await response.json()) as MissionControlUsageReport;
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const tokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);

/** Plain-text report: one line per invariant, then each violation with its keys. */
export function formatUsageInvariantReport(
  report: MissionControlUsageReport,
  limit = 20,
): string[] {
  const repoName = new Map(report.repositories.map((r) => [r.id, path.basename(r.path)]));
  const { repositories, observations, rows } = report.checked;
  const lines = [
    `Checked ${repositories} repositories, ${observations} observations, ${rows} usage rows.`,
  ];
  for (const s of report.summary) {
    const mark = s.violations === 0 ? 'ok  ' : s.blocking ? 'FAIL' : 'warn';
    const found =
      s.violations > 0
        ? `: ${s.violations} violation(s), ${tokens(s.tokens)} tokens, ${usd(s.costUsd)}`
        : '';
    lines.push(`  ${mark} ${s.invariant} ${s.name}${found}`);
  }
  const shown = report.violations.slice(0, limit);
  if (shown.length > 0) lines.push('');
  for (const v of shown) {
    const repos = v.repositoryIds.map((id) => repoName.get(id) ?? id).join(', ');
    const more = v.keys.length > 4 ? ` (+${v.keys.length - 4})` : '';
    lines.push(
      `  ${v.invariant} ${v.message} — ${tokens(v.tokens)} tokens, ${usd(v.costUsd)} [${repos}]`,
    );
    lines.push(`     keys: ${v.keys.slice(0, 4).join(', ')}${more}`);
  }
  if (report.violations.length > shown.length) {
    lines.push(`  … ${report.violations.length - shown.length} more (use --json for all)`);
  }
  return lines;
}

/** Unit key (`usageUnitKey`) → the blocking invariants it breaks, for one repository. */
export type HeldUsageUnits = Map<string, UsageInvariantId[]>;

/** The units of `repoPath` a sync leaves out of the HQ post. */
export function heldUnitsForRepo(
  report: MissionControlUsageReport,
  repoPath: string,
): HeldUsageUnits {
  const repo = report.repositories.find((r) => path.resolve(r.path) === path.resolve(repoPath));
  return new Map(
    report.blockedUnits
      .filter((u) => u.repositoryId === repo?.id)
      .map((u) => [usageUnitKey(u), u.invariants]),
  );
}

type PortalRows = Array<Record<string, unknown>>;

/** Unit key of a sync group: one provider session's portal rows, or one legacy row. */
function groupKey(group: PortalRows): string {
  const row = group[0] ?? {};
  return usageUnitKey({
    agentTool: String(row.agentTool),
    key: String(row.providerSessionId || row.sessionKey),
  });
}

/** Split a sync's usage groups into sent and held back. */
export function partitionHeldUsage(
  groups: PortalRows[],
  held: HeldUsageUnits,
): { sent: PortalRows[]; held: PortalRows[] } {
  return {
    sent: groups.filter((g) => !held.has(groupKey(g))),
    held: groups.filter((g) => held.has(groupKey(g))),
  };
}

/** The warning a sync prints for what it held back, with its cost. */
export function describeHeldUsage(
  repoPath: string,
  held: PortalRows[],
  units: HeldUsageUnits,
  limit = 5,
): string {
  const items = held
    .map((group) => ({
      key: groupKey(group).split('\0')[1],
      invariants: units.get(groupKey(group)) ?? [],
      cost: group.reduce((sum, row) => sum + (Number(row.costUsd) || 0), 0),
      tokens: group.reduce((sum, row) => sum + (Number(row.tokensTotal) || 0), 0),
    }))
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
  const total = items.reduce((sum, i) => sum + i.cost, 0);
  const shown = items
    .slice(0, limit)
    .map((i) => `${i.key} (${i.invariants.join('/')}, ${tokens(i.tokens)} tokens, ${usd(i.cost)})`)
    .join(', ');
  return (
    `${path.basename(repoPath)}: held back ${items.length} session(s) from HQ, ${usd(total)}, ` +
    `because their usage is counted twice: ${shown}` +
    (items.length > limit ? ` and ${items.length - limit} more` : '') +
    `. The rest of the repository was sent. Details: har control check-usage --repo ${repoPath}`
  );
}
