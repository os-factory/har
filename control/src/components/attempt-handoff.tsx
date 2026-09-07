'use client';

import { ExternalLinkIcon } from 'lucide-react';
import { CopyCommand } from '@/components/copy-command';
import { matchingCommit } from '@/lib/handoff';
import { gitRemoteCommitUrl } from '@/lib/git-remote-url';
import { slotCommands } from '@/lib/slot-commands';
import { shortSha } from '@/lib/slot-timeline';
import type { AttemptRecord } from '@/server/attempt-record';

/**
 * What a developer copies to finish a *live* attempt (#340): verify + complete,
 * whether complete would be accepted, the branch, matching commit, and tracker/PR
 * links. Finished attempts have nothing to act on.
 */
export function AttemptHandoff({ record, showHeading = true }: { record: AttemptRecord; showHeading?: boolean }) {
  const { attempt, workUnit, verification, repositoryPath } = record;
  if (!attempt.live || attempt.agentId == null || !repositoryPath) return null;

  const latest = verification?.latestRun ?? null;
  const commit = matchingCommit(record.timeline);
  const commitUrl = gitRemoteCommitUrl(record.gitRemote, commit?.sha);
  const links = [
    ...(workUnit?.sourceUrl
      ? [{ url: workUnit.sourceUrl, label: workUnit.source ?? 'tracker' }]
      : []),
    ...(workUnit?.relatedLinks ?? []).map((link) => ({
      url: link.url,
      label: link.label ?? link.source,
    })),
  ];

  return (
    <section className="space-y-2" data-testid="attempt-handoff">
      {showHeading ? <h4 className="text-sm font-medium">Handoff</h4> : null}
      <p className="text-sm text-muted-foreground">
        {latest?.status === 'pass'
          ? 'The latest verify passed. Complete keeps the branch and frees the slot; push it and open the PR from your terminal.'
          : 'Run a full verify first — complete refuses a tree without a passing full validation.'}
      </p>
      <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Branch</dt>
          <dd className="mt-0.5">
            {attempt.branch ? (
              <code className="font-mono text-xs">{attempt.branch}</code>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Matching commit</dt>
          <dd className="mt-0.5">
            {commit ? (
              commitUrl ? (
                <a
                  href={commitUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-xs text-primary underline-offset-2 hover:underline"
                  data-testid="handoff-commit"
                >
                  {shortSha(commit.sha)}
                  <ExternalLinkIcon className="size-3" aria-hidden />
                </a>
              ) : (
                <code className="font-mono text-xs" data-testid="handoff-commit">
                  {shortSha(commit.sha)}
                </code>
              )
            ) : (
              <span className="text-muted-foreground">No commit recorded yet</span>
            )}
          </dd>
        </div>
        {links.length > 0 ? (
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Tracker / PR</dt>
            <dd className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1">
              {links.map((link) => (
                <a
                  key={link.url}
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
                  data-testid="handoff-link"
                >
                  {link.label}
                  <ExternalLinkIcon className="size-3" aria-hidden />
                </a>
              ))}
            </dd>
          </div>
        ) : null}
      </dl>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {slotCommands(repositoryPath, attempt.agentId, true)
          .filter((entry) => entry.label === 'Verify' || entry.label === 'Complete')
          .map((entry) => (
            <CopyCommand key={entry.label} label={entry.label} command={entry.command} />
          ))}
      </div>
    </section>
  );
}
