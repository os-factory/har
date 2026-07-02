import { RepoSectionCards } from '@/components/repo-section-cards';
import { RepoTable } from '@/components/repo-table';
import { listRepositories } from '@/server/repositories';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const repos = await listRepositories();
  const rows = repos.map((r) => ({
    id: r.id,
    path: r.path,
    gitRemote: r.gitRemote,
    lastSyncAt: r.lastSyncAt,
    runCount: r._count.runs,
    slotCount: r._count.slots,
    profile: (r.manifest as { profile?: string } | null)?.profile,
  }));

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <RepoSectionCards repos={rows} />
      <RepoTable repos={rows} />
    </div>
  );
}
