'use client';

import { DataTable } from '@/components/data-table/data-table';
import { runColumns, type RunRow } from '@/components/columns/run-columns';

export type { RunRow };

export function RunTimeline({ runs }: { runs: RunRow[] }) {
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">No runs synced yet.</p>;
  }

  return (
    <DataTable
      columns={runColumns}
      data={runs}
      getRowId={(run) => run.id}
      showPagination={runs.length > 10}
      searchPlaceholder="Search runs…"
      searchAriaLabel="Search runs"
    />
  );
}
