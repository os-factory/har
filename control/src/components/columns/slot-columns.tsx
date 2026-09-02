'use client';

import { ExternalLinkIcon } from 'lucide-react';

import Link from 'next/link';
import { type ColumnDef } from '@tanstack/react-table';

import { Badge } from '@/components/ui/badge';
import { formatAgentToolLabel } from '@/lib/agent-tool';

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

function driftLabel(row: SlotRow): string {
  if (!row.worktreePath) return '';
  const parts: string[] = [];
  if (row.detachedHead) parts.push('detached');
  if (row.dirty) parts.push('dirty');
  if (row.stale) parts.push(`behind ${row.behind ?? '?'}`);
  if ((row.ahead ?? 0) > 0) parts.push(`ahead ${row.ahead}`);
  if (parts.length === 0) return 'fresh';
  return parts.join(' ');
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

/** Priority: status, purpose, drift, last verify, agent, tokens/cost, then path/preview. */
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
    id: 'purpose',
    accessorFn: (row) => row.purpose ?? '',
    header: 'Task',
    cell: ({ row }) =>
      row.original.purpose ? (
        <span className="max-w-40 truncate" title={row.original.purpose}>
          {row.original.purpose}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    id: 'drift',
    accessorFn: (row) => driftLabel(row),
    header: 'Drift',
    cell: ({ row }) => driftBadges(row.original),
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
    id: 'agentTools',
    accessorFn: (row) => (row.agentTools ?? []).join(' '),
    header: 'Agent',
    cell: ({ row }) => {
      const tools = row.original.agentTools ?? [];
      if (tools.length === 0) return <span className="text-muted-foreground">—</span>;
      return (
        <div className="flex flex-wrap gap-1">
          {tools.map((tool) => (
            <Badge key={tool} variant="outline">
              {formatAgentToolLabel(tool)}
            </Badge>
          ))}
        </div>
      );
    },
  },
  {
    id: 'tokens',
    accessorFn: (row) => row.tokensTotal ?? 0,
    header: 'Tokens',
    cell: ({ row }) => (
      <span className="tabular-nums text-muted-foreground">
        {formatTokens(row.original.tokensTotal)}
      </span>
    ),
  },
  {
    id: 'cost',
    accessorFn: (row) => row.costUsd ?? -1,
    header: 'Cost',
    cell: ({ row }) => (
      <span className="tabular-nums text-muted-foreground">
        {formatCost(row.original.costUsd)}
      </span>
    ),
  },
  {
    id: 'worktree',
    accessorFn: (row) => row.worktreePath ?? row.workDir ?? '',
    header: 'Path',
    cell: ({ row }) => (
      <span className="max-w-xs truncate text-muted-foreground" title={row.original.worktreePath ?? row.original.workDir ?? undefined}>
        {row.original.worktreePath ?? row.original.workDir ?? '—'}
      </span>
    ),
  },
  {
    id: 'preview',
    accessorFn: (row) =>
      row.previewUrls ? Object.entries(row.previewUrls).map(([k, v]) => `${k} ${v}`).join(' ') : '',
    header: 'Preview',
    enableSorting: false,
    cell: ({ row }) => {
      const urls = row.original.previewUrls;
      if (!row.original.active || !urls || Object.keys(urls).length === 0) return '—';
      return (
        <div className="flex flex-wrap gap-1">
          {Object.entries(urls).map(([label, url]) => (
            <a
              key={label}
              href={url}
              target="_blank"
              rel="noreferrer"
              title={url}
              className="inline-flex h-6 items-center gap-1 rounded-md border bg-background px-2 text-xs font-medium hover:bg-muted"
            >
              {label}
              <ExternalLinkIcon className="size-3 text-muted-foreground" aria-hidden />
            </a>
          ))}
        </div>
      );
    },
  },
  {
    id: 'branch',
    accessorFn: (row) => row.branch ?? '',
    header: 'Branch',
    cell: ({ row }) => {
      const { branch, baseBranch, baseCommit, active, worktreePath } = row.original;
      if (!branch) return '—';
      const lastSession = !active || !worktreePath;
      const baseHint = baseBranch
        ? `based on ${baseBranch} @ ${baseCommit?.slice(0, 7) ?? '?'}`
        : undefined;
      const title = lastSession
        ? ['last session branch', baseHint].filter(Boolean).join(' · ')
        : baseHint;
      return (
        <span
          className="block max-w-56 truncate font-mono text-xs text-muted-foreground"
          title={title}
        >
          {lastSession ? <span className="text-muted-foreground/80">last </span> : null}
          {branch}
        </span>
      );
    },
  },
  {
    accessorKey: 'harnessUsage',
    header: 'Harness',
    cell: ({ row }) => usageBadge(row.original.harnessUsage),
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
