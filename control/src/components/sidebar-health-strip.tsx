'use client';

import { useEffect, useState } from 'react';

import { timeAgo } from '@/lib/time';

interface HealthPayload {
  ok?: boolean;
  lastSyncAt?: string | null;
  lastOtelAt?: string | null;
  otelReady?: boolean;
  repoCount?: number;
  mcp?: {
    probeable: boolean;
    status: 'recent' | 'stale' | 'none';
    lastActivityAt: string | null;
    source: 'run' | 'slot' | null;
    recentWindowMinutes: number;
  };
}

const MCP_TOOLTIP_BASE =
  'stdio MCP isn’t probeable from Mission Control; showing last MCP harness activity from sync';

function mcpDisplay(mcp: HealthPayload['mcp'] | undefined): {
  label: string;
  title: string;
} {
  if (!mcp) {
    return { label: '…', title: MCP_TOOLTIP_BASE };
  }

  const when = mcp.lastActivityAt ? timeAgo(new Date(mcp.lastActivityAt)) : null;
  const sourceHint =
    mcp.source === 'run'
      ? 'last MCP-triggered run'
      : mcp.source === 'slot'
        ? 'last slot with harnessUsage=mcp'
        : null;

  if (mcp.status === 'recent') {
    return {
      label: 'recent',
      title: `${MCP_TOOLTIP_BASE}. Recent within ${mcp.recentWindowMinutes}m (${sourceHint ?? 'activity'} ${when ?? ''}).`.trim(),
    };
  }

  if (mcp.status === 'stale') {
    return {
      label: 'stale',
      title: `${MCP_TOOLTIP_BASE}. Last activity ${when ?? 'unknown'} (${sourceHint ?? 'unknown source'}).`,
    };
  }

  return {
    label: 'none',
    title: `${MCP_TOOLTIP_BASE}. No MCP-triggered runs or mcp harnessUsage slots synced yet.`,
  };
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

  const syncLabel = health?.lastSyncAt
    ? timeAgo(new Date(health.lastSyncAt))
    : 'never';
  const otelLabel = health?.lastOtelAt
    ? timeAgo(new Date(health.lastOtelAt))
    : health?.otelReady
      ? 'ready'
      : '—';
  const mcp = mcpDisplay(health?.mcp);

  return (
    <div
      data-testid="sidebar-health"
      className="rounded-md border border-sidebar-border bg-sidebar px-3 py-2 text-xs text-sidebar-foreground"
    >
      <p className="mb-1.5 font-medium">Health</p>
      <ul className="space-y-1">
        <li className="flex items-center justify-between gap-2">
          <span>MCP</span>
          <span
            suppressHydrationWarning
            className="font-medium"
            title={mcp.title}
          >
            {health == null ? '…' : mcp.label}
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
