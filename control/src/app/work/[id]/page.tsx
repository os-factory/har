import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { WorkUnitRelatedLink } from '@har/schemas';
import { AttemptHandoff } from '@/components/attempt-handoff';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { WorkUnitAttempts } from '@/components/work-unit-attempts';
import { WorkUnitFactoryRuns } from '@/components/work-unit-factory-runs';
import { gitRemoteBrowseUrl } from '@/lib/git-remote-url';
import { getAttemptRecord, type AttemptRecord } from '@/server/attempt-record';
import { occupancyKeyForAttempt } from '@/server/occupancy';
import { getFactoryWorkUnitById } from '@/server/work-units';
import { workUnitViewOf } from '@/server/work-unit-view';

export const dynamic = 'force-dynamic';

export default async function WorkUnitPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const unit = await getFactoryWorkUnitById(id);
  if (!unit) notFound();
  const outcome = unit.outcome as { decision?: string; decidedAt?: string } | null;
  const status = outcome?.decision ?? (unit.slot ? 'active' : 'open');
  const repository = unit.repository;
  const browseUrl = gitRemoteBrowseUrl(repository?.gitRemote ?? unit.repositoryUrl);
  const repoName = repository
    ? (repository.path.split('/').pop() ?? repository.path)
    : (unit.repositoryUrl?.split('/').pop() ?? 'Unregistered repository');

  // #348: attempts are records. Slot numbers are text here — a slot is live data and may
  // hold unrelated work by now; only a live attempt links to its slot.
  const [records, view] = await Promise.all([
    Promise.all(
      unit.attempts
        .filter((attempt) => attempt.repositoryId)
        .map((attempt) => getAttemptRecord(attempt.repositoryId as string, occupancyKeyForAttempt(attempt.attemptId))),
    ).then((list) => list.filter((record): record is AttemptRecord => record != null)),
    workUnitViewOf(unit),
  ]);
  const verified = records.filter((record) => record.verification?.latestRun?.status === 'pass').length;

  const relatedLinks = (unit.relatedLinks as WorkUnitRelatedLink[] | null) ?? [];
  const liveRecord = records.find((record) => record.attempt.live) ?? null;

  return (
    <div className="min-w-0 space-y-6 overflow-x-hidden px-4 py-4 md:px-6 md:py-6">
      <div>
        <Link href="/work" className="text-sm text-muted-foreground hover:underline">
          ← Work
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-semibold">{unit.title ?? unit.workUnitId}</h2>
          <Badge variant="secondary">{status}</Badge>
        </div>
        <p className="font-mono text-xs text-muted-foreground">{unit.workUnitId}</p>
        {(unit.sourceUrl || relatedLinks.length > 0) ? (
          <ul className="mt-2 space-y-1 text-sm">
            {unit.sourceUrl ? (
              <li>
                <a
                  href={unit.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline-offset-2 hover:underline"
                >
                  {unit.source ?? 'Source'}
                </a>
              </li>
            ) : null}
            {relatedLinks.map((link) => (
              <li key={link.url}>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline-offset-2 hover:underline"
                >
                  {link.label ?? link.source}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Repository</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {repository ? (
              <Link
                href={`/repos/${repository.id}`}
                className="font-medium text-primary underline-offset-2 hover:underline"
              >
                {repoName}
              </Link>
            ) : (
              <p className="font-medium">{repoName}</p>
            )}
            <p className="break-all font-mono text-xs text-muted-foreground">
              {repository?.path ?? unit.repositoryUrl ?? 'No repository URL'}
            </p>
            {browseUrl ? (
              <a
                href={browseUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-block text-xs text-primary underline-offset-2 hover:underline"
              >
                Open remote
              </a>
            ) : repository?.gitRemote ? (
              <p className="break-all font-mono text-xs text-muted-foreground">
                {repository.gitRemote}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Attempts</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{unit.attempts.length}</p>
            <p className="text-sm text-muted-foreground">
              {verified} verified{unit.slot ? ` · slot ${unit.slot.slotId} live` : ''}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Agent cost</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">
            ${Number(unit.usage.costUsd ?? 0).toFixed(4)}
          </CardContent>
        </Card>
      </div>

      {liveRecord ? (
        <Card className="min-w-0" data-testid="work-unit-handoff">
          <CardHeader>
            <CardTitle>Handoff</CardTitle>
            <CardDescription>
              The live attempt in slot {liveRecord.attempt.agentId}. Copy the next command — Mission Control
              cannot run har itself.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AttemptHandoff record={liveRecord} showHeading={false} />
          </CardContent>
        </Card>
      ) : null}

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Attempts</CardTitle>
          <CardDescription>
            Every launch bound to this unit, newest first: how its tree was verified, what the agent did, and the
            commits it produced.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <WorkUnitAttempts repositoryId={repository?.id ?? ''} records={records} />
        </CardContent>
      </Card>

      <Card className="min-w-0" data-testid="work-unit-v2">
        <CardHeader>
          <CardTitle>Factory runs</CardTitle>
          <CardDescription>
            What the CLI sent for this unit: each factory run with its stages, logs and artifacts (by sha256), the
            proof, the commits, and agent usage up to the run&apos;s end. Read from{' '}
            <code>/api/v2/work-units/{unit.workUnitId}</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <WorkUnitFactoryRuns attempts={view.attempts} />
        </CardContent>
      </Card>
    </div>
  );
}
