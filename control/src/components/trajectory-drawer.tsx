'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Check, Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { TrajectoryViewer } from '@/components/trajectory-viewer';
import { formatAgentToolLabel } from '@/lib/agent-tool';
import { describeSession, type TimelineRow } from '@/lib/slot-timeline';
import type { SerializedTrajectoryPage } from '@/lib/trajectory';

/** URL parameters that address a trajectory (and optionally one turn / tool call) so it can be shared. */
export const TRAJECTORY_PARAMS = {
  session: 'trajectory',
  tool: 'trajectoryTool',
  slot: 'trajectorySlot',
  node: 'trajectoryNode',
} as const;

export interface TrajectoryTarget {
  sessionKey: string;
  agentTool: string;
  agentId: number;
  nodeId?: string | null;
}

export function trajectoryHref(pathname: string, current: URLSearchParams, target: TrajectoryTarget | null): string {
  const params = new URLSearchParams(current);
  for (const key of Object.values(TRAJECTORY_PARAMS)) params.delete(key);
  if (target) {
    params.set(TRAJECTORY_PARAMS.session, target.sessionKey);
    params.set(TRAJECTORY_PARAMS.tool, target.agentTool);
    params.set(TRAJECTORY_PARAMS.slot, String(target.agentId));
    if (target.nodeId) params.set(TRAJECTORY_PARAMS.node, target.nodeId);
  }
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function readTrajectoryTarget(params: URLSearchParams): TrajectoryTarget | null {
  const sessionKey = params.get(TRAJECTORY_PARAMS.session);
  const agentTool = params.get(TRAJECTORY_PARAMS.tool);
  const agentId = Number(params.get(TRAJECTORY_PARAMS.slot));
  if (!sessionKey || !agentTool || !Number.isInteger(agentId) || agentId < 1) return null;
  return { sessionKey, agentTool, agentId, nodeId: params.get(TRAJECTORY_PARAMS.node) };
}

/** Hook used by timeline rows to open the drawer: it only rewrites the URL. */
export function useOpenTrajectory() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return useCallback(
    (target: TrajectoryTarget | null) => {
      router.replace(trajectoryHref(pathname, new URLSearchParams(searchParams.toString()), target), { scroll: false });
    },
    [pathname, router, searchParams],
  );
}

/**
 * Right-hand drawer that previews one agent session's trajectory. Fully URL-driven:
 * `?trajectory=<sessionKey>&trajectoryTool=<tool>&trajectorySlot=<n>[&trajectoryNode=<id>]`
 * opens it, and selecting a turn or tool call updates `trajectoryNode`, so the address
 * bar is always a shareable deep link to what is on screen.
 */
export function TrajectoryDrawer({ repositoryId, sessions = [] }: { repositoryId: string; sessions?: TimelineRow[] }) {
  const searchParams = useSearchParams();
  const open = useOpenTrajectory();
  const target = readTrajectoryTarget(new URLSearchParams(searchParams.toString()));
  const [page, setPage] = useState<SerializedTrajectoryPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const streamKey = target ? `${target.agentId}::${target.sessionKey}::${target.agentTool}` : null;
  // #339: label the drawer with what the session is — first prompt, then tool · model ·
  // duration · tokens · cost — instead of the IDE's session id.
  const sessionRow = target
    ? sessions.find(
        (row) => row.kind === 'session' && row.session?.sessionKey === target.sessionKey && row.session.agentTool === target.agentTool,
      )
    : undefined;

  useEffect(() => {
    if (!target) {
      setPage(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setPage(null);
    setError(null);
    const url = new URL(`/api/repos/${repositoryId}/slots/${target.agentId}/trajectory`, window.location.origin);
    url.searchParams.set('sessionKey', target.sessionKey);
    url.searchParams.set('agentTool', target.agentTool);
    fetch(url)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Trajectory request failed (${response.status})`);
        return response.json() as Promise<SerializedTrajectoryPage>;
      })
      .then((data) => {
        if (!cancelled) setPage(data);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Trajectory request failed');
      });
    return () => {
      cancelled = true;
    };
    // Re-fetch only when the stream changes, not when the selected node does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repositoryId, streamKey]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable: the address bar already holds the link */
    }
  };

  return (
    <Sheet open={target != null} onOpenChange={(next) => { if (!next) open(null); }}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-3 overflow-hidden p-4 sm:max-w-[min(1280px,92vw)]"
        data-testid="trajectory-drawer"
      >
        <SheetHeader className="space-y-1 pr-8 text-left">
          <div className="flex flex-wrap items-center gap-2">
            <SheetTitle className="max-w-[60ch] truncate" title={sessionRow?.title}>
              {sessionRow?.session?.firstPrompt ? sessionRow.title : 'Agent trajectory'}
            </SheetTitle>
            <Button variant="outline" size="sm" onClick={() => void copyLink()} data-testid="trajectory-copy-link">
              {copied ? <Check className="mr-1.5 size-3.5" /> : <Link2 className="mr-1.5 size-3.5" />}
              {copied ? 'Link copied' : 'Copy link'}
            </Button>
          </div>
          <SheetDescription data-testid="trajectory-session-label">
            {target
              ? [
                  sessionRow ? new Date(sessionRow.at).toLocaleString() : null,
                  formatAgentToolLabel(target.agentTool),
                  sessionRow ? describeSession(sessionRow) : null,
                  `slot ${target.agentId}`,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : ''}
            {' '}— click a turn or tool call to put it in the link.
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col">
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {!error && !page ? <p className="text-sm text-muted-foreground" aria-busy="true">Loading trajectory…</p> : null}
          {page && target ? (
            <TrajectoryViewer
              key={streamKey ?? undefined}
              repositoryId={repositoryId}
              agentId={target.agentId}
              streams={[{
                sessionKey: target.sessionKey,
                agentTool: target.agentTool,
                latestTimestamp: page.records.at(-1)?.eventTimestamp ?? new Date(0).toISOString(),
              }]}
              initialPage={page}
              selectedNodeId={target.nodeId ?? null}
              onSelectNode={(nodeId) => open({ ...target, nodeId })}
              fill
            />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
