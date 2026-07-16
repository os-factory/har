import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { WorktreeGrid, type WorktreeRow } from '@/components/worktree-grid';
import { listActiveWorktrees } from '@/server/repositories';
import { summarizeUsageForBranch } from '@/server/usage';

export const dynamic = 'force-dynamic';

export default async function WorktreesPage() {
  const slots = await listActiveWorktrees();

  const rows: WorktreeRow[] = await Promise.all(
    slots.map(async (s) => {
      const usage = await summarizeUsageForBranch(s.repositoryId, s.branch, s.suffix);
      return {
        repoId: s.repository.id,
        repoPath: s.repository.path,
        syncedAt: s.updatedAt,
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
        tokensTotal: usage.tokensTotal || null,
        costUsd: usage.costUsd,
        agentTools: usage.agentTools,
        usageSources: usage.sources,
      };
    }),
  );

  const dirtyCount = rows.filter((r) => r.dirty).length;
  const staleCount = rows.filter((r) => r.stale || r.detachedHead).length;
  const bypassCount = rows.filter((r) => r.harnessUsage === 'bypass_warning').length;

  const summary = [
    { label: 'Active worktrees', value: rows.length, alert: false },
    { label: 'Dirty', value: dirtyCount, alert: dirtyCount > 0 },
    { label: 'Stale or detached', value: staleCount, alert: staleCount > 0 },
    { label: 'Bypass warnings', value: bypassCount, alert: bypassCount > 0 },
  ];

  return (
    <div className="space-y-6 px-4 py-4 md:px-6 md:py-6">
      <div>
        <h2 className="text-2xl font-semibold">Worktrees</h2>
        <p className="text-sm text-muted-foreground">
          Active agent sessions across all repositories, as of each repo&apos;s last sync
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        {summary.map((item) => (
          <Card key={item.label}>
            <CardHeader>
              <CardTitle className="text-base">{item.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className={`text-2xl font-bold ${item.alert ? 'text-amber-500' : ''}`}>
                {item.value}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Active sessions</CardTitle>
          <CardDescription>
            Worktree, branch and drift per agent slot — status reflects the last `har` sync
          </CardDescription>
        </CardHeader>
        <CardContent>
          <WorktreeGrid worktrees={rows} />
        </CardContent>
      </Card>
    </div>
  );
}
