'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';

export interface UnregisterWorktreeRow {
  agentId: number;
  path: string;
  active: boolean;
  dirty: boolean | null;
}

interface UnregisterRepoButtonProps {
  repoId: string;
  repoPath: string;
  worktrees: UnregisterWorktreeRow[];
}

export function UnregisterRepoButton({
  repoId,
  repoPath,
  worktrees,
}: UnregisterRepoButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [deleteWorktrees, setDeleteWorktrees] = useState(false);
  const [pending, setPending] = useState(false);

  const existing = worktrees.filter((w) => Boolean(w.path));

  async function handleUnregister() {
    setPending(true);
    try {
      const response = await fetch(`/api/repos/${encodeURIComponent(repoId)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteWorktrees }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        worktrees?: { path: string; deleted: boolean; error?: string }[];
      };
      if (!response.ok) {
        throw new Error(payload.error || `Unregister failed (${response.status})`);
      }

      const deleted = (payload.worktrees ?? []).filter((w) => w.deleted).length;
      const failed = (payload.worktrees ?? []).filter((w) => !w.deleted && w.error);

      if (deleteWorktrees && failed.length > 0) {
        toast.warning(
          `Unregistered. ${deleted} worktree(s) removed; ${failed.length} need CLI cleanup.`,
          {
            description:
              'Docker Mission Control often cannot see host worktrees. Run: har control unregister --repo <path> --yes --delete-worktrees',
          },
        );
      } else if (deleteWorktrees) {
        toast.success(`Unregistered and removed ${deleted} worktree(s)`);
      } else {
        toast.success('Repository unregistered from Mission Control');
      }

      setOpen(false);
      router.push('/repos');
      router.refresh();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Unregister
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Unregister repository</SheetTitle>
            <SheetDescription>
              Removes this repository from Mission Control (runs, slots, and telemetry for
              this path). It will not be re-synced until you run{' '}
              <code className="text-xs">har control register</code>.
            </SheetDescription>
          </SheetHeader>

          <div className="mt-4 space-y-4">
            <p className="break-all font-mono text-xs text-muted-foreground">{repoPath}</p>

            {existing.length > 0 ? (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-sm font-medium">
                  {existing.length} session worktree{existing.length === 1 ? '' : 's'}
                </p>
                <ul className="max-h-40 space-y-1 overflow-y-auto text-xs text-muted-foreground">
                  {existing.map((wt) => (
                    <li key={`${wt.agentId}-${wt.path}`} className="break-all">
                      agent-{wt.agentId}: {wt.path}
                      {wt.dirty ? ' (dirty)' : ''}
                      {!wt.active ? ' (inactive)' : ''}
                    </li>
                  ))}
                </ul>
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox
                    checked={deleteWorktrees}
                    onCheckedChange={(value) => setDeleteWorktrees(value === true)}
                    className="mt-0.5"
                  />
                  <span>
                    Also delete these worktrees on disk
                    <span className="mt-1 block text-xs text-muted-foreground">
                      Packaged Mission Control may not see host paths — use the CLI unregister
                      command if deletion fails.
                    </span>
                  </span>
                </label>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No session worktrees recorded.</p>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => void handleUnregister()} disabled={pending}>
                {pending ? 'Unregistering…' : 'Unregister'}
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
