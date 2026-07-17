'use client';

import { useState } from 'react';
import { ChangeBatchDiff } from '@/components/change-batch-diff';
import { DataTable } from '@/components/data-table/data-table';
import {
  changeBatchColumns,
  type ChangeBatchRow,
} from '@/components/columns/change-batch-columns';

export type { ChangeBatchRow };

export function ChangeBatchList({ repoId, batches }: { repoId: string; batches: ChangeBatchRow[] }) {
  const [selectedBatch, setSelectedBatch] = useState<ChangeBatchRow | null>(null);

  if (batches.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No change batches synced yet. Batches are recorded when `har env verify` runs.
      </p>
    );
  }

  const byBranch = new Map<string, ChangeBatchRow[]>();
  for (const batch of batches) {
    const key = batch.branch ?? '(no branch)';
    const group = byBranch.get(key) ?? [];
    group.push(batch);
    byBranch.set(key, group);
  }

  return (
    <div className="space-y-6">
      {[...byBranch.entries()].map(([branch, group]) => (
        <div key={branch}>
          <h3 className="mb-2 font-mono text-sm font-semibold text-muted-foreground">{branch}</h3>
          <DataTable
            columns={changeBatchColumns(setSelectedBatch)}
            data={group}
            getRowId={(batch) => batch.id}
            showPagination={group.length > 10}
            searchPlaceholder="Search change batches…"
            searchAriaLabel="Search change batches"
          />
        </div>
      ))}
      <ChangeBatchDiff
        repoId={repoId}
        batch={selectedBatch}
        open={selectedBatch !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedBatch(null);
        }}
      />
    </div>
  );
}
