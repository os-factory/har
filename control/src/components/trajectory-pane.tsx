'use client';

import { useEffect, useState } from 'react';
import type { SerializedTrajectoryPage } from '@/lib/trajectory';
import { TrajectoryViewer } from '@/components/trajectory-viewer';

/**
 * Loads one agent session's trajectory on demand (when its timeline row is
 * expanded) and hands it to the full viewer. Keeps the slot page cheap: nothing
 * is fetched until the user opens a session.
 */
export function TrajectoryPane({
  repositoryId,
  agentId,
  sessionKey,
  agentTool,
}: {
  repositoryId: string;
  agentId: number;
  sessionKey: string;
  agentTool: string;
}) {
  const [page, setPage] = useState<SerializedTrajectoryPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const url = new URL(`/api/repos/${repositoryId}/slots/${agentId}/trajectory`, window.location.origin);
    url.searchParams.set('sessionKey', sessionKey);
    url.searchParams.set('agentTool', agentTool);
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
  }, [agentId, agentTool, repositoryId, sessionKey]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!page) return <p className="text-sm text-muted-foreground" aria-busy="true">Loading trajectory…</p>;

  const latest = page.records.at(-1);
  return (
    <TrajectoryViewer
      repositoryId={repositoryId}
      agentId={agentId}
      streams={[{ sessionKey, agentTool, latestTimestamp: latest?.eventTimestamp ?? new Date(0).toISOString() }]}
      initialPage={page}
    />
  );
}
