import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ArtifactsDrawer } from '@/components/artifacts-drawer';
import { ChangeBatchList } from '@/components/change-batch-list';
import { SessionHistoryPanel } from '@/components/session-history-panel';
import { RunTimeline } from '@/components/run-timeline';
import { SlotGrid } from '@/components/slot-grid';
import { UnregisterRepoButton } from '@/components/unregister-repo-button';
import { ValidationPipeline } from '@/components/validation-pipeline';
import { ValidationStages } from '@/components/validation-stages';
import { VerifySparkline } from '@/components/verify-sparkline';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { getRepository, getRepositoryHealth, getVerificationTrend } from '@/server/repositories';
import { listLineBoards } from '@/server/lines';
import { listChangeBatches } from '@/server/change-batches';
import { getSessionHistory } from '@/server/session-history';
import { getValidationStages } from '@/server/validation-stages';
import { listArtifactFiles } from '@/server/artifacts';
import { listSessionUsageForRepo } from '@/server/usage';
import { timeAgo } from '@/lib/time';

export const dynamic = 'force-dynamic';

export default async function RepoDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const repo = await getRepository(id);
  if (!repo) notFound();

  const [health, lineBoards, trendRaw, changeBatches, history, validation, allUsage] =
    await Promise.all([
      getRepositoryHealth(id),
      listLineBoards(id),
      getVerificationTrend(id),
      listChangeBatches(id),
      getSessionHistory(id),
      getValidationStages(id),
      listSessionUsageForRepo(id),
    ]);
  const artifacts = listArtifactFiles(repo.path);

  const byDate = new Map<string, { pass: number; fail: number }>();
  for (const point of trendRaw) {
    const entry = byDate.get(point.date) ?? { pass: 0, fail: 0 };
    if (point.status === 'pass') entry.pass += 1;
    else entry.fail += 1;
    byDate.set(point.date, entry);
  }
  const trend = [...byDate.entries()].map(([date, counts]) => ({ date, ...counts }));

  const usageBySlot = new Map<number, typeof allUsage>();
  for (const row of allUsage) {
    const list = usageBySlot.get(row.agentId) ?? [];
    list.push(row);
    usageBySlot.set(row.agentId, list);
  }

  const repoName = repo.path.split('/').pop() ?? repo.path;
  const latestVerify = validation?.latestRun ?? null;

  return (
    <div className="space-y-6 px-4 py-4 md:px-6 md:py-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href="/repos" className="text-sm text-muted-foreground hover:underline">
            ← Repositories
          </Link>
          <h2 className="mt-2 text-2xl font-semibold">{repoName}</h2>
          <p className="break-all font-mono text-xs text-muted-foreground">{repo.path}</p>
          {repo.gitRemote && <p className="text-sm text-muted-foreground">{repo.gitRemote}</p>}
          {lineBoards.length > 0 && (
            <Link
              href={`/repos/${repo.id}/lines`}
              className="mt-2 inline-block text-sm underline"
              data-testid="repo-lines-link"
            >
              Factory lines →
            </Link>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ArtifactsDrawer
            repoId={id}
            artifacts={artifacts.map((a) => ({
              relativePath: a.relativePath,
              sizeBytes: a.sizeBytes,
              modifiedAt: a.modifiedAt,
            }))}
          />
          <UnregisterRepoButton
            repoId={repo.id}
            repoPath={repo.path}
            worktrees={repo.slots
              .filter((slot) => Boolean(slot.worktreePath || slot.workDir))
              .map((slot) => ({
                agentId: slot.slotId,
                path: slot.worktreePath ?? slot.workDir ?? '',
                active: slot.active,
                dirty: slot.dirty,
              }))}
          />
        </div>
      </div>

      {health && (
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Last verify</CardTitle>
            </CardHeader>
            <CardContent>
              {latestVerify ? (
                <>
                  <p className="text-2xl font-bold">
                    {latestVerify.status === 'pass' ? 'Passed' : `${latestVerify.status[0].toUpperCase()}${latestVerify.status.slice(1)}`}
                  </p>
                  <p className="text-sm text-muted-foreground" suppressHydrationWarning title={latestVerify.startedAt.toLocaleString()}>
                    {timeAgo(latestVerify.startedAt)}
                    {latestVerify.agentId != null ? ` · slot ${latestVerify.agentId}` : ''}
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">No verify run yet</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Verify pass rate</CardTitle>
            </CardHeader>
            <CardContent className="flex items-end justify-between gap-4">
              <div>
                <p className="text-2xl font-bold">{health.verificationTrend.passRate}%</p>
                <p className="text-sm text-muted-foreground">
                  {health.verificationTrend.pass} pass / {health.verificationTrend.fail} fail
                </p>
              </div>
              <VerifySparkline data={trend} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Last sync</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm" suppressHydrationWarning title={health.lastSyncAt?.toLocaleString()}>
                {health.lastSyncAt ? timeAgo(health.lastSyncAt) : 'Never'}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      <Tabs defaultValue="slots">
        <TabsList>
          <TabsTrigger value="slots">Slots</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="validation">Validation</TabsTrigger>
        </TabsList>

        <TabsContent value="slots" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Slots</CardTitle>
              <CardDescription>One row per agent environment; click a row to open it.</CardDescription>
            </CardHeader>
            <CardContent>
              <SlotGrid
                slots={repo.slots.map((s) => {
                  const rows = usageBySlot.get(s.slotId) ?? [];
                  const tokensTotal = rows.reduce((n, r) => n + Number(r.tokensTotal), 0);
                  let costUsd: number | null = null;
                  for (const r of rows) {
                    if (r.costUsd != null) costUsd = (costUsd ?? 0) + Number(r.costUsd);
                  }
                  return {
                    repoId: id,
                    slotId: s.slotId,
                    active: s.active,
                    workDir: s.workDir,
                    worktreePath: s.worktreePath,
                    branch: s.branch,
                    baseBranch: s.baseBranch,
                    baseCommit: s.baseCommit,
                    previewUrls: s.previewUrls as Record<string, string> | null,
                    harnessUsage: s.harnessUsage,
                    lastRunAt: s.lastRunAt,
                    lastVerifyStatus: s.lastVerifyStatus,
                    lastBuildPass: s.lastBuildPass,
                    detachedHead: s.detachedHead,
                    dirty: s.dirty,
                    ahead: s.ahead,
                    behind: s.behind,
                    stale: s.stale,
                    purpose: s.purpose,
                    tokensTotal: tokensTotal || null,
                    costUsd,
                    agentTools: [...new Set(rows.map((r) => r.agentTool))],
                    usageSources: [...new Set(rows.flatMap((r) => r.sources))],
                  };
                })}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>History</CardTitle>
              <CardDescription>
                Verified snapshots and the commits that share them. The graph follows one branch at a
                time; the list shows every verify run and snapshot.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="graph">
                <TabsList>
                  <TabsTrigger value="graph">Graph</TabsTrigger>
                  <TabsTrigger value="list">List</TabsTrigger>
                </TabsList>
                <TabsContent value="graph" className="mt-4">
                  {history ? (
                    <SessionHistoryPanel history={history} />
                  ) : (
                    <p className="text-sm text-muted-foreground">No session history available.</p>
                  )}
                </TabsContent>
                <TabsContent value="list" className="mt-4 space-y-8">
                  <section>
                    <h4 className="mb-3 text-sm font-medium text-muted-foreground">Snapshots</h4>
                    <ChangeBatchList
                      repoId={id}
                      batches={changeBatches.map((b) => ({
                        id: b.id,
                        treeHash: b.treeHash,
                        branch: b.branch,
                        agentId: b.agentId,
                        status: b.status,
                        full: b.full,
                        runId: b.runId,
                        changedFiles: Array.isArray(b.changedFiles)
                          ? (b.changedFiles as { path: string; status: string; oldPath?: string }[])
                          : [],
                        commitSha: b.commitSha,
                        createdAt: b.createdAt,
                      }))}
                    />
                  </section>
                  <section>
                    <h4 className="mb-3 text-sm font-medium text-muted-foreground">Runs</h4>
                    <RunTimeline
                      runs={repo.runs.map((r) => ({
                        id: r.id,
                        runId: r.runId,
                        stageId: r.stageId,
                        agentId: r.agentId,
                        status: r.status,
                        trigger: r.trigger,
                        durationMs: r.durationMs,
                        startedAt: r.startedAt,
                      }))}
                    />
                  </section>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="validation" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Validation stages</CardTitle>
              <CardDescription>
                Verification stages declared by the harness, with the latest result per stage
                from recent verify runs
                {validation?.latestRun &&
                  ` — last verify ${validation.latestRun.startedAt.toLocaleString()} (${validation.latestRun.status})`}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-10">
              <ValidationPipeline
                stages={validation?.stages ?? []}
                verifyRunCount={validation?.verifyRunCount ?? 0}
              />
              <div>
                <h4 className="mb-4 text-sm font-medium text-muted-foreground">Stage history</h4>
                <ValidationStages stages={validation?.stages ?? []} />
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
