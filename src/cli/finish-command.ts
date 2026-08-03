import { syncDirtyRepos } from '../core/sync-context';

export async function finishCommand(code: number): Promise<never> {
  await syncDirtyRepos();
  process.exit(code);
}
