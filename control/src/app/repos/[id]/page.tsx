import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChangeBatchList } from '@/components/change-batch-list';
import { RunTimeline } from '@/components/run-timeline';
import { SlotGrid } from '@/components/slot-grid';
import { VerificationTrendChart } from '@/components/verification-trend-chart';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { getRepository, getRepositoryHealth, getVerificationTrend } from '@/server/repositories';
import { listChangeBatches } from '@/server/change-batches';
import { listArtifactFiles, type ArtifactFile } from '@/server/artifacts';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

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
  const trendRaw = await getVerificationTrend(id);
  const byDate = new Map<string, { pass: number; fail: number }>();
  for (const point of trendRaw) {
    const entry = byDate.get(point.date) ?? { pass: 0, fail: 0 };
    if (point.status === 'pass') entry.pass += 1;
    else entry.fail += 1;
    byDate.set(point.date, entry);
  }
  const trend = [...byDate.entries()].map(([date, counts]) => ({ date, ...counts }));

  const artifacts = listArtifactFiles(repo.path);
  const changeBatches = await listChangeBatches(id);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/" className="text-sm text-muted-foreground hover:underline">
          ← Repos
        </Link>
        <h2 className="mt-2 text-2xl font-semibold">{repo.path}</h2>
        {repo.gitRemote && <p className="text-sm text-muted-foreground">{repo.gitRemote}</p>}
      </div>

      {health && (
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Harness adoption</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{health.harnessAdoption.mcpPercent}% MCP</p>
              <p className="text-sm text-muted-foreground">
                {health.harnessAdoption.mcp} MCP · {health.harnessAdoption.cli} CLI ·{' '}
                {health.harnessAdoption.script} script
              </p>
            </CardContent>
          </Card>
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
          <TabsTrigger value="changes">Changes</TabsTrigger>
          <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
        </TabsList>

        <TabsContent value="slots" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Agent slots</CardTitle>
              <CardDescription>Worktrees and harness usage per slot</CardDescription>
            </CardHeader>
            <CardContent>
              <SlotGrid
                slots={repo.slots.map((s) => ({
                  slotId: s.slotId,
                  active: s.active,
                  workDir: s.workDir,
                  worktreePath: s.worktreePath,
                  harnessUsage: s.harnessUsage,
                  lastRunAt: s.lastRunAt,
                  lastVerifyStatus: s.lastVerifyStatus,
                  lastBuildPass: s.lastBuildPass,
                }))}
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

        <TabsContent value="changes" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Change batches</CardTitle>
              <CardDescription>
                Working-tree states hashed at verify time, grouped by branch — was the harness run
                on these exact changes?
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ChangeBatchList
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
              {artifacts.length === 0 ? (
                <p className="text-sm text-muted-foreground">No artifacts found.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Path</TableHead>
                      <TableHead>Size</TableHead>
                      <TableHead>Modified</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {artifacts.map((a: ArtifactFile) => (
                      <TableRow key={a.relativePath}>
                        <TableCell>{a.relativePath}</TableCell>
                        <TableCell>{a.sizeBytes} B</TableCell>
                        <TableCell>{new Date(a.modifiedAt).toLocaleString()}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="analytics" className="mt-4">
          <VerificationTrendChart data={trend} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
