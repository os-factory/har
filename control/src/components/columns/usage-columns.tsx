'use client';

import Link from 'next/link';
import { type ColumnDef } from '@tanstack/react-table';

import { Badge } from '@/components/ui/badge';
import { formatAgentToolLabel } from '@/lib/agent-tool';
import { PreDedupeTip } from '@/components/pre-dedupe-tip';
import { formatCostUsd, formatTokens } from '@/lib/usage-models';

export interface UsageRow {
  id: string;
  repositoryId: string;
  repositoryPath: string;
  agentId: number;
  sessionKey: string;
  agentTool: string;
  tokensTotal: number;
  costUsd: number | null;
  sources: string[];
  preDedupe: boolean;
  lastSeenAt: Date | string;
}

function repoLabel(path: string): string {
  return path.split('/').pop() ?? path;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export const usageColumns: ColumnDef<UsageRow>[] = [
  {
    id: 'repository',
    accessorFn: (row) => repoLabel(row.repositoryPath),
    header: 'Repository',
    cell: ({ row }) => (
      <Link
        href={`/repos/${row.original.repositoryId}`}
        title={row.original.repositoryPath}
        className="text-primary underline-offset-2 hover:underline"
      >
        {repoLabel(row.original.repositoryPath)}
      </Link>
    ),
  },
  {
    id: 'slot',
    accessorKey: 'agentId',
    header: 'Slot',
    cell: ({ row }) => (
      <Link
        href={`/repos/${row.original.repositoryId}/slots/${row.original.agentId}`}
        className="font-medium text-primary underline-offset-2 hover:underline"
      >
        {row.original.agentId}
      </Link>
    ),
  },
  {
    accessorKey: 'sessionKey',
    header: 'Session',
    cell: ({ row }) => (
      <span className="max-w-xs truncate font-mono text-xs" title={row.original.sessionKey}>
        {row.original.sessionKey}
      </span>
    ),
  },
  {
    accessorKey: 'agentTool',
    header: 'Agent',
    cell: ({ row }) => (
      <Badge variant="outline">{formatAgentToolLabel(row.original.agentTool)}</Badge>
    ),
    filterFn: (row, _columnId, filterValue) => {
      if (!filterValue) return true;
      return row.original.agentTool === filterValue;
    },
  },
  {
    accessorKey: 'tokensTotal',
    header: 'Tokens',
    cell: ({ row }) => (
      <span className="flex items-center gap-1 tabular-nums">
        {row.original.preDedupe ? <PreDedupeTip /> : null}
        {formatTokens(row.original.tokensTotal)}
      </span>
    ),
  },
  {
    id: 'cost',
    accessorFn: (row) => row.costUsd ?? -1,
    header: 'Cost',
    cell: ({ row }) => (
      <span className="tabular-nums">{formatCostUsd(row.original.costUsd)}</span>
    ),
  },
  {
    id: 'sources',
    accessorFn: (row) => row.sources.join(' '),
    header: 'Sources',
    enableSorting: false,
    cell: ({ row }) => (
      <div className="flex flex-wrap gap-1">
        {row.original.sources.map((source) => (
          <Badge key={source} variant="secondary">
            {source}
          </Badge>
        ))}
      </div>
    ),
  },
  {
    id: 'lastSeen',
    accessorFn: (row) => asDate(row.lastSeenAt).getTime(),
    header: 'Last seen',
    cell: ({ row }) => (
      <span className="text-muted-foreground" suppressHydrationWarning>
        {asDate(row.original.lastSeenAt).toLocaleString()}
      </span>
    ),
  },
];
