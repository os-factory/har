import { Badge } from '@/components/ui/badge';
import { formatAgentToolLabel } from '@/lib/agent-tool';
import { formatModelId } from '@/lib/usage-models';

export interface TimelineUsageItem {
  id: string;
  kind: 'usage';
  sessionKey: string;
  agentTool: string;
  tokensTotal: number;
  costUsd: number | null;
  sources: string[];
  models: string[];
  at: Date;
}

export interface TimelineVerifyItem {
  id: string;
  kind: 'verify';
  runId: string;
  status: string;
  at: Date;
}

type TimelineItem = TimelineUsageItem | TimelineVerifyItem;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Compact timeline for usage rows and verify runs (OTEL events use SessionEventsTable). */
export function SessionTimeline({
  usageRows,
  verifyRuns,
}: {
  usageRows: TimelineUsageItem[];
  verifyRuns: TimelineVerifyItem[];
}) {
  const items: TimelineItem[] = [...usageRows, ...verifyRuns].sort(
    (a, b) => b.at.getTime() - a.at.getTime(),
  );

  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No usage or verify runs yet for this slot.
      </p>
    );
  }

  return (
    <ol className="space-y-3">
      {items.map((item) => (
        <li
          key={`${item.kind}-${item.id}`}
          className="flex flex-col gap-1 rounded-md border border-border/60 px-3 py-2 text-sm"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={item.kind === 'verify' ? 'default' : 'secondary'}>{item.kind}</Badge>
            <span className="text-xs text-muted-foreground" suppressHydrationWarning>
              {item.at.toLocaleString()}
            </span>
            {item.kind === 'usage' && (
              <>
                <Badge variant="outline">{formatAgentToolLabel(item.agentTool)}</Badge>
                <span className="tabular-nums text-muted-foreground">
                  {formatTokens(item.tokensTotal)} tokens
                  {item.costUsd != null ? ` · $${item.costUsd.toFixed(4)}` : ''}
                </span>
              </>
            )}
            {item.kind === 'verify' && (
              <Badge variant={item.status === 'pass' ? 'success' : 'destructive'}>
                {item.status}
              </Badge>
            )}
          </div>
          {item.kind === 'usage' && (
            <>
              <p className="truncate font-mono text-xs text-muted-foreground" title={item.sessionKey}>
                {item.sessionKey}
              </p>
              {item.models.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {item.models.map((model) => (
                    <Badge
                      key={model}
                      variant="secondary"
                      className="font-mono text-[10px]"
                      title={model}
                    >
                      {formatModelId(model)}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No model id recorded yet for this usage row.
                </p>
              )}
            </>
          )}
          {item.kind === 'verify' && (
            <p className="font-mono text-xs text-muted-foreground">run {item.runId}</p>
          )}
        </li>
      ))}
    </ol>
  );
}
