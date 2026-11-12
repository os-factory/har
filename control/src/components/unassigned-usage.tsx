import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatAgentToolLabel } from '@/lib/agent-tool';
import { timeAgo } from '@/lib/time';
import { formatCostUsd, formatTokens } from '@/lib/usage-models';

export interface UnassignedUsageRow {
  agentTool: string;
  sessionId: string;
  tokensTotal: number;
  costUsd: number | null;
  costSource: string | null;
  observationCount: number;
  /** False: only a provider-reported session total is known, no unit of it. */
  itemized: boolean;
  lastSeenAt: Date;
  /** Repository name, on cross-repo pages. */
  repository?: string;
}

/**
 * Usage spent with no slot binding in force — the main checkout (ADR 0003).
 * One row per agent session; never folded into any slot's cost.
 */
export function UnassignedUsage({ rows }: { rows: UnassignedUsageRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="unassigned-usage-empty">
        No usage outside a slot.
      </p>
    );
  }
  const total = rows.reduce<number | null>(
    (sum, row) => (row.costUsd == null ? sum : (sum ?? 0) + row.costUsd),
    null,
  );
  const showRepository = rows.some((row) => row.repository);
  return (
    <div className="space-y-2" data-testid="unassigned-usage">
      <p className="text-sm">
        <span className="font-semibold tabular-nums">{formatCostUsd(total)}</span>{' '}
        <span className="text-muted-foreground">
          across {rows.length} session{rows.length === 1 ? '' : 's'} in the main checkout / unassigned
        </span>
      </p>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {showRepository && <TableHead>Repository</TableHead>}
              <TableHead>Agent</TableHead>
              <TableHead>Session</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead>Last seen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={`${row.repository ?? ''}:${row.agentTool}:${row.sessionId}`}>
                {showRepository && <TableCell>{row.repository}</TableCell>}
                <TableCell>{formatAgentToolLabel(row.agentTool)}</TableCell>
                <TableCell className="font-mono text-xs" title={row.sessionId}>
                  {row.sessionId.length > 13 ? `${row.sessionId.slice(0, 12)}…` : row.sessionId}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.tokensTotal ? formatTokens(row.tokensTotal) : '—'}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCostUsd(row.costUsd)}
                  {!row.itemized ? (
                    <span className="block text-xs text-muted-foreground">reported session total, not itemized</span>
                  ) : row.costSource === 'estimated' ? (
                    <span className="block text-xs text-muted-foreground">estimated</span>
                  ) : null}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground" suppressHydrationWarning>
                  {timeAgo(row.lastSeenAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
