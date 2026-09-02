import { isPreDedupeUsage } from '@har/schemas';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { UsageTable, type UsageRow } from '@/components/usage-table';
import { PreDedupeTip } from '@/components/pre-dedupe-tip';
import { formatCostUsd, formatTokens } from '@/lib/usage-models';
import { listAllSessionUsage, summarizeUsageRows } from '@/server/usage';

export const dynamic = 'force-dynamic';

export default async function UsagePage() {
  const records = await listAllSessionUsage();
  const summary = summarizeUsageRows(records);

  const rows: UsageRow[] = records.map((row) => ({
    id: row.id,
    repositoryId: row.repositoryId,
    repositoryPath: row.repository.path,
    agentId: row.agentId,
    sessionKey: row.sessionKey,
    agentTool: row.agentTool,
    tokensTotal: Number(row.tokensTotal),
    costUsd: row.costUsd == null ? null : Number(row.costUsd),
    sources: row.sources,
    preDedupe: isPreDedupeUsage(row),
    lastSeenAt: row.lastSeenAt,
  }));

  const preDedupeCount = rows.filter((row) => row.preDedupe).length;

  return (
    <div className="min-w-0 space-y-6 overflow-x-hidden px-4 py-4 md:px-6 md:py-6">
      <div>
        <h2 className="text-2xl font-semibold">Cost</h2>
        <p className="text-sm text-muted-foreground">
          Cross-repo LLM token and cost rollup from OTEL ingest and harvest. Costs use agent-reported
          USD when available, otherwise{' '}
          <a
            href="https://github.com/pydantic/genai-prices"
            className="underline underline-offset-2"
            target="_blank"
            rel="noreferrer"
          >
            genai-prices
          </a>{' '}
          estimates from modelBreakdown. Prompt bodies are included by default (opt out:
          `har telemetry on --no-prompts`). Data stays in local SQLite.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Sessions</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{summary.sessionCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Tokens</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold tabular-nums">{formatTokens(summary.tokensTotal)}</p>
            {preDedupeCount > 0 && (
              <p className="text-xs text-muted-foreground">
                <PreDedupeTip>
                  {`includes ${preDedupeCount} of ${summary.sessionCount} sessions harvested pre-dedupe — reads high`}
                </PreDedupeTip>
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Estimated cost</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold tabular-nums">{formatCostUsd(summary.costUsd)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Last seen</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm" suppressHydrationWarning>
              {summary.lastSeenAt?.toLocaleString() ?? '—'}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Sessions</CardTitle>
          <CardDescription>
            Paginated usage sessions — search or filter, then open a slot for verify + timeline
          </CardDescription>
        </CardHeader>
        <CardContent className="min-w-0">
          <UsageTable rows={rows} />
        </CardContent>
      </Card>
    </div>
  );
}
