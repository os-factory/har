'use client';

import Link from 'next/link';
import { type ColumnDef } from '@tanstack/react-table';

import { Badge } from '@/components/ui/badge';

export interface RepoRow {
  id: string;
  path: string;
  gitRemote: string | null;
  lastSyncAt: Date | null;
  runCount: number;
  slotCount: number;
  profile?: string;
}

export function repoName(repo: RepoRow): string {
  return repo.gitRemote ?? repo.path.split('/').pop() ?? repo.path;
}

export const repoColumns: ColumnDef<RepoRow>[] = [
  {
    accessorKey: 'name',
    header: 'Repository',
    cell: ({ row }) => {
      const repo = row.original;
      return (
        <>
          <Link href={`/repos/${repo.id}`} className="font-medium hover:underline">
            {repoName(repo)}
          </Link>
          {repo.profile && (
            <Badge variant="secondary" className="ml-2">
              {repo.profile}
            </Badge>
          )}
        </>
      );
    },
  },
  {
    accessorKey: 'path',
    header: 'Path',
    cell: ({ row }) => (
      <span className="max-w-md truncate text-muted-foreground">{row.original.path}</span>
    ),
  },
  {
    accessorKey: 'runCount',
    header: 'Runs',
  },
  {
    accessorKey: 'slotCount',
    header: 'Slots',
  },
  {
    accessorKey: 'profile',
    header: 'Profile',
    filterFn: (row, _columnId, value) => {
      if (!value) return true;
      return row.original.profile === value;
    },
  },
  {
    accessorKey: 'lastSyncAt',
    header: 'Last sync',
    cell: ({ row }) => (
      <span className="text-muted-foreground">
        {row.original.lastSyncAt ? new Date(row.original.lastSyncAt).toLocaleString() : '—'}
      </span>
    ),
  },
];
