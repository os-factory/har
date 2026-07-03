'use client';

import { DataTable } from '@/components/data-table/data-table';
import { worktreeColumns, type WorktreeRow } from '@/components/columns/worktree-columns';

export type { WorktreeRow };

export function WorktreeGrid({ worktrees }: { worktrees: WorktreeRow[] }) {
  return (
    <DataTable
      columns={worktreeColumns}
      data={worktrees}
      getRowId={(row) => `${row.repoId}:${row.slotId}`}
      showPagination={worktrees.length > 10}
      emptyMessage="No active worktrees. Launch one with `har env launch <id>`."
    />
  );
}
