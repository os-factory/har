import { runCli } from './cli';
import { maybeReexecPreferredRuntime } from './core/prefer-local-runtime';
import { syncDirtyRepos } from './core/sync-context';

maybeReexecPreferredRuntime();

runCli().catch(async (err: Error) => {
  console.error(err.message);
  await syncDirtyRepos();
  process.exit(1);
});
