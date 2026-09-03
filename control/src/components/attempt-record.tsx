'use client';

import Link from 'next/link';
import { ExternalLinkIcon } from 'lucide-react';
import { SlotTimeline } from '@/components/slot-timeline';
import { Badge } from '@/components/ui/badge';
import { ValidationFlow } from '@/components/validation-flow';
import { shortSha } from '@/lib/slot-timeline';
import { timeAgo } from '@/lib/time';
import type { AttemptRecord } from '@/server/attempt-record';

function Fact({ label, children, breakAll = false }: { label: string; children: React.ReactNode; breakAll?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className={`mt-0.5 text-sm ${breakAll ? 'break-all' : 'break-words'}`}>{children}</dd>
    </div>
  );
}

/**
 * One occupancy, rendered as a record (#348): what it worked on, how the tree was
 * verified, and the timeline of everything the agent did — sessions open the
 * trajectory drawer from here. The only link to a slot is for a live attempt.
 */
export function AttemptRecordView({
  repositoryId,
  record,
  showWorkUnit = true,
  defaultExpandedId = null,
}: {
  repositoryId: string;
  record: AttemptRecord;
  showWorkUnit?: boolean;
  defaultExpandedId?: string | null;
}) {
  const { attempt, workUnit, verification } = record;
  const latest = verification?.latestRun ?? null;
  const stages = (verification?.stages ?? []).map((stage) => ({
    ...stage,
    lastRunAt: stage.lastRunAt ? new Date(stage.lastRunAt) : null,
  }));

  return (
    <div className="space-y-6" data-testid="attempt-record">
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {showWorkUnit ? (
          <Fact label="Work unit">
            {workUnit ? (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Link href={`/work/${workUnit.id}`} className="font-medium text-primary underline-offset-2 hover:underline">
                  {workUnit.title ?? workUnit.workUnitId}
                </Link>
                {workUnit.decision ? <Badge variant="secondary">{workUnit.decision}</Badge> : null}
                {workUnit.sourceUrl ? (
                  <a href={workUnit.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline">
                    {workUnit.source ?? 'tracker'}
                    <ExternalLinkIcon className="size-3" aria-hidden />
                  </a>
                ) : null}
                {workUnit.relatedLinks.map((link) => (
                  <a key={link.url} href={link.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline">
                    {link.label ?? link.source}
                    <ExternalLinkIcon className="size-3" aria-hidden />
                  </a>
                ))}
              </span>
            ) : (
              <span className="text-muted-foreground">Not bound to a work unit</span>
            )}
          </Fact>
        ) : null}
        <Fact label="Attempt">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {attempt.agentId != null ? <span>Slot {attempt.agentId}</span> : <span className="text-muted-foreground">—</span>}
            {attempt.startedAt ? (
              <span className="text-muted-foreground" title={new Date(attempt.startedAt).toLocaleString()} suppressHydrationWarning>
                started {timeAgo(attempt.startedAt)}
              </span>
            ) : null}
            {attempt.live && attempt.agentId != null ? (
              <Link
                href={`/repos/${repositoryId}/slots/${attempt.agentId}`}
                className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
                data-testid="attempt-live-slot"
              >
                <Badge variant="success">live</Badge>
                open slot
              </Link>
            ) : null}
          </span>
        </Fact>
        <Fact label="Branch" breakAll>
          {attempt.branch ? <code className="font-mono text-xs">{attempt.branch}</code> : <span className="text-muted-foreground">—</span>}
          {attempt.baseCommit ? (
            <span className="ml-2 font-mono text-xs text-muted-foreground" title={attempt.baseCommit}>
              from {shortSha(attempt.baseCommit)}
            </span>
          ) : null}
        </Fact>
        <Fact label="Worktree" breakAll>
          {attempt.worktreePath ? (
            <code className="font-mono text-xs text-muted-foreground">{attempt.worktreePath}</code>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </Fact>
      </dl>

      <section className="space-y-3">
        <h4 className="text-sm font-medium">Verification</h4>
        {latest ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm" data-testid="attempt-verify-summary">
            <Badge variant={latest.status === 'pass' ? 'success' : 'destructive'}>
              {latest.status === 'pass' ? 'Verified' : `Verify ${latest.status}`}
            </Badge>
            <span className="text-muted-foreground" title={new Date(latest.startedAt).toLocaleString()} suppressHydrationWarning>
              {timeAgo(latest.startedAt)}
            </span>
            <span className="text-muted-foreground">
              {verification?.verifyRunCount ?? 0} verify run{verification?.verifyRunCount === 1 ? '' : 's'}
            </span>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No verify run recorded for this attempt.</p>
        )}
        {stages.length > 0 ? (
          <div data-testid="attempt-validation-flow">
            <ValidationFlow stages={stages} verifyRunCount={verification?.verifyRunCount ?? 0} />
          </div>
        ) : null}
      </section>

      <section className="space-y-3">
        <h4 className="text-sm font-medium">Timeline</h4>
        <SlotTimeline
          repositoryId={repositoryId}
          rows={record.timeline}
          defaultExpandedId={defaultExpandedId}
          emptyMessage="Nothing recorded for this attempt yet."
        />
      </section>
    </div>
  );
}
