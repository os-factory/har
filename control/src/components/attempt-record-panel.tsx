'use client';

import { useEffect, useState } from 'react';
import { AttemptRecordView } from '@/components/attempt-record';
import { Skeleton } from '@/components/ui/skeleton';
import { pickDefaultSession } from '@/lib/slot-timeline';
import type { AttemptRecord } from '@/server/attempt-record';

type State =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error'; message: string }
  | { status: 'ready'; record: AttemptRecord };

/** Loads and renders the record of one occupancy on demand (#348). */
export function AttemptRecordPanel({ repositoryId, occupancyKey }: { repositoryId: string; occupancyKey: string }) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    fetch(`/api/repos/${repositoryId}/attempts/${encodeURIComponent(occupancyKey)}`, { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 404) return setState({ status: 'missing' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setState({ status: 'ready', record: (await response.json()) as AttemptRecord });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
  }, [repositoryId, occupancyKey]);

  if (state.status === 'loading') {
    return (
      <div className="space-y-3" aria-busy data-testid="attempt-record-loading">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (state.status === 'missing') {
    return <p className="text-sm text-muted-foreground">The attempt behind this tree was not synchronized.</p>;
  }
  if (state.status === 'error') {
    return <p className="text-sm text-destructive">Could not load the attempt record: {state.message}</p>;
  }
  return <AttemptRecordView repositoryId={repositoryId} record={state.record} defaultExpandedId={pickDefaultSession(state.record.timeline)?.id ?? null} />;
}
