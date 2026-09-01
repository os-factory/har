'use client';

import Link from 'next/link';
import { type ColumnDef } from '@tanstack/react-table';

import { Badge } from '@/components/ui/badge';
import { slotColumns, type SlotRow } from '@/components/columns/slot-columns';
import { timeAgo } from '@/lib/time';
import type { WorktreeCleanupRecommendation } from '@/lib/worktree-cleanup-plan';

export interface WorktreeRow extends SlotRow {
  repoId: string;
  repoPath: string;
  syncedAt: Date;
  sessionCreatedAt: Date | null;
  cleanupRecommendation: WorktreeCleanupRecommendation;
  cleanupReason: string;
  cleanupAgeDays?: number;
  /** Whether Mission Control can see the worktree path on disk. */
  onDisk?: boolean;
}

const SYNC_WARN_MS = 60 * 60 * 1000;

const repoColumn: ColumnDef<WorktreeRow> = {
  id: 'repository',
  accessorFn: (row) => row.repoPath.split('/').pop() ?? row.repoPath,
  header: 'Repository',
  cell: ({ row }) => (
    <Link
      href={`/repos/${row.original.repoId}`}
      title={row.original.repoPath}
      className="font-medium text-primary underline-offset-2 hover:underline"
    >
      {row.original.repoPath.split('/').pop() ?? row.original.repoPath}
    </Link>
  ),
};

const syncedColumn: ColumnDef<WorktreeRow> = {
  id: 'synced',
  accessorFn: (row) => row.syncedAt.getTime(),
  header: 'Synced',
  cell: ({ row }) => {
    const syncedAt = row.original.syncedAt;
    const outdated = Date.now() - syncedAt.getTime() > SYNC_WARN_MS;
    return (
      <span
        suppressHydrationWarning
        title={syncedAt.toLocaleString()}
        className={outdated ? 'text-amber-500' : 'text-muted-foreground'}
      >
        {timeAgo(syncedAt)}
      </span>
    );
  },
};

const onDiskColumn: ColumnDef<WorktreeRow> = {
  id: 'onDisk',
  accessorFn: (row) => (row.onDisk === false ? 0 : 1),
  header: 'On disk',
  cell: ({ row }) =>
    row.original.onDisk === false ? (
      <Badge variant="outline">missing</Badge>
    ) : (
      <Badge variant="secondary">yes</Badge>
    ),
};

const CLEANUP_LABEL: Record<WorktreeCleanupRecommendation, string> = {
  clear_missing: 'Path missing',
  teardown: 'Safe to tear down',
  review: 'Needs review',
  keep: 'Keep',
};

/** The slot registry can still say "active" after the worktree directory was deleted. When
 *  Mission Control can see that the path is gone, say so instead of showing a healthy state. */
const statusColumn: ColumnDef<WorktreeRow> = {
  accessorKey: 'active',
  header: 'Status',
  cell: ({ row }) => {
    if (row.original.onDisk === false) {
      return (
        <span title="Registered as active, but the worktree path no longer exists on disk">
          ● Active · path missing
        </span>
      );
    }
    return row.original.active ? '● Active' : '○ Idle';
  },
};

const cleanupColumn: ColumnDef<WorktreeRow> = {
  id: 'cleanup',
  accessorFn: (row) => row.cleanupRecommendation,
  header: 'Cleanup',
  cell: ({ row }) => {
    const rec = row.original.cleanupRecommendation;
    const variant =
      rec === 'teardown' || rec === 'clear_missing'
        ? 'success'
        : rec === 'review'
          ? 'warning'
          : 'secondary';
    return (
      <div className="space-y-1">
        <Badge variant={variant}>{CLEANUP_LABEL[rec]}</Badge>
        <p className="max-w-xs text-xs text-muted-foreground">{row.original.cleanupReason}</p>
      </div>
    );
  },
};

export const worktreeColumns: ColumnDef<WorktreeRow>[] = [
  repoColumn,
  cleanupColumn,
  onDiskColumn,
  ...(slotColumns as ColumnDef<WorktreeRow>[]).map((column) =>
    'accessorKey' in column && column.accessorKey === 'active' ? statusColumn : column,
  ),
  syncedColumn,
];
