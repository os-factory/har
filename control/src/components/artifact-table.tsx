'use client';

import { DataTable } from '@/components/data-table/data-table';
import { artifactColumns, type ArtifactRow } from '@/components/columns/artifact-columns';

export function ArtifactTable({ artifacts }: { artifacts: ArtifactRow[] }) {
  if (artifacts.length === 0) {
    return <p className="text-sm text-muted-foreground">No artifacts found.</p>;
  }

  return (
    <DataTable
      columns={artifactColumns}
      data={artifacts}
      getRowId={(artifact) => artifact.relativePath}
      showPagination={artifacts.length > 10}
    />
  );
}
