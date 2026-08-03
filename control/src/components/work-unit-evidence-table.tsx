'use client';

import { useMemo } from 'react';

import { DataTable } from '@/components/data-table/data-table';
import {
  createWorkUnitEvidenceColumns,
  type WorkUnitEvidenceRow,
} from '@/components/columns/work-unit-evidence-columns';

export function WorkUnitEvidenceTable({
  repoId,
  rows,
}: {
  repoId: string;
  rows: WorkUnitEvidenceRow[];
}) {
  const columns = useMemo(() => createWorkUnitEvidenceColumns(repoId), [repoId]);

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No execution evidence synchronized yet.</p>
    );
  }

  return (
    <DataTable
      columns={columns}
      data={rows}
      getRowId={(row) => row.id}
      showPagination={rows.length > 15}
      pageSize={15}
      searchPlaceholder="Search evidence…"
      searchAriaLabel="Search evidence"
      emptyMessage="No evidence matches the search."
    />
  );
}
