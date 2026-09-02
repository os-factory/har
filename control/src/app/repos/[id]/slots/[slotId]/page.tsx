import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ExternalLinkIcon } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { SlotTimeline } from '@/components/slot-timeline';
import { VerifySummary } from '@/components/verify-summary';
import { ValidationFlow } from '@/components/validation-flow';
import { getRepository } from '@/server/repositories';
import { listSessionEventsForSlot } from '@/server/session-events';
import { getSlotTimeline } from '@/server/slot-timeline';
import { getValidationStages } from '@/server/validation-stages';

export const dynamic = 'force-dynamic';

export default async function SlotDetailPage({
  params,
}: {
  params: Promise<{ id: string; slotId: string }>;
}) {
  const { id, slotId: slotIdRaw } = await params;
  const slotId = Number(slotIdRaw);
  if (!Number.isFinite(slotId)) notFound();

  const repo = await getRepository(id);
  if (!repo) notFound();

  const slot = repo.slots.find((s) => s.slotId === slotId);
  if (!slot) notFound();

  // #316: everything on this page is scoped to the slot's CURRENT occupancy. A slot
  // number is reused after complete/teardown; a working session is not. Earlier
  // occupants stay reachable in the collapsed section below the timeline.
  const [validation, timeline, events] = await Promise.all([
    getValidationStages(id, { agentId: slotId, since: slot.sessionCreatedAt, workDir: slot.workDir }),
    getSlotTimeline(id, slot),
    listSessionEventsForSlot(id, slotId),
  ]);

  const previewUrls = (slot.previewUrls ?? null) as Record<string, string> | null;
  const previewEntries = slot.active && previewUrls ? Object.entries(previewUrls) : [];
  const repoName = repo.path.split('/').pop() ?? repo.path;

  return (
    <div className="space-y-6 px-4 py-4 md:px-6 md:py-6">
      <div className="space-y-2">
        <Link href={`/repos/${id}`} className="text-sm text-muted-foreground hover:underline">
          ← {repoName}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-semibold">Slot {slotId}</h2>
          <Badge variant={slot.active ? 'success' : 'outline'}>{slot.active ? 'Active' : 'Idle'}</Badge>
          {slot.branch ? (
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs" title={slot.baseCommit ? `based on ${slot.baseCommit}` : undefined}>
              {slot.branch}
            </code>
          ) : null}
          {previewEntries.map(([label, url]) => (
            <a
              key={label}
              href={url}
              target="_blank"
              rel="noreferrer"
              title={url}
              className="inline-flex h-7 items-center gap-1 rounded-md border bg-background px-2 text-xs font-medium hover:bg-muted"
            >
              {label}
              <ExternalLinkIcon className="size-3 text-muted-foreground" aria-hidden />
            </a>
          ))}
        </div>
        {slot.purpose ? (
          <p className="text-sm" title={slot.purpose}>
            <span className="text-muted-foreground">Task: </span>
            {slot.purpose}
          </p>
        ) : null}
        <p className="break-all font-mono text-xs text-muted-foreground" data-testid="slot-worktree-path">
          {slot.worktreePath ?? slot.workDir ?? 'No worktree recorded'}
          {!slot.active && slot.worktreePath ? ' · last session' : ''}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Verify</CardTitle>
          <CardDescription>
            Verify runs of the current session in this slot. Earlier occupants of slot {slotId} are
            listed under the timeline and in the repository{' '}
            <Link href={`/repos/${id}?tab=history`} className="underline underline-offset-2">
              History
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          <VerifySummary validation={validation} validationHref={`/repos/${id}?tab=validation`} showStages={false} />
          {(validation?.stages.length ?? 0) > 0 && (
            <div className="mt-6" data-testid="slot-validation-flow">
              <ValidationFlow
                stages={validation?.stages ?? []}
                verifyRunCount={validation?.verifyRunCount ?? 0}
              />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
          <CardDescription>
            Agent sessions, verify runs, verified snapshots and commits of this session, newest first.
            Click a row to open it. Prompts and usage are stored locally; disable prompt capture with{' '}
            <code>har telemetry on --no-prompts</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SlotTimeline
            repositoryId={id}
            rows={timeline.current}
            previousRows={timeline.previous}
            previousLabel={`Earlier occupants of slot ${slotId}`}
            rawEvents={events.map((ev) => ({
              id: ev.id,
              eventName: ev.eventName,
              sessionKey: ev.sessionKey,
              agentTool: ev.agentTool,
              promptText: ev.promptText,
              responseText: ev.responseText,
              attributes: ev.attributes,
              rawTruncated: ev.rawTruncated,
              source: ev.source,
              timestamp: ev.timestamp,
            }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
