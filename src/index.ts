import { runCli } from './cli';
import { syncDirtyRepos } from './core/sync-context';

runCli().catch(async (err: Error) => {
  console.error(err.message);
  await syncDirtyRepos();
  process.exit(1);
});
