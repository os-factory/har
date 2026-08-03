'use client';

import Link from 'next/link';
import { type ColumnDef } from '@tanstack/react-table';

import { Badge } from '@/components/ui/badge';
import type { WorkUnitEvidenceRow } from '@/lib/work-unit-evidence';

export type { WorkUnitEvidenceRow };

export function createWorkUnitEvidenceColumns(
  repoId: string,
): ColumnDef<WorkUnitEvidenceRow>[] {
  return [
    {
      accessorKey: 'at',
      header: 'Time',
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-muted-foreground" suppressHydrationWarning>
          {row.original.at.toLocaleString()}
        </span>
      ),
    },
    {
      accessorKey: 'kind',
      header: 'Kind',
      cell: ({ row }) => <Badge variant="outline">{row.original.kind}</Badge>,
    },
    {
      accessorKey: 'title',
      header: 'Event',
      cell: ({ row }) => <span className="font-medium">{row.original.title}</span>,
    },
    {
      accessorKey: 'state',
      header: 'State',
      cell: ({ row }) => (
        <Badge
          variant={
            row.original.state === 'fail' || row.original.state === 'error'
              ? 'destructive'
              : row.original.state === 'pass' || row.original.state === 'verified'
                ? 'success'
                : 'secondary'
          }
        >
          {row.original.state}
        </Badge>
      ),
    },
    {
      accessorKey: 'agentId',
      header: 'Agent',
      cell: ({ row }) =>
        row.original.agentId != null ? (
          <Link
            href={`/repos/${repoId}/slots/${row.original.agentId}`}
            className="tabular-nums text-primary underline-offset-2 hover:underline"
          >
            {row.original.agentId}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      accessorKey: 'detail',
      header: 'Detail',
      cell: ({ row }) => (
        <span
          className="max-w-md truncate font-mono text-xs text-muted-foreground"
          title={row.original.detail}
        >
          {row.original.detail}
        </span>
      ),
    },
  ];
}
