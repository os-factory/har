'use client';

import { useEffect, useState } from 'react';

import { timeAgo } from '@/lib/time';

interface HealthPayload {
  ok?: boolean;
  lastSyncAt?: string | null;
  lastOtelAt?: string | null;
  otelReady?: boolean;
  repoCount?: number;
}

export function SidebarHealthStrip() {
  const [health, setHealth] = useState<HealthPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/health');
        if (!res.ok) return;
        const data = (await res.json()) as HealthPayload;
        if (!cancelled) setHealth(data);
      } catch {
        if (!cancelled) setHealth({ ok: false });
      }
    };
    void load();
    const id = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const mcOk = health?.ok !== false;
  const syncLabel = health?.lastSyncAt
    ? timeAgo(new Date(health.lastSyncAt))
    : 'never';
  const otelLabel = health?.lastOtelAt
    ? timeAgo(new Date(health.lastOtelAt))
    : health?.otelReady
      ? 'ready'
      : '—';

  return (
    <div
      data-testid="sidebar-health"
      className="rounded-md border border-sidebar-border bg-sidebar px-3 py-2 text-xs text-sidebar-foreground"
    >
      <p className="mb-1.5 font-medium">Health</p>
      <ul className="space-y-1">
        <li className="flex items-center justify-between gap-2">
          <span>MC</span>
          <span className={mcOk ? 'font-medium' : 'font-medium text-destructive'}>
            {health == null ? '…' : mcOk ? 'ok' : 'down'}
          </span>
        </li>
        <li className="flex items-center justify-between gap-2">
          <span>Sync</span>
          <span suppressHydrationWarning title={health?.lastSyncAt ?? undefined}>
            {health == null ? '…' : syncLabel}
          </span>
        </li>
        <li className="flex items-center justify-between gap-2">
          <span>OTEL</span>
          <span suppressHydrationWarning title={health?.lastOtelAt ?? undefined}>
            {health == null ? '…' : otelLabel}
          </span>
        </li>
      </ul>
    </div>
  );
}
