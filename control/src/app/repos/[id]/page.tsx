import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ArtifactTable } from '@/components/artifact-table';
import { ChangeBatchList } from '@/components/change-batch-list';
import { SessionHistoryPanel } from '@/components/session-history-panel';
import { RunTimeline } from '@/components/run-timeline';
import { SlotGrid } from '@/components/slot-grid';
import { UnregisterRepoButton } from '@/components/unregister-repo-button';
import { ValidationPipeline } from '@/components/validation-pipeline';
import { ValidationStages } from '@/components/validation-stages';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { getRepository, getRepositoryHealth } from '@/server/repositories';
import { listLineBoards } from '@/server/lines';
import { listChangeBatches } from '@/server/change-batches';
import { getSessionHistory } from '@/server/session-history';
import { getValidationStages } from '@/server/validation-stages';
import { listArtifactFiles } from '@/server/artifacts';
import { listSessionUsageForRepo } from '@/server/usage';

export const dynamic = 'force-dynamic';

export default async function RepoDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const repo = await getRepository(id);
  if (!repo) notFound();

  const health = await getRepositoryHealth(id);
  const lineBoards = await listLineBoards(id);

  const artifacts = listArtifactFiles(repo.path);
  const changeBatches = await listChangeBatches(id);
  const history = await getSessionHistory(id);
  const validation = await getValidationStages(id);
  const allUsage = await listSessionUsageForRepo(id);
  const usageBySlot = new Map<number, typeof allUsage>();
  for (const row of allUsage) {
    const list = usageBySlot.get(row.agentId) ?? [];
    list.push(row);
    usageBySlot.set(row.agentId, list);
  }

  return (
    <div className="space-y-6 px-4 py-4 md:px-6 md:py-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/repos" className="text-sm text-muted-foreground hover:underline">
            ← Repos
          </Link>
          <h2 className="mt-2 text-2xl font-semibold">{repo.path}</h2>
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

      {health && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Verify pass rate</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{health.verificationTrend.passRate}%</p>
              <p className="text-sm text-muted-foreground">
                {health.verificationTrend.pass} pass / {health.verificationTrend.fail} fail
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Last sync</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm">{health.lastSyncAt?.toLocaleString() ?? 'Never'}</p>
            </CardContent>
          </Card>
        </div>
      )}

      <Tabs defaultValue="slots">
        <TabsList>
          <TabsTrigger value="slots">Slots</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="validation">Validation</TabsTrigger>
          <TabsTrigger value="changes">Changes</TabsTrigger>
          <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
        </TabsList>

        <TabsContent value="slots" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Agent slots</CardTitle>
              <CardDescription>Worktrees and harness usage per slot</CardDescription>
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

        <TabsContent value="runs" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Run timeline</CardTitle>
            </CardHeader>
            <CardContent>
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
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Session history</CardTitle>
              <CardDescription>
                Content snapshots and the commits that share them. A dashed node is verified
                but not yet committed. Labels distinguish the commit, the content snapshot, the
                base, and the verifying run.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {history ? (
                <SessionHistoryPanel history={history} />
              ) : (
                <p className="text-sm text-muted-foreground">No session history available.</p>
              )}
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

        <TabsContent value="changes" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Content snapshots</CardTitle>
              <CardDescription>
                Exact working-tree content hashed at verify time, grouped by branch. A content
                snapshot is not a commit — it has no parent or message until one is created with
                the same tree.
              </CardDescription>
            </CardHeader>
            <CardContent>
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
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="artifacts" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Artifacts</CardTitle>
              <CardDescription>Files under .har/artifacts/</CardDescription>
            </CardHeader>
            <CardContent>
              <ArtifactTable
                repoId={id}
                artifacts={artifacts.map((a) => ({
                  relativePath: a.relativePath,
                  sizeBytes: a.sizeBytes,
                  modifiedAt: a.modifiedAt,
                }))}
              />
            </CardContent>
          </Card>
        </TabsContent>

      </Tabs>
    </div>
  );
}
