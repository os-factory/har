import { ResetMissionControlButton } from '@/components/reset-mission-control-button';
import { listRepositories } from '@/server/repositories';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const repos = await listRepositories();

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 md:px-6">
        <h2 className="text-2xl font-semibold">Settings</h2>
        <p className="text-sm text-muted-foreground">
          Local Mission Control preferences and destructive maintenance
        </p>
      </div>

      <section className="mx-4 space-y-4 rounded-lg border border-destructive/30 bg-destructive/[0.03] p-4 md:mx-6 md:p-6">
        <div className="space-y-1">
          <h3 className="text-lg font-semibold text-destructive">Danger zone</h3>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Clear the entire dashboard database so a fresh register/sync starts empty. Optionally
            scrub gitignored harness history (`.har/runs`, `validations`, `state`, `slots`) on disk
            for every registered repository.
          </p>
        </div>
        <ResetMissionControlButton repositoryCount={repos.length} />
      </section>
    </div>
  );
}
