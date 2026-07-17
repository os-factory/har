import { Badge } from '@/components/ui/badge';

export interface TimelineUsageItem {
  id: string;
  kind: 'usage';
  sessionKey: string;
  agentTool: string;
  tokensTotal: number;
  costUsd: number | null;
  sources: string[];
  at: Date;
}

export interface TimelineVerifyItem {
  id: string;
  kind: 'verify';
  runId: string;
  status: string;
  at: Date;
}

export interface TimelineEventItem {
  id: string;
  kind: 'event';
  eventName: string;
  sessionKey: string;
  agentTool: string;
  promptText: string | null;
  responseText: string | null;
  at: Date;
}

type TimelineItem = TimelineUsageItem | TimelineVerifyItem | TimelineEventItem;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function trunc(text: string | null | undefined, max = 160): string | null {
  if (!text) return null;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export function SessionTimeline({
  usageRows,
  verifyRuns,
  events,
}: {
  usageRows: TimelineUsageItem[];
  verifyRuns: TimelineVerifyItem[];
  events: TimelineEventItem[];
}) {
  const items: TimelineItem[] = [...usageRows, ...verifyRuns, ...events].sort(
    (a, b) => b.at.getTime() - a.at.getTime(),
  );

  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No session activity yet. Usage rows and verify runs appear here after sync; OTEL log
        events appear when agents export logs to Mission Control.
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
            <Badge variant={item.kind === 'verify' ? 'default' : item.kind === 'event' ? 'outline' : 'secondary'}>
              {item.kind}
            </Badge>
            <span className="text-xs text-muted-foreground" suppressHydrationWarning>
              {item.at.toLocaleString()}
            </span>
            {item.kind === 'usage' && (
              <>
                <Badge variant="outline">
                  {item.agentTool === 'claude_code' ? 'Claude' : 'Codex'}
                </Badge>
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
            {item.kind === 'event' && (
              <>
                <span className="font-mono text-xs">{item.eventName}</span>
                <Badge variant="outline">
                  {item.agentTool === 'claude_code' ? 'Claude' : item.agentTool}
                </Badge>
              </>
            )}
          </div>
          {item.kind === 'usage' && (
            <p className="truncate font-mono text-xs text-muted-foreground" title={item.sessionKey}>
              {item.sessionKey}
            </p>
          )}
          {item.kind === 'verify' && (
            <p className="font-mono text-xs text-muted-foreground">run {item.runId}</p>
          )}
          {item.kind === 'event' && (
            <div className="space-y-1 text-xs text-muted-foreground">
              <p className="truncate font-mono" title={item.sessionKey}>
                {item.sessionKey}
              </p>
              {item.promptText && (
                <p title={item.promptText}>
                  <span className="font-medium text-foreground">prompt: </span>
                  {trunc(item.promptText)}
                </p>
              )}
              {item.responseText && (
                <p title={item.responseText}>
                  <span className="font-medium text-foreground">response: </span>
                  {trunc(item.responseText)}
                </p>
              )}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
