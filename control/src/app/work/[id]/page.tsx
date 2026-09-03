import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { WorkUnitRelatedLink } from '@har/schemas';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { WorkUnitAttempts } from '@/components/work-unit-attempts';
import { gitRemoteBrowseUrl } from '@/lib/git-remote-url';
import { getAttemptRecord, type AttemptRecord } from '@/server/attempt-record';
import { occupancyKeyForAttempt } from '@/server/occupancy';
import { getFactoryWorkUnitById } from '@/server/work-units';

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
  const browseUrl = gitRemoteBrowseUrl(unit.repository.gitRemote);
  const repoName =
    unit.repository.path.split('/').pop() ?? unit.repository.path;

  // #348: attempts are records. Slot numbers are text here — a slot is live data and may
  // hold unrelated work by now; only a live attempt links to its slot.
  const records = (
    await Promise.all(
      unit.attempts.map((attempt) => getAttemptRecord(unit.repository.id, occupancyKeyForAttempt(attempt.attemptId))),
    )
  ).filter((record): record is AttemptRecord => record != null);
  const verified = records.filter((record) => record.verification?.latestRun?.status === 'pass').length;

  const relatedLinks = (unit.relatedLinks as WorkUnitRelatedLink[] | null) ?? [];

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
            <Link
              href={`/repos/${unit.repository.id}`}
              className="font-medium text-primary underline-offset-2 hover:underline"
            >
              {repoName}
            </Link>
            <p className="break-all font-mono text-xs text-muted-foreground">
              {unit.repository.path}
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
            ) : unit.repository.gitRemote ? (
              <p className="break-all font-mono text-xs text-muted-foreground">
                {unit.repository.gitRemote}
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

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Attempts</CardTitle>
          <CardDescription>
            Every launch bound to this unit, newest first: how its tree was verified, what the agent did, and the
            commits it produced.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <WorkUnitAttempts repositoryId={unit.repository.id} records={records} />
        </CardContent>
      </Card>
    </div>
  );
}
