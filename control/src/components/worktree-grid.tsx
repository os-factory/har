'use client';

import { useMemo } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';

import { DataTable } from '@/components/data-table/data-table';
import { worktreeColumns, type WorktreeRow } from '@/components/columns/worktree-columns';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export type { WorktreeRow };

function repoLabel(path: string): string {
  return path.split('/').pop() ?? path;
}

export function WorktreeGrid({ worktrees }: { worktrees: WorktreeRow[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedRepo = searchParams.get('repo') ?? 'all';

  const repositories = useMemo(() => {
    const byId = new Map<string, string>();
    for (const row of worktrees) {
      if (!byId.has(row.repoId)) byId.set(row.repoId, row.repoPath);
    }
    return [...byId.entries()]
      .map(([id, path]) => ({ id, path, label: repoLabel(path) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [worktrees]);

  const filtered = useMemo(() => {
    if (selectedRepo === 'all') return worktrees;
    return worktrees.filter((row) => row.repoId === selectedRepo);
  }, [worktrees, selectedRepo]);

  const setRepoFilter = (value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === 'all') params.delete('repo');
    else params.set('repo', value);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5 sm:max-w-xs sm:flex-1">
          <Label htmlFor="worktree-repo-filter" className="text-xs text-muted-foreground">
            Repository
          </Label>
          <Select value={selectedRepo} onValueChange={setRepoFilter}>
            <SelectTrigger id="worktree-repo-filter" aria-label="Filter by repository" className="w-full">
              <SelectValue placeholder="All repositories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All repositories</SelectItem>
              {repositories.map((repo) => (
                <SelectItem key={repo.id} value={repo.id}>
                  {repo.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <DataTable
        columns={worktreeColumns}
        data={filtered}
        getRowId={(row) => `${row.repoId}:${row.slotId}`}
        showPagination={filtered.length > 10}
        searchPlaceholder="Search worktrees…"
        searchAriaLabel="Search worktrees"
        emptyMessage={
          selectedRepo !== 'all' && worktrees.length > 0
            ? 'No active worktrees for this repository.'
            : 'No active worktrees. Launch one with `har env launch <id>`.'
        }
        onRowClick={(row) => {
          router.push(`/repos/${row.repoId}/slots/${row.slotId}`);
        }}
      />
    </div>
  );
}
