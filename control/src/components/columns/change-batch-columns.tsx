'use client';

import { type ColumnDef } from '@tanstack/react-table';

import { Badge } from '@/components/ui/badge';

interface ChangedFileEntry {
  path: string;
  status: string;
  oldPath?: string;
}

export interface ChangeBatchRow {
  id: string;
  treeHash: string;
  branch: string | null;
  agentId: number | null;
  status: string;
  full: boolean;
  runId: string | null;
  changedFiles: ChangedFileEntry[];
  commitSha: string | null;
  createdAt: Date;
}

function batchBadge(batch: ChangeBatchRow) {
  if (batch.status === 'pass' && batch.full) {
    return <Badge variant="success">Verified</Badge>;
  }
  if (batch.status === 'pass') {
    return <Badge variant="secondary">Partial verify</Badge>;
  }
  return <Badge variant="destructive">Failed</Badge>;
}

function filesSummary(files: ChangedFileEntry[]): string {
  return files
    .slice(0, 10)
    .map((f) => `${f.status} ${f.path}`)
    .join('\n');
}

export const changeBatchColumns: ColumnDef<ChangeBatchRow>[] = [
  {
    accessorKey: 'createdAt',
    header: 'Created',
    cell: ({ row }) => (
      <span className="text-muted-foreground">{row.original.createdAt.toLocaleString()}</span>
    ),
  },
  {
    accessorKey: 'treeHash',
    header: 'Batch',
    cell: ({ row }) => (
      <span className="font-mono">{row.original.treeHash.slice(0, 8)}</span>
    ),
  },
  {
    id: 'files',
    header: 'Files',
    cell: ({ row }) => (
      <span title={filesSummary(row.original.changedFiles)}>
        {row.original.changedFiles.length}
      </span>
    ),
  },
  {
    id: 'status',
    header: 'Status',
    cell: ({ row }) => batchBadge(row.original),
  },
  {
    accessorKey: 'runId',
    header: 'Run',
    cell: ({ row }) => (
      <span className="font-mono">
        {row.original.runId ? row.original.runId.slice(0, 8) : '—'}
      </span>
    ),
  },
  {
    accessorKey: 'commitSha',
    header: 'Commit',
    cell: ({ row }) => (
      <span className="font-mono">
        {row.original.commitSha ? row.original.commitSha.slice(0, 8) : '—'}
      </span>
    ),
  },
  {
    accessorKey: 'agentId',
    header: 'Agent',
    cell: ({ row }) => row.original.agentId ?? '—',
  },
];
