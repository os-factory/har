'use client';

import Link from 'next/link';
import { type ColumnDef } from '@tanstack/react-table';

import { Badge } from '@/components/ui/badge';
import type { WorkUnitWorktreeRow } from '@/lib/work-unit-evidence';

export type { WorkUnitWorktreeRow };

export const workUnitWorktreeColumns: ColumnDef<WorkUnitWorktreeRow>[] = [
  {
    accessorKey: 'agentId',
    header: 'Agent',
    cell: ({ row }) => (
      <Link
        href={`/repos/${row.original.repoId}/slots/${row.original.agentId}`}
        className="font-medium text-primary underline-offset-2 hover:underline"
      >
        {row.original.agentId}
      </Link>
    ),
  },
  {
    accessorKey: 'active',
    header: 'Status',
    cell: ({ row }) =>
      row.original.active ? (
        <Badge variant="success">active</Badge>
      ) : (
        <Badge variant="outline">idle</Badge>
      ),
  },
  {
    id: 'path',
    accessorFn: (row) => row.worktreePath ?? row.workDir ?? '',
    header: 'Worktree',
    cell: ({ row }) => {
      const path = row.original.worktreePath ?? row.original.workDir;
      if (!path) return <span className="text-muted-foreground">—</span>;
      return (
        <span className="max-w-md truncate font-mono text-xs text-muted-foreground" title={path}>
          {path}
        </span>
      );
    },
  },
  {
    accessorKey: 'branch',
    header: 'Branch',
    cell: ({ row }) =>
      row.original.branch ? (
        <span className="max-w-48 truncate font-mono text-xs" title={row.original.branch}>
          {row.original.branch}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    accessorKey: 'attemptId',
    header: 'Attempt',
    cell: ({ row }) =>
      row.original.attemptId ? (
        <span className="font-mono text-xs text-muted-foreground">
          {row.original.attemptId.slice(0, 8)}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    accessorKey: 'baseCommit',
    header: 'Base',
    cell: ({ row }) =>
      row.original.baseCommit ? (
        <span className="font-mono text-xs text-muted-foreground">
          {row.original.baseCommit.slice(0, 7)}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
];
