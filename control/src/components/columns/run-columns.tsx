'use client';

import { type ColumnDef } from '@tanstack/react-table';

import { Badge } from '@/components/ui/badge';

export interface RunRow {
  id: string;
  runId: string;
  stageId: string;
  agentId: number | null;
  status: string;
  trigger: string;
  durationMs: number | null;
  startedAt: Date;
}

export const runColumns: ColumnDef<RunRow>[] = [
  {
    accessorKey: 'startedAt',
    header: 'Time',
    cell: ({ row }) => (
      <span className="text-muted-foreground">
        {row.original.startedAt.toLocaleString()}
      </span>
    ),
  },
  {
    accessorKey: 'stageId',
    header: 'Stage',
  },
  {
    accessorKey: 'agentId',
    header: 'Agent',
    cell: ({ row }) => row.original.agentId ?? '—',
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => (
      <Badge
        variant={
          row.original.status === 'pass'
            ? 'success'
            : row.original.status === 'fail'
              ? 'destructive'
              : 'secondary'
        }
      >
        {row.original.status}
      </Badge>
    ),
  },
  {
    accessorKey: 'trigger',
    header: 'Trigger',
  },
  {
    accessorKey: 'durationMs',
    header: 'Duration',
    cell: ({ row }) =>
      row.original.durationMs != null ? `${row.original.durationMs}ms` : '—',
  },
];
