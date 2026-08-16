'use client';

import { useMemo, useState } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import type { RowSelectionState } from '@tanstack/react-table';
import { toast } from 'sonner';

import { DataTable } from '@/components/data-table/data-table';
import { worktreeColumns, type WorktreeRow } from '@/components/columns/worktree-columns';
import { isAutoCleanupRecommendation } from '@/lib/worktree-cleanup-plan';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';

export type { WorktreeRow };

function repoLabel(path: string): string {
  return path.split('/').pop() ?? path;
}

type CleanupFilter = 'all' | 'safe' | 'review';

export function WorktreeGrid({ worktrees }: { worktrees: WorktreeRow[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedRepo = searchParams.get('repo') ?? 'all';
  const cleanupFilter = (searchParams.get('cleanup') as CleanupFilter | null) ?? 'all';

  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [clearMissing, setClearMissing] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);

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
    let rows = worktrees;
    if (selectedRepo !== 'all') {
      rows = rows.filter((row) => row.repoId === selectedRepo);
    }
    if (cleanupFilter === 'safe') {
      rows = rows.filter((row) => isAutoCleanupRecommendation(row.cleanupRecommendation));
    } else if (cleanupFilter === 'review') {
      rows = rows.filter((row) => row.cleanupRecommendation === 'review');
    }
    return rows;
  }, [worktrees, selectedRepo, cleanupFilter]);

  const setCleanupFilter = (value: CleanupFilter) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === 'all') params.delete('cleanup');
    else params.set('cleanup', value);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    setRowSelection({});
  };

  const selectSafeCleanup = () => {
    const next: RowSelectionState = {};
    for (const row of filtered) {
      if (isAutoCleanupRecommendation(row.cleanupRecommendation)) {
        next[`${row.repoId}:${row.slotId}`] = true;
      }
    }
    setRowSelection(next);
  };

  const selectedRows = useMemo(() => {
    return filtered.filter((row) => rowSelection[`${row.repoId}:${row.slotId}`]);
  }, [filtered, rowSelection]);

  const setRepoFilter = (value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === 'all') params.delete('repo');
    else params.set('repo', value);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    setRowSelection({});
  };

  async function handleDelete() {
    if (selectedRows.length === 0) return;
    setPending(true);
    try {
      const response = await fetch('/api/worktrees', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clearMissing,
          worktrees: selectedRows.map((row) => ({
            repoId: row.repoId,
            slotId: row.slotId,
          })),
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        results?: {
          deleted: boolean;
          clearedFromDashboard: boolean;
          path: string;
          error?: string;
        }[];
      };
      if (!response.ok) {
        throw new Error(payload.error || `Delete failed (${response.status})`);
      }

      const results = payload.results ?? [];
      const deleted = results.filter((row) => row.deleted).length;
      const failed = results.filter((row) => !row.deleted && row.error);

      if (failed.length > 0) {
        toast.warning(
          `Removed ${deleted} worktree(s); ${failed.length} need host CLI cleanup.`,
          {
            description:
              'Packaged Mission Control often cannot see host paths. Run `har env teardown <id>` in each repo.',
          },
        );
      } else {
        toast.success(`Deleted ${deleted} worktree${deleted === 1 ? '' : 's'}`);
      }

      setConfirmOpen(false);
      setRowSelection({});
      router.refresh();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end">
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
          <div className="flex min-w-0 flex-col gap-1.5 sm:max-w-xs sm:flex-1">
            <Label htmlFor="worktree-cleanup-filter" className="text-xs text-muted-foreground">
              Cleanup
            </Label>
            <Select value={cleanupFilter} onValueChange={(value) => setCleanupFilter(value as CleanupFilter)}>
              <SelectTrigger id="worktree-cleanup-filter" aria-label="Filter by cleanup recommendation" className="w-full">
                <SelectValue placeholder="All recommendations" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All recommendations</SelectItem>
                <SelectItem value="safe">Safe to clean</SelectItem>
                <SelectItem value="review">Needs review</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <DataTable
        columns={worktreeColumns}
        data={filtered}
        getRowId={(row) => `${row.repoId}:${row.slotId}`}
        showPagination={filtered.length > 10}
        searchPlaceholder="Search worktrees…"
        searchAriaLabel="Search worktrees"
        enableRowSelection
        rowSelection={rowSelection}
        onRowSelectionChange={setRowSelection}
        emptyMessage={
          selectedRepo !== 'all' && worktrees.length > 0
            ? 'No session worktrees for this repository.'
            : 'No session worktrees. Launch one with `har env launch <id>`.'
        }
        onRowClick={(row) => {
          router.push(`/repos/${row.repoId}/slots/${row.slotId}`);
        }}
        toolbarExtra={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={selectSafeCleanup}>
              Select safe cleanup
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={selectedRows.length === 0}
              onClick={() => setConfirmOpen(true)}
            >
              Delete selected{selectedRows.length > 0 ? ` (${selectedRows.length})` : ''}
            </Button>
          </div>
        }
      />

      <Sheet open={confirmOpen} onOpenChange={setConfirmOpen}>
        <SheetContent className="sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Clean up session worktrees</SheetTitle>
            <SheetDescription>
              Deletes visible worktree directories and clears dashboard slot rows. For full host
              cleanup (PM2, databases, slot registry), run{' '}
              <code className="text-xs">har env cleanup</code> on the machine.
            </SheetDescription>
          </SheetHeader>

          <div className="mt-4 space-y-4">
            <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-3 text-xs text-muted-foreground">
              {selectedRows.map((row) => (
                <li key={`${row.repoId}:${row.slotId}`} className="break-all">
                  {repoLabel(row.repoPath)} · agent-{row.slotId} · {row.cleanupRecommendation}
                  {row.onDisk === false ? ' (not visible on disk)' : ''}
                  <span className="mt-0.5 block text-[11px]">{row.cleanupReason}</span>
                  <span className="mt-0.5 block font-mono">
                    {row.worktreePath ?? row.workDir ?? '—'}
                  </span>
                </li>
              ))}
            </ul>

            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={clearMissing}
                onCheckedChange={(value) => setClearMissing(value === true)}
                className="mt-0.5"
              />
              <span>
                Also clear dashboard rows when the path is not visible
                <span className="mt-1 block text-xs text-muted-foreground">
                  Useful for stale slots after host teardown. Packaged Docker Mission Control often
                  cannot see host worktrees — use <code className="text-xs">har env teardown</code>{' '}
                  there.
                </span>
              </span>
            </label>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={pending}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => void handleDelete()} disabled={pending}>
                {pending ? 'Deleting…' : `Delete ${selectedRows.length}`}
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
