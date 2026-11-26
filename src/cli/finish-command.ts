import { syncDirtyRepos } from '../core/sync-context';
import { drainDueIngestQueues } from '../core/ingest-queue';

export async function finishCommand(code: number): Promise<never> {
  await syncDirtyRepos();
  await drainDueIngestQueues();
  process.exit(code);
}
