'use client';

import { useRouter } from 'next/navigation';

import { DataTable } from '@/components/data-table/data-table';
import {
  workUnitWorktreeColumns,
  type WorkUnitWorktreeRow,
} from '@/components/columns/work-unit-worktree-columns';

export function WorkUnitWorktreesTable({ rows }: { rows: WorkUnitWorktreeRow[] }) {
  const router = useRouter();

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No worktrees linked to this work unit yet.
      </p>
    );
  }

  return (
    <DataTable
      columns={workUnitWorktreeColumns}
      data={rows}
      getRowId={(row) => row.id}
      showPagination={rows.length > 10}
      pageSize={10}
      searchPlaceholder="Search worktrees…"
      searchAriaLabel="Search worktrees for this unit"
      emptyMessage="No worktrees match the search."
      onRowClick={(row) => {
        router.push(`/repos/${row.repoId}/slots/${row.agentId}`);
      }}
    />
  );
}
