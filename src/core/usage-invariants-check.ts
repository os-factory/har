import * as path from 'path';
import { type UsageInvariantReport } from '../harness/schema';
import { syncFetch } from './sync-request';

/**
 * Client of Mission Control's usage invariants (`GET /api/usage/invariants`).
 * Mission Control holds the facts, so the checks run there; the CLI prints
 * the report (`har control check-usage`).
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
