'use client';

import { type ColumnDef } from '@tanstack/react-table';

import { Badge } from '@/components/ui/badge';

export interface SlotRow {
  slotId: number;
  active: boolean;
  workDir: string | null;
  worktreePath: string | null;
  harnessUsage: string;
  lastRunAt: Date | null;
  lastVerifyStatus: string | null;
  lastBuildPass: boolean | null;
}

function usageBadge(usage: string) {
  switch (usage) {
    case 'mcp':
      return <Badge variant="success">MCP</Badge>;
    case 'cli':
      return <Badge variant="default">CLI</Badge>;
    case 'script':
      return <Badge variant="secondary">Script</Badge>;
    case 'bypass_warning':
      return <Badge variant="warning">Bypass?</Badge>;
    default:
      return <Badge variant="outline">None</Badge>;
  }
}

export const slotColumns: ColumnDef<SlotRow>[] = [
  {
    accessorKey: 'slotId',
    header: 'Slot',
    cell: ({ row }) => <span className="font-medium">{row.original.slotId}</span>,
  },
  {
    accessorKey: 'active',
    header: 'Status',
    cell: ({ row }) => (row.original.active ? '● Active' : '○ Idle'),
  },
  {
    id: 'worktree',
    header: 'Worktree',
    cell: ({ row }) => (
      <span className="max-w-xs truncate text-muted-foreground">
        {row.original.worktreePath ?? row.original.workDir ?? '—'}
      </span>
    ),
  },
  {
    accessorKey: 'harnessUsage',
    header: 'Harness',
    cell: ({ row }) => usageBadge(row.original.harnessUsage),
  },
  {
    accessorKey: 'lastVerifyStatus',
    header: 'Last verify',
    cell: ({ row }) =>
      row.original.lastVerifyStatus ? (
        <Badge
          variant={row.original.lastVerifyStatus === 'pass' ? 'success' : 'destructive'}
        >
          {row.original.lastVerifyStatus}
        </Badge>
      ) : (
        '—'
      ),
  },
  {
    accessorKey: 'lastBuildPass',
    header: 'Build',
    cell: ({ row }) => {
      if (row.original.lastBuildPass === true) {
        return <Badge variant="success">pass</Badge>;
      }
      if (row.original.lastBuildPass === false) {
        return <Badge variant="destructive">fail</Badge>;
      }
      return '—';
    },
  },
];
