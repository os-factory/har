'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import { workUnitColumns, type WorkRow } from '@/components/columns/work-unit-columns';
import { DataTable } from '@/components/data-table/data-table';
import { Button } from '@/components/ui/button';
import { WORK_UNIT_STATES, type WorkUnitState } from '@/lib/work-unit-state';

export type { WorkRow };

export function WorkTable({ rows }: { rows: WorkRow[] }) {
  const router = useRouter();
  const [state, setState] = useState<WorkUnitState | 'all'>('all');

  const counts = useMemo(() => {
    const map = new Map<WorkUnitState, number>();
    for (const row of rows) map.set(row.state, (map.get(row.state) ?? 0) + 1);
    return map;
  }, [rows]);

  const visible = useMemo(
    () => (state === 'all' ? rows : rows.filter((row) => row.state === state)),
    [rows, state],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by state">
        <Button variant={state === 'all' ? 'secondary' : 'outline'} size="sm" onClick={() => setState('all')}>
          All <span className="ml-1 tabular-nums text-muted-foreground">{rows.length}</span>
        </Button>
        {WORK_UNIT_STATES.filter((s) => counts.get(s)).map((s) => (
          <Button key={s} variant={state === s ? 'secondary' : 'outline'} size="sm" onClick={() => setState(s)}>
            {s} <span className="ml-1 tabular-nums text-muted-foreground">{counts.get(s)}</span>
          </Button>
        ))}
      </div>
      <DataTable
        columns={workUnitColumns}
        data={visible}
        getRowId={(row) => row.id}
        showPagination={false}
        searchPlaceholder="Search work units…"
        searchAriaLabel="Search work units"
        emptyMessage="No work units match."
        onRowClick={(row) => router.push(`/work/${row.id}`)}
      />
    </div>
  );
}
