'use client';

import Link from 'next/link';
import { type ColumnDef } from '@tanstack/react-table';

import { Badge } from '@/components/ui/badge';

export interface SlotRow {
  slotId: number;
  active: boolean;
  workDir: string | null;
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
  baseCommit: string | null;
  previewUrls: Record<string, string> | null;
  harnessUsage: string;
  lastRunAt: Date | null;
  lastVerifyStatus: string | null;
  lastBuildPass: boolean | null;
  detachedHead: boolean | null;
  dirty: boolean | null;
  ahead: number | null;
  behind: number | null;
  stale: boolean | null;
  purpose?: string | null;
  /** When set, Slot column links to the detail page. */
  repoId?: string;
  tokensTotal?: number | null;
  costUsd?: number | null;
  agentTools?: string[];
  usageSources?: string[];
}

function driftBadges(row: SlotRow) {
  if (!row.worktreePath) return <span className="text-muted-foreground">—</span>;
  const badges = [];
  if (row.detachedHead) badges.push(<Badge key="detached" variant="destructive">detached</Badge>);
  if (row.dirty) badges.push(<Badge key="dirty" variant="warning">dirty</Badge>);
  if (row.stale) {
    badges.push(
      <Badge key="stale" variant="warning">
        behind {row.behind ?? '?'}
      </Badge>,
    );
  }
  if ((row.ahead ?? 0) > 0) badges.push(<Badge key="ahead" variant="secondary">ahead {row.ahead}</Badge>);
  if (badges.length === 0) badges.push(<Badge key="fresh" variant="success">fresh</Badge>);
  return <div className="flex flex-wrap gap-1">{badges}</div>;
}

function usageBadge(usage: string) {
  switch (usage) {
    case 'mcp':
      return <Badge variant="success">MCP</Badge>;
    case 'cli':
      return <Badge variant="default">CLI</Badge>;
    case 'script':
      return <Badge variant="secondary">Script</Badge>;
    case 'bypass_warning':
      return <Badge variant="warning">Bypass?</Badge>;
    default:
      return <Badge variant="outline">None</Badge>;
  }
}

function formatTokens(n: number | null | undefined): string {
  if (n == null || n === 0) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCost(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export const slotColumns: ColumnDef<SlotRow>[] = [
  {
    accessorKey: 'slotId',
    header: 'Slot',
    cell: ({ row }) => {
      const id = row.original.slotId;
      if (row.original.repoId) {
        return (
          <Link
            href={`/repos/${row.original.repoId}/slots/${id}`}
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            {id}
          </Link>
        );
      }
      return <span className="font-medium">{id}</span>;
    },
  },
  {
    accessorKey: 'active',
    header: 'Status',
    cell: ({ row }) => (row.original.active ? '● Active' : '○ Idle'),
  },
  {
    id: 'worktree',
    header: 'Worktree',
    cell: ({ row }) => (
      <span className="max-w-xs truncate text-muted-foreground">
        {row.original.worktreePath ?? row.original.workDir ?? '—'}
      </span>
    ),
  },
  {
    id: 'branch',
    header: 'Branch',
    cell: ({ row }) =>
      row.original.branch ? (
        <span
          className="block max-w-56 truncate font-mono text-xs text-muted-foreground"
          title={
            row.original.baseBranch
              ? `based on ${row.original.baseBranch} @ ${row.original.baseCommit?.slice(0, 7) ?? '?'}`
              : undefined
          }
        >
          {row.original.branch}
        </span>
      ) : (
        '—'
      ),
  },
  {
    id: 'drift',
    header: 'Drift',
    cell: ({ row }) => driftBadges(row.original),
  },
  {
    id: 'agentTools',
    header: 'Agent',
    cell: ({ row }) => {
      const tools = row.original.agentTools ?? [];
      if (tools.length === 0) return <span className="text-muted-foreground">—</span>;
      return (
        <div className="flex flex-wrap gap-1">
          {tools.map((tool) => (
            <Badge key={tool} variant="outline">
              {tool === 'claude_code' ? 'Claude' : tool === 'codex' ? 'Codex' : tool}
            </Badge>
          ))}
        </div>
      );
    },
  },
  {
    id: 'tokens',
    header: 'Tokens',
    cell: ({ row }) => (
      <span className="tabular-nums text-muted-foreground">
        {formatTokens(row.original.tokensTotal)}
      </span>
    ),
  },
  {
    id: 'cost',
    header: 'Cost',
    cell: ({ row }) => (
      <span className="tabular-nums text-muted-foreground">
        {formatCost(row.original.costUsd)}
      </span>
    ),
  },
  {
    id: 'preview',
    header: 'Preview',
    cell: ({ row }) => {
      const urls = row.original.previewUrls;
      if (!row.original.active || !urls || Object.keys(urls).length === 0) return '—';
      return (
        <div className="flex flex-wrap gap-2">
          {Object.entries(urls).map(([label, url]) => (
            <a
              key={label}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-primary underline-offset-2 hover:underline"
            >
              {label}
            </a>
          ))}
        </div>
      );
    },
  },
  {
    accessorKey: 'harnessUsage',
    header: 'Harness',
    cell: ({ row }) => usageBadge(row.original.harnessUsage),
  },
  {
    accessorKey: 'lastVerifyStatus',
    header: 'Last verify',
    cell: ({ row }) =>
      row.original.lastVerifyStatus ? (
        <Badge
          variant={row.original.lastVerifyStatus === 'pass' ? 'success' : 'destructive'}
        >
          {row.original.lastVerifyStatus}
        </Badge>
      ) : (
        '—'
      ),
  },
  {
    accessorKey: 'lastBuildPass',
    header: 'Build',
    cell: ({ row }) => {
      if (row.original.lastBuildPass === true) {
        return <Badge variant="success">pass</Badge>;
      }
      if (row.original.lastBuildPass === false) {
        return <Badge variant="destructive">fail</Badge>;
      }
      return '—';
    },
  },
];
