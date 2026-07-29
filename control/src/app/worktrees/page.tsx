import * as fs from 'fs';
import { Suspense } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { WorktreeGrid, type WorktreeRow } from '@/components/worktree-grid';
import { listSessionWorktrees } from '@/server/repositories';
import { summarizeUsageForBranch } from '@/server/usage';

export const dynamic = 'force-dynamic';

export default async function WorktreesPage() {
  const slots = await listSessionWorktrees();
  const rows: WorktreeRow[] = await Promise.all(
    slots.map(async (s) => {
      const usage = await summarizeUsageForBranch(s.repositoryId, s.branch, s.suffix);
      const path = s.worktreePath ?? s.workDir;
      const onDisk = path ? fs.existsSync(path) : false;
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
        onDisk,
      };
    }),
  );
  const summary = [
    { label: 'Session worktrees', value: rows.length, alert: false },
    { label: 'Active', value: rows.filter((row) => row.active).length, alert: false },
    {
      label: 'Missing on disk',
      value: rows.filter((row) => row.onDisk === false).length,
      alert: rows.some((row) => row.onDisk === false),
    },
    {
      label: 'Dirty',
      value: rows.filter((row) => row.dirty).length,
      alert: rows.some((row) => row.dirty),
    },
  ];

  return (
    <div className="min-w-0 space-y-6 overflow-x-hidden px-4 py-4 md:px-6 md:py-6">
      <div>
        <h2 className="text-2xl font-semibold">Operations</h2>
        <p className="text-sm text-muted-foreground">
          Session worktrees across registered repositories — select and delete to clean up.
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
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Session worktrees</CardTitle>
          <CardDescription>
            Active and idle slots with a recorded worktree path. Use select-all to delete many at
            once; repository registration is kept.
          </CardDescription>
        </CardHeader>
        <CardContent className="min-w-0">
          <Suspense fallback={<p className="text-sm text-muted-foreground">Loading worktrees…</p>}>
            <WorktreeGrid worktrees={rows} />
          </Suspense>
        </CardContent>
      </Card>
    </div>
  );
}
