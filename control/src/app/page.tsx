import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { RepoTable } from '@/components/repo-table';
import { listRepositories } from '@/server/repositories';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const repos = await listRepositories();

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Repositories</CardTitle>
          <CardDescription>
            Registered harness projects on this machine. Start with{' '}
            <code className="rounded bg-muted px-1">har control up</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RepoTable
            repos={repos.map((r) => ({
              id: r.id,
              path: r.path,
              gitRemote: r.gitRemote,
              lastSyncAt: r.lastSyncAt,
              runCount: r._count.runs,
              slotCount: r._count.slots,
              profile: (r.manifest as { profile?: string } | null)?.profile,
            }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
