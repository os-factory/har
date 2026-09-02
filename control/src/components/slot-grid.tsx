'use client';

import { useRouter } from 'next/navigation';

import { DataTable } from '@/components/data-table/data-table';
import { slotColumns, type SlotRow } from '@/components/columns/slot-columns';

export type { SlotRow };

export function SlotGrid({ slots }: { slots: SlotRow[] }) {
  const router = useRouter();

  return (
    <DataTable
      columns={slotColumns}
      data={slots}
      getRowId={(slot) => String(slot.slotId)}
      showPagination={slots.length > 10}
      searchPlaceholder="Search slots…"
      searchAriaLabel="Search slots"
      columnVisibility={{ harnessUsage: false, lastBuildPass: false, tokens: false, worktree: false }}
      onRowClick={(slot) => {
        if (!slot.repoId) return;
        router.push(`/repos/${slot.repoId}/slots/${slot.slotId}`);
      }}
    />
  );
}
