import * as fs from 'fs';
import { Suspense } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AttentionPanel } from '@/components/attention-panel';
import { WorktreeGrid, type WorktreeRow } from '@/components/worktree-grid';
import { attentionItems } from '@/lib/attention';
import { classifyWorktreeCleanup } from '@/lib/worktree-cleanup-plan';
import { listSessionWorktrees } from '@/server/repositories';
import { loadLatestVerifyBySlot } from '@/server/slot-verify';
import { summarizeUsageForBranch } from '@/server/usage';

export const dynamic = 'force-dynamic';

export default async function NowPage() {
  const slots = await listSessionWorktrees();
  const latestVerify = await loadLatestVerifyBySlot(slots);
  const rows: WorktreeRow[] = await Promise.all(
    slots.map(async (s) => {
      const usage = await summarizeUsageForBranch(s.repositoryId, s.branch, s.suffix);
      const path = s.worktreePath ?? s.workDir;
      const onDisk = path ? fs.existsSync(path) : false;
      const cleanup = classifyWorktreeCleanup({
        active: s.active,
        dirty: s.dirty,
        sessionCreatedAt: s.sessionCreatedAt,
        onDisk,
      });
      return {
        repoId: s.repository.id,
        repoPath: s.repository.path,
        syncedAt: s.updatedAt,
        sessionCreatedAt: s.sessionCreatedAt,
        cleanupRecommendation: cleanup.recommendation,
        cleanupReason: cleanup.reason,
        cleanupAgeDays: cleanup.ageDays,
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
        lastVerifyStatus: latestVerify.get(`${s.repositoryId}:${s.slotId}`)?.status ?? s.lastVerifyStatus,
        lastVerifyAt: latestVerify.get(`${s.repositoryId}:${s.slotId}`)?.startedAt ?? null,
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
        // Idle rows fold the cleanup advice into the health sentence (#339).
        cleanupHint: s.active ? null : cleanup.reason,
      };
    }),
  );

  const active = rows.filter((row) => row.active);
  const attention = attentionItems(rows);
  const safeToClean = rows.filter(
    (row) => row.cleanupRecommendation === 'teardown' || row.cleanupRecommendation === 'clear_missing',
  ).length;
  const summary = [
    { label: 'Active slots', value: active.length },
    { label: 'Needs attention', value: attention.length, alert: attention.length > 0 },
    { label: 'Repositories in use', value: new Set(active.map((row) => row.repoId)).size },
    { label: 'Safe to clean', value: safeToClean },
  ];

  return (
    <div className="min-w-0 space-y-6 overflow-x-hidden px-4 py-4 md:px-6 md:py-6">
      <div>
        <h2 className="text-2xl font-semibold">Now</h2>
        <p className="text-sm text-muted-foreground">
          What is running across your repositories, and what needs you first.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-4">
        {summary.map((item) => (
          <Card key={item.label}>
            <CardHeader>
              <CardTitle className="text-base">{item.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className={`text-2xl font-bold tabular-nums ${item.alert ? 'text-amber-700 dark:text-amber-400' : ''}`}>
                {item.value}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Attention</CardTitle>
          <CardDescription>
            Active slots with a failed verify, a missing or stale worktree, uncommitted changes, or
            no harness activity.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AttentionPanel items={attention} />
        </CardContent>
      </Card>
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Session worktrees</CardTitle>
          <CardDescription>
            Every slot across registered repositories, with a cleanup recommendation. Select safe
            rows to remove them from Mission Control; tear down on the host with{' '}
            <code className="text-xs">har env teardown</code>.
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
