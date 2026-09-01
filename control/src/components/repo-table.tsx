'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { type ColumnFiltersState } from '@tanstack/react-table';
import { toast } from 'sonner';

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

async function unregisterRepos(rows: RepoRow[]): Promise<{ removed: number; failed: string[] }> {
  let removed = 0;
  const failed: string[] = [];
  for (const repo of rows) {
    const response = await fetch(`/api/repos/${encodeURIComponent(repo.id)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteWorktrees: false }),
    });
    if (response.ok) removed += 1;
    else failed.push(repo.path);
  }
  return { removed, failed };
}

export function RepoTable({ repos: allRepos }: { repos: RepoRow[] }) {
  const router = useRouter();
  const [globalFilter, setGlobalFilter] = useState('');
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [confirmUnregister, setConfirmUnregister] = useState(false);
  const [pending, setPending] = useState(false);

  const hiddenRepos = useMemo(() => allRepos.filter((r) => r.hidden), [allRepos]);
  const repos = useMemo(
    () => (showHidden ? allRepos : allRepos.filter((r) => !r.hidden)),
    [allRepos, showHidden],
  );

  async function handleUnregisterHidden() {
    setPending(true);
    try {
      const { removed, failed } = await unregisterRepos(hiddenRepos);
      if (failed.length > 0) {
        toast.error(`Removed ${removed}, could not remove ${failed.length}`, {
          description: failed.slice(0, 3).join(', '),
        });
      } else {
        toast.success(`Removed ${removed} hidden repositor${removed === 1 ? 'y' : 'ies'}`);
      }
      setConfirmUnregister(false);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

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

  if (allRepos.length === 0) {
    return (
      <div className="flex w-full flex-col gap-4 px-4 lg:px-6">
        <p className="text-sm text-muted-foreground">
          No repositories registered. Run <code className="rounded bg-muted px-1">har env init</code>{' '}
          or <code className="rounded bg-muted px-1">har control register</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 w-full flex-col gap-4 px-4 lg:px-6">
      {hiddenRepos.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm"
          data-testid="hidden-repos-bar"
        >
          <span className="text-muted-foreground">
            {hiddenRepos.length} hidden: temporary lab paths or paths that no longer exist.
          </span>
          <Button variant="outline" size="sm" onClick={() => setShowHidden((v) => !v)}>
            {showHidden ? 'Hide them' : 'Show them'}
          </Button>
          {confirmUnregister ? (
            <>
              <span className="text-muted-foreground">
                Removes {hiddenRepos.length} registration{hiddenRepos.length === 1 ? '' : 's'} from
                Mission Control. Nothing on disk is touched.
              </span>
              <Button size="sm" variant="destructive" disabled={pending} onClick={handleUnregisterHidden}>
                {pending ? 'Removing…' : 'Confirm'}
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirmUnregister(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setConfirmUnregister(true)}>
              Unregister hidden…
            </Button>
          )}
        </div>
      )}

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
