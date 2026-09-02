import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { WorkUnitRelatedLink } from '@har/schemas';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { WorkUnitEvidenceTable } from '@/components/work-unit-evidence-table';
import { WorkUnitWorktreesTable } from '@/components/work-unit-worktrees-table';
import { gitRemoteBrowseUrl } from '@/lib/git-remote-url';
import {
  buildWorkUnitEvidenceRows,
  buildWorkUnitWorktreeRows,
} from '@/lib/work-unit-evidence';
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

  const agents = [
    ...new Map(
      [
        ...unit.slots.map((slot) => ({
          agentId: slot.slotId,
          active: slot.active,
          purpose: slot.purpose,
        })),
        ...unit.attempts.map((attempt) => ({
          agentId: attempt.agentId,
          active: unit.slots.some(
            (slot) => slot.slotId === attempt.agentId && slot.active,
          ),
          purpose: null as string | null,
        })),
      ].map((agent) => [agent.agentId, agent]),
    ).values(),
  ].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return a.agentId - b.agentId;
  });

  const worktrees = buildWorkUnitWorktreeRows({
    repoId: unit.repository.id,
    attempts: unit.attempts,
    slots: unit.slots,
  });

  const evidence = buildWorkUnitEvidenceRows({
    attempts: unit.attempts,
    runs: unit.runs,
    validationBindings: unit.validationBindings,
    validations: unit.validations,
  });

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

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
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
            <CardTitle className="text-base">Agent</CardTitle>
            <CardDescription>Slots that worked this unit</CardDescription>
          </CardHeader>
          <CardContent>
            {agents.length === 0 ? (
              <p className="text-sm text-muted-foreground">No agent linked yet.</p>
            ) : (
              <ul className="space-y-2">
                {agents.map((agent) => (
                  <li key={agent.agentId} className="flex flex-wrap items-center gap-2 text-sm">
                    <Link
                      href={`/repos/${unit.repository.id}/slots/${agent.agentId}`}
                      className="font-medium text-primary underline-offset-2 hover:underline"
                    >
                      Slot {agent.agentId}
                    </Link>
                    <Badge variant={agent.active ? 'success' : 'outline'}>
                      {agent.active ? 'active' : 'idle'}
                    </Badge>
                    {agent.purpose ? (
                      <span className="max-w-48 truncate text-xs text-muted-foreground" title={agent.purpose}>
                        {agent.purpose}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Attempts</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">{unit.attempts.length}</CardContent>
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
          <CardTitle>Worktrees</CardTitle>
          <CardDescription>
            Session worktrees and attempts bound to this work unit.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <WorkUnitWorktreesTable rows={worktrees} />
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Evidence</CardTitle>
          <CardDescription>
            Attempts, runs, and exact-tree validations in a searchable table.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <WorkUnitEvidenceTable repoId={unit.repository.id} rows={evidence} />
        </CardContent>
      </Card>
    </div>
  );
}
