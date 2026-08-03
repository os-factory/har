'use client';

import { useMemo, useState } from 'react';
import { type ColumnFiltersState } from '@tanstack/react-table';
import { useRouter } from 'next/navigation';

import { usageColumns, type UsageRow } from '@/components/columns/usage-columns';
import { DataTable } from '@/components/data-table/data-table';
import { Button } from '@/components/ui/button';
import { formatAgentToolLabel } from '@/lib/agent-tool';
import { matchesUsageSearch } from '@/lib/usage-models';

export type { UsageRow };

export function UsageTable({ rows }: { rows: UsageRow[] }) {
  const router = useRouter();
  const [globalFilter, setGlobalFilter] = useState('');
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);

  const agents = useMemo(
    () => Array.from(new Set(rows.map((row) => row.agentTool).filter(Boolean))).sort(),
    [rows],
  );

  const activeAgent =
    (columnFilters.find((filter) => filter.id === 'agentTool')?.value as string | undefined) ??
    null;

  const filteredCount = useMemo(() => {
    return rows.filter((row) => {
      if (activeAgent && row.agentTool !== activeAgent) return false;
      return matchesUsageSearch(row, globalFilter, formatAgentToolLabel);
    }).length;
  }, [rows, globalFilter, activeAgent]);

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No usage recorded yet. Enable telemetry and sync, or run an agent with OTEL pointed at
        Mission Control.
      </p>
    );
  }

  return (
    <div className="min-w-0 space-y-3">
      {agents.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={activeAgent === null ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => setColumnFilters([])}
          >
            All
          </Button>
          {agents.map((agent) => (
            <Button
              key={agent}
              variant={activeAgent === agent ? 'secondary' : 'outline'}
              size="sm"
              onClick={() => setColumnFilters([{ id: 'agentTool', value: agent }])}
            >
              {formatAgentToolLabel(agent)}
            </Button>
          ))}
        </div>
      ) : null}

      <DataTable
        columns={usageColumns}
        data={rows}
        getRowId={(row) => row.id}
        pageSize={10}
        searchPlaceholder="Search repository, session, slot, agent…"
        searchAriaLabel="Search usage sessions"
        emptyMessage={
          filteredCount === 0 ? 'No sessions match your filters.' : 'No results.'
        }
        globalFilter={globalFilter}
        onGlobalFilterChange={setGlobalFilter}
        globalFilterFn={(row, _columnId, filterValue) =>
          matchesUsageSearch(row.original, String(filterValue ?? ''), formatAgentToolLabel)
        }
        columnFilters={columnFilters}
        onColumnFiltersChange={setColumnFilters}
        onRowClick={(row) => {
          router.push(`/repos/${row.repositoryId}/slots/${row.agentId}`);
        }}
      />
    </div>
  );
}
