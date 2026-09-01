import * as fs from 'fs';
import { RepoSectionCards } from '@/components/repo-section-cards';
import { RepoTable } from '@/components/repo-table';
import { classifyRepositoryVisibility } from '@/lib/repo-hygiene';
import { listRepositories } from '@/server/repositories';

export const dynamic = 'force-dynamic';

export default async function ReposPage() {
  const repos = await listRepositories();
  const onDisk = new Map(repos.map((r) => [r.id, fs.existsSync(r.path)]));
  // Inside the Docker image no host path is visible; then "missing" means nothing.
  const hostPathsVisible = [...onDisk.values()].some(Boolean);

  const rows = repos.map((r) => {
    const visibility = classifyRepositoryVisibility({
      path: r.path,
      onDisk: onDisk.get(r.id) ?? false,
      hostPathsVisible,
    });
    return {
      id: r.id,
      path: r.path,
      gitRemote: r.gitRemote,
      lastSyncAt: r.lastSyncAt,
      runCount: r._count.runs,
      slotCount: r._count.slots,
      profile: (r.manifest as { profile?: string } | null)?.profile,
      hidden: visibility.hidden,
      hiddenReason: visibility.reason,
    };
  });

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 md:px-6">
        <h2 className="text-2xl font-semibold">Repositories</h2>
        <p className="text-sm text-muted-foreground">
          Harness projects registered with Mission Control
        </p>
      </div>
      <RepoSectionCards repos={rows} />
      <RepoTable repos={rows} />
    </div>
  );
}
