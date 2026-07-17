'use client';

import { useMemo, useState } from 'react';
import { type ColumnFiltersState } from '@tanstack/react-table';

import { repoColumns, repoName, type RepoRow } from '@/components/columns/repo-columns';
import { DataTable } from '@/components/data-table/data-table';
import { Button } from '@/components/ui/button';

export type { RepoRow };

function countFilteredRepos(
  repos: RepoRow[],
  globalFilter: string,
  columnFilters: ColumnFiltersState,
): number {
  const profile = columnFilters.find((filter) => filter.id === 'profile')?.value as
    | string
    | undefined;
  const q = globalFilter.trim().toLowerCase();

  return repos.filter((repo) => {
    if (profile && repo.profile !== profile) return false;
    if (!q) return true;
    return (
      repoName(repo).toLowerCase().includes(q) ||
      repo.path.toLowerCase().includes(q) ||
      (repo.gitRemote?.toLowerCase().includes(q) ?? false)
    );
  }).length;
}

export function RepoTable({ repos }: { repos: RepoRow[] }) {
  const [globalFilter, setGlobalFilter] = useState('');
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);

  const profiles = useMemo(
    () => Array.from(new Set(repos.map((r) => r.profile).filter((p): p is string => !!p))).sort(),
    [repos],
  );

  const activeProfile =
    (columnFilters.find((filter) => filter.id === 'profile')?.value as string | undefined) ?? null;

  const filteredCount = useMemo(
    () => countFilteredRepos(repos, globalFilter, columnFilters),
    [repos, globalFilter, columnFilters],
  );

  if (repos.length === 0) {
    return (
      <div className="flex w-full flex-col gap-4 px-4 lg:px-6">
        <h1 className="text-base font-medium">Repositories</h1>
        <p className="text-sm text-muted-foreground">
          No repositories registered. Run <code className="rounded bg-muted px-1">har env init</code>{' '}
          or <code className="rounded bg-muted px-1">har control register</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 w-full flex-col gap-4 px-4 lg:px-6">
      <h1 className="text-base font-medium">Repositories</h1>

      {profiles.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={activeProfile === null ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => setColumnFilters([])}
          >
            All
          </Button>
          {profiles.map((profile) => (
            <Button
              key={profile}
              variant={activeProfile === profile ? 'secondary' : 'outline'}
              size="sm"
              onClick={() => setColumnFilters([{ id: 'profile', value: profile }])}
            >
              {profile}
            </Button>
          ))}
        </div>
      )}

      <DataTable
        columns={repoColumns}
        data={repos}
        getRowId={(repo) => repo.id}
        searchPlaceholder="Search repositories…"
        searchAriaLabel="Search repositories"
        emptyMessage={
          filteredCount === 0 ? 'No repositories match your filters.' : 'No results.'
        }
        globalFilter={globalFilter}
        onGlobalFilterChange={setGlobalFilter}
        globalFilterFn={(row, _columnId, filterValue) => {
          const q = String(filterValue).trim().toLowerCase();
          if (!q) return true;
          const repo = row.original;
          return (
            repoName(repo).toLowerCase().includes(q) ||
            repo.path.toLowerCase().includes(q) ||
            (repo.gitRemote?.toLowerCase().includes(q) ?? false)
          );
        }}
        columnFilters={columnFilters}
        onColumnFiltersChange={setColumnFilters}
        columnVisibility={{ profile: false }}
      />
    </div>
  );
}
