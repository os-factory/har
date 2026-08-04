'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import posthog from 'posthog-js';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';

interface ResetMissionControlButtonProps {
  repositoryCount: number;
}

export function ResetMissionControlButton({ repositoryCount }: ResetMissionControlButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [scrubLocalHarness, setScrubLocalHarness] = useState(true);
  const [confirmText, setConfirmText] = useState('');
  const [pending, setPending] = useState(false);

  const confirmed = confirmText.trim() === 'RESET';

  async function handleReset() {
    if (!confirmed) return;
    setPending(true);
    try {
      const response = await fetch('/api/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'RESET', scrubLocalHarness }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        repositoriesDeleted?: number;
        scrubbed?: { deleted: boolean; error?: string }[];
      };
      if (!response.ok) {
        throw new Error(payload.error || `Reset failed (${response.status})`);
      }

      const scrubbed = payload.scrubbed ?? [];
      const failed = scrubbed.filter((row) => !row.deleted && row.error);
      const deletedRepos = payload.repositoriesDeleted ?? 0;

      if (scrubLocalHarness && failed.length > 0) {
        toast.warning(
          `Cleared ${deletedRepos} repositor${deletedRepos === 1 ? 'y' : 'ies'}. ${failed.length} local .har path(s) need CLI cleanup.`,
          {
            description:
              'Docker Mission Control often cannot see host paths. Run: har control reset --yes',
          },
        );
      } else {
        toast.success(
          `Mission Control reset — removed ${deletedRepos} repositor${deletedRepos === 1 ? 'y' : 'ies'}`,
        );
      }

      posthog.capture('mission_control_reset_completed', {
        repositories_deleted: deletedRepos,
        scrub_local_harness: scrubLocalHarness,
        local_scrub_failures: failed.length,
      });
      setOpen(false);
      setConfirmText('');
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
      <Button variant="destructive" onClick={() => setOpen(true)}>
        Clear all data…
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Clear Mission Control data</SheetTitle>
            <SheetDescription>
              Permanently deletes every registered repository, run, slot, validation, and
              telemetry row from this dashboard. Cloud / portal credentials are kept.
              Re-register afterward with <code className="text-xs">har control register</code>.
            </SheetDescription>
          </SheetHeader>

          <div className="mt-4 space-y-4">
            <p className="text-sm text-muted-foreground">
              Currently registered: <span className="font-medium text-foreground">{repositoryCount}</span>{' '}
              repositor{repositoryCount === 1 ? 'y' : 'ies'}.
            </p>

            <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
              <Checkbox
                checked={scrubLocalHarness}
                onCheckedChange={(value) => setScrubLocalHarness(value === true)}
                className="mt-0.5"
              />
              <span>
                Also delete local <code className="text-xs">.har/runs</code>,{' '}
                <code className="text-xs">validations</code>, <code className="text-xs">state</code>,
                and <code className="text-xs">slots</code> under each repo
                <span className="mt-1 block text-xs text-muted-foreground">
                  Prevents old harness history from reappearing on the next sync. Packaged Docker
                  Mission Control may not see host paths — use{' '}
                  <code className="text-xs">har control reset</code> if scrubbing fails.
                </span>
              </span>
            </label>

            <div className="space-y-2">
              <label htmlFor="reset-confirm" className="text-sm font-medium">
                Type <span className="font-mono">RESET</span> to confirm
              </label>
              <Input
                id="reset-confirm"
                value={confirmText}
                onChange={(event) => setConfirmText(event.target.value)}
                placeholder="RESET"
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setOpen(false);
                  setConfirmText('');
                }}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => void handleReset()}
                disabled={!confirmed || pending}
              >
                {pending ? 'Clearing…' : 'Clear all data'}
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
