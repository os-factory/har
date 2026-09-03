'use client';

import { ExternalLinkIcon } from 'lucide-react';

import Link from 'next/link';
import { type ColumnDef } from '@tanstack/react-table';

import { Badge } from '@/components/ui/badge';
import { formatAgentToolLabel } from '@/lib/agent-tool';
import { describeSlotHealth, describeSlotVerify, type HealthTone } from '@/lib/slot-health';

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
  /** Start of the latest verify run of the current occupancy (#339). */
  lastVerifyAt?: Date | null;
  lastBuildPass: boolean | null;
  detachedHead: boolean | null;
  dirty: boolean | null;
  ahead: number | null;
  behind: number | null;
  stale: boolean | null;
  purpose?: string | null;
  /** Whether Mission Control can see the worktree path on disk. */
  onDisk?: boolean;
  /** Cleanup advice folded into the health sentence for idle worktrees (Now page). */
  cleanupHint?: string | null;
  /** When set, Slot column links to the detail page. */
  repoId?: string;
  tokensTotal?: number | null;
  costUsd?: number | null;
  agentTools?: string[];
  usageSources?: string[];
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

// Shades chosen for WCAG AA contrast on both themes (the a11y spec runs axe on Now).
const TONE_CLASS: Record<HealthTone, string> = {
  pass: 'text-emerald-700 dark:text-emerald-400',
  warn: 'text-amber-800 dark:text-amber-400',
  fail: 'text-red-700 dark:text-red-400',
  neutral: 'text-muted-foreground',
};

/** Priority: slot, health, task, verify, agent, cost, preview, branch; tokens and path hidden by default. */
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
    id: 'health',
    accessorFn: (row) => describeSlotHealth(row).text,
    header: 'Health',
    cell: ({ row }) => {
      const health = describeSlotHealth(row.original);
      return (
        <span className={`block min-w-[14rem] max-w-sm text-sm ${TONE_CLASS[health.tone]}`} data-testid="slot-health" title={health.text}>
          {health.text}
        </span>
      );
    },
  },
  {
    id: 'purpose',
    accessorFn: (row) => row.purpose ?? '',
    header: 'Task',
    cell: ({ row }) =>
      row.original.purpose ? (
        <span className="block max-w-64 truncate" title={row.original.purpose}>
          {row.original.purpose}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    id: 'verify',
    accessorFn: (row) => row.lastVerifyAt?.getTime() ?? 0,
    header: 'Verify',
    cell: ({ row }) => {
      const verify = describeSlotVerify({ lastVerifyStatus: row.original.lastVerifyStatus, lastVerifyAt: row.original.lastVerifyAt ?? null });
      return (
        <span
          className={`whitespace-nowrap text-sm ${TONE_CLASS[verify.tone]}`}
          data-testid="slot-verify"
          title={row.original.lastVerifyAt ? row.original.lastVerifyAt.toLocaleString() : undefined}
          suppressHydrationWarning
        >
          {verify.text}
        </span>
      );
    },
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
];
