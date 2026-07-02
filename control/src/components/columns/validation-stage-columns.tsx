'use client';

import { type ColumnDef } from '@tanstack/react-table';

import { Badge } from '@/components/ui/badge';
import type { ValidationStageStatus } from '@/server/validation-stages';

function stageBadge(stage: ValidationStageStatus) {
  if (stage.lastStatus === 'pass') {
    return <Badge variant="success">Passed</Badge>;
  }
  if (stage.lastStatus === 'fail') {
    return <Badge variant="destructive">Failed</Badge>;
  }
  return <Badge variant="secondary">Not run</Badge>;
}

function passRate(stage: ValidationStageStatus): string {
  if (stage.runCount === 0) return '—';
  return `${stage.passCount}/${stage.runCount}`;
}

function duration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

export const validationStageColumns: ColumnDef<ValidationStageStatus>[] = [
  {
    id: 'index',
    header: '#',
    cell: ({ row }) => (
      <span className="text-muted-foreground">
        {row.original.declared ? row.index + 1 : '—'}
      </span>
    ),
  },
  {
    accessorKey: 'name',
    header: 'Stage',
    cell: ({ row }) => (
      <span className="font-mono">
        {row.original.name}
        {!row.original.declared && (
          <Badge variant="outline" className="ml-2">
            Undeclared
          </Badge>
        )}
      </span>
    ),
  },
  {
    id: 'lastResult',
    header: 'Last result',
    cell: ({ row }) => (
      <span
        title={
          row.original.lastStatus === 'fail'
            ? (row.original.lastOutput ?? undefined)
            : undefined
        }
      >
        {stageBadge(row.original)}
      </span>
    ),
  },
  {
    accessorKey: 'lastMs',
    header: 'Duration',
    cell: ({ row }) => duration(row.original.lastMs),
  },
  {
    id: 'passRate',
    header: 'Pass rate',
    cell: ({ row }) => passRate(row.original),
  },
  {
    accessorKey: 'lastRunAt',
    header: 'Last run',
    cell: ({ row }) =>
      row.original.lastRunAt ? (
        <span className="text-muted-foreground" title={row.original.lastRunId ?? undefined}>
          {row.original.lastRunAt.toLocaleString()}
        </span>
      ) : (
        '—'
      ),
  },
  {
    accessorKey: 'lastAgentId',
    header: 'Agent',
    cell: ({ row }) => row.original.lastAgentId ?? '—',
  },
];
