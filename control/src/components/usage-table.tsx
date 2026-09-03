'use client';

import { useMemo, useState } from 'react';
import { type ColumnFiltersState } from '@tanstack/react-table';
import { useRouter } from 'next/navigation';

import { usageColumns, type UsageRow } from '@/components/columns/usage-columns';
import { DataTable } from '@/components/data-table/data-table';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatAgentToolLabel } from '@/lib/agent-tool';
import { USAGE_PERIODS, filterUsageRows, type UsagePeriodId } from '@/lib/usage-filters';
import { matchesUsageSearch } from '@/lib/usage-models';

export type { UsageRow };

const ALL = '__all__';

export function UsageTable({ rows }: { rows: UsageRow[] }) {
  const router = useRouter();
  const [globalFilter, setGlobalFilter] = useState('');
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [repositoryId, setRepositoryId] = useState<string>(ALL);
  const [period, setPeriod] = useState<UsagePeriodId>('all');

  const agents = useMemo(
    () => Array.from(new Set(rows.map((row) => row.agentTool).filter(Boolean))).sort(),
    [rows],
  );
  const repositories = useMemo(() => {
    const byId = new Map<string, string>();
    for (const row of rows) byId.set(row.repositoryId, row.repositoryPath.split('/').pop() ?? row.repositoryPath);
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const scoped = useMemo(
    () => filterUsageRows(rows, { repositoryId: repositoryId === ALL ? null : repositoryId, period }),
    [rows, repositoryId, period],
  );

  const activeAgent =
    (columnFilters.find((filter) => filter.id === 'agentTool')?.value as string | undefined) ??
    null;

  const filteredCount = useMemo(() => {
    return scoped.filter((row) => {
      if (activeAgent && row.agentTool !== activeAgent) return false;
      return matchesUsageSearch(row, globalFilter, formatAgentToolLabel);
    }).length;
  }, [scoped, globalFilter, activeAgent]);

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
      <div className="flex flex-wrap items-center gap-2">
        {repositories.length > 1 ? (
          <Select value={repositoryId} onValueChange={setRepositoryId}>
            <SelectTrigger className="h-8 w-[14rem] text-xs" aria-label="Filter usage by repository">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All repositories ({repositories.length})</SelectItem>
              {repositories.map(([id, name]) => (
                <SelectItem key={id} value={id}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Select value={period} onValueChange={(value) => setPeriod(value as UsagePeriodId)}>
          <SelectTrigger className="h-8 w-[11rem] text-xs" aria-label="Filter usage by period">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {USAGE_PERIODS.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {agents.length > 1 ? (
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by agent">
            <Button
              variant={activeAgent === null ? 'secondary' : 'outline'}
              size="sm"
              className="h-8"
              onClick={() => setColumnFilters([])}
            >
              All
            </Button>
            {agents.map((agent) => (
              <Button
                key={agent}
                variant={activeAgent === agent ? 'secondary' : 'outline'}
                size="sm"
                className="h-8"
                onClick={() => setColumnFilters([{ id: 'agentTool', value: agent }])}
              >
                {formatAgentToolLabel(agent)}
              </Button>
            ))}
          </div>
        ) : null}
      </div>

      <DataTable
        columns={usageColumns}
        data={scoped}
        getRowId={(row) => row.id}
        showPagination={false}
        maxBodyHeight="60vh"
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
