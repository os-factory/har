'use client';

import Link from 'next/link';
import { type ColumnDef } from '@tanstack/react-table';

import { Badge } from '@/components/ui/badge';
import { timeAgo } from '@/lib/time';
import { formatDurationMs, type WorkUnitState } from '@/lib/work-unit-state';

export interface WorkRow {
  id: string;
  workUnitId: string;
  title: string | null;
  repoId: string;
  repoName: string;
  repoPath: string;
  state: WorkUnitState;
  activeSlotId: number | null;
  attempts: number;
  validations: number;
  durationMs: number;
  costUsd: number | null;
  updatedAt: Date;
  sourceUrl: string | null;
}

export const STATE_VARIANT: Record<WorkUnitState, 'success' | 'warning' | 'destructive' | 'secondary' | 'outline' | 'default'> = {
  active: 'default',
  verified: 'success',
  failed: 'destructive',
  pending: 'warning',
  completed: 'secondary',
  abandoned: 'outline',
};

export const workUnitColumns: ColumnDef<WorkRow>[] = [
  {
    id: 'title',
    accessorFn: (row) => `${row.title ?? ''} ${row.workUnitId}`,
    header: 'Work unit',
    cell: ({ row }) => (
      <div className="min-w-0 max-w-md">
        <Link href={`/work/${row.original.id}`} className="block truncate font-medium underline-offset-2 hover:underline" title={row.original.title ?? row.original.workUnitId}>
          {row.original.title ?? row.original.workUnitId}
        </Link>
        {row.original.title && (
          <span className="font-mono text-xs text-muted-foreground">{row.original.workUnitId}</span>
        )}
      </div>
    ),
  },
  {
    accessorKey: 'state',
    header: 'State',
    cell: ({ row }) => <Badge variant={STATE_VARIANT[row.original.state]}>{row.original.state}</Badge>,
  },
  {
    accessorKey: 'repoName',
    header: 'Repository',
    cell: ({ row }) => (
      <Link href={`/repos/${row.original.repoId}`} title={row.original.repoPath} className="underline-offset-2 hover:underline">
        {row.original.repoName}
      </Link>
    ),
  },
  {
    accessorKey: 'activeSlotId',
    header: 'Slot',
    cell: ({ row }) =>
      row.original.activeSlotId != null ? (
        <Link href={`/repos/${row.original.repoId}/slots/${row.original.activeSlotId}`} className="underline-offset-2 hover:underline">
          {row.original.activeSlotId}
        </Link>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  { accessorKey: 'attempts', header: 'Attempts', cell: ({ row }) => <span className="tabular-nums">{row.original.attempts}</span> },
  { accessorKey: 'validations', header: 'Validations', cell: ({ row }) => <span className="tabular-nums">{row.original.validations}</span> },
  {
    accessorKey: 'durationMs',
    header: 'Run time',
    cell: ({ row }) => <span className="tabular-nums">{formatDurationMs(row.original.durationMs)}</span>,
  },
  {
    accessorKey: 'costUsd',
    header: 'Cost',
    cell: ({ row }) => {
      const cost = row.original.costUsd;
      if (cost == null || cost === 0) return <span className="text-muted-foreground">—</span>;
      return <span className="tabular-nums">${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}</span>;
    },
  },
  {
    accessorKey: 'updatedAt',
    header: 'Updated',
    cell: ({ row }) => (
      <span suppressHydrationWarning title={row.original.updatedAt.toLocaleString()} className="text-muted-foreground">
        {timeAgo(row.original.updatedAt)}
      </span>
    ),
  },
];
