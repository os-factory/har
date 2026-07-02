'use client';

import { DataTable } from '@/components/data-table/data-table';
import { validationStageColumns } from '@/components/columns/validation-stage-columns';
import type { ValidationStageStatus } from '@/server/validation-stages';

export function ValidationStages({ stages }: { stages: ValidationStageStatus[] }) {
  if (stages.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No validation stages declared. Add `verificationStages` to `.har/stages.json` and re-sync
        the repository.
      </p>
    );
  }

  return (
    <DataTable
      columns={validationStageColumns}
      data={stages}
      getRowId={(stage) => stage.name}
      showPagination={false}
    />
  );
}
