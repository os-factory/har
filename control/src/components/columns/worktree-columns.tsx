'use client';

import Link from 'next/link';
import { type ColumnDef } from '@tanstack/react-table';

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

/** #339: the Health sentence carries status, drift, on-disk and cleanup advice; no separate columns. */
export const worktreeColumns: ColumnDef<WorktreeRow>[] = [
  repoColumn,
  ...(slotColumns as ColumnDef<WorktreeRow>[]),
  syncedColumn,
];
