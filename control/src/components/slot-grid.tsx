'use client';

import { DataTable } from '@/components/data-table/data-table';
import { slotColumns, type SlotRow } from '@/components/columns/slot-columns';

export type { SlotRow };

export function SlotGrid({ slots }: { slots: SlotRow[] }) {
  return (
    <DataTable
      columns={slotColumns}
      data={slots}
      getRowId={(slot) => String(slot.slotId)}
      showPagination={slots.length > 10}
    />
  );
}
