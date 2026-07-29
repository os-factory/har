import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { listAllSessionUsage, summarizeUsageRows } from '@/server/usage';

export const dynamic = 'force-dynamic';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export default async function UsagePage() {
  const rows = await listAllSessionUsage();
  const summary = summarizeUsageRows(rows);

  return (
    <div className="space-y-6 px-4 py-4 md:px-6 md:py-6">
      <div>
        <h2 className="text-2xl font-semibold">Usage</h2>
        <p className="text-sm text-muted-foreground">
          Cross-repo LLM token and cost rollup from OTEL ingest and harvest. Prompt bodies are
          included by default (opt out: `har telemetry on --no-prompts`). Data stays in local SQLite.
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
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Estimated cost</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold tabular-nums">
              {summary.costUsd == null ? '—' : `$${summary.costUsd.toFixed(4)}`}
            </p>
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

      <Card>
        <CardHeader>
          <CardTitle>Sessions</CardTitle>
          <CardDescription>Click through to the slot leaf for verify + timeline</CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No usage recorded yet. Enable telemetry and sync, or run an agent with OTEL pointed at
              Mission Control.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Repository</th>
                    <th className="py-2 pr-4 font-medium">Slot</th>
                    <th className="py-2 pr-4 font-medium">Session</th>
                    <th className="py-2 pr-4 font-medium">Agent</th>
                    <th className="py-2 pr-4 font-medium">Tokens</th>
                    <th className="py-2 pr-4 font-medium">Cost</th>
                    <th className="py-2 pr-4 font-medium">Sources</th>
                    <th className="py-2 font-medium">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-b border-border/60">
                      <td className="py-2 pr-4">
                        <Link
                          href={`/repos/${row.repositoryId}`}
                          className="text-primary underline-offset-2 hover:underline"
                          title={row.repository.path}
                        >
                          {row.repository.path.split('/').pop() ?? row.repository.path}
                        </Link>
                      </td>
                      <td className="py-2 pr-4">
                        <Link
                          href={`/repos/${row.repositoryId}/slots/${row.agentId}`}
                          className="font-medium text-primary underline-offset-2 hover:underline"
                        >
                          {row.agentId}
                        </Link>
                      </td>
                      <td
                        className="max-w-xs truncate py-2 pr-4 font-mono text-xs"
                        title={row.sessionKey}
                      >
                        {row.sessionKey}
                      </td>
                      <td className="py-2 pr-4">
                        <Badge variant="outline">
                          {row.agentTool === 'claude_code' ? 'Claude' : 'Codex'}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4 tabular-nums">
                        {formatTokens(Number(row.tokensTotal))}
                      </td>
                      <td className="py-2 pr-4 tabular-nums">
                        {row.costUsd == null ? '—' : `$${Number(row.costUsd).toFixed(4)}`}
                      </td>
                      <td className="py-2 pr-4">
                        <div className="flex flex-wrap gap-1">
                          {row.sources.map((s) => (
                            <Badge key={s} variant="secondary">
                              {s}
                            </Badge>
                          ))}
                        </div>
                      </td>
                      <td className="py-2 text-muted-foreground" suppressHydrationWarning>
                        {row.lastSeenAt.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
