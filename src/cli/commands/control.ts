import * as path from 'path';
import type { Argv } from 'yargs';
import {
  getControlApiUrl,
  isControlEnabled,
} from '../../core/control-config';
import {
  syncRepoWithControl,
} from '../../core/control-sync';
import { startMissionControl, syncReposAfterControlStart, runDockerCompose } from '../../core/control-lifecycle';
import { error, header, info, success, warn } from '../../utils/logging';

export const controlCommand = {
  command: 'control <subcommand>',
  describe: 'Mission Control dashboard (local)',
  builder: (yargs: Argv) =>
    yargs
      .command(
        'up',
        'Start Mission Control (Docker Compose)',
        (y: Argv) =>
          y.option('detach', { alias: 'd', type: 'boolean', default: true }),
        handleUp,
      )
      .command(
        'down',
        'Stop Mission Control',
        () => {},
        handleDown,
      )
      .command(
        'register',
        'Register a repository with Mission Control and sync runs + slots',
        (y: Argv) =>
          y
            .option('repo', { type: 'string', default: '.', describe: 'Path to the repository' })
            .option('api-url', { type: 'string', describe: 'Control API URL' })
            .option('dry-run', { type: 'boolean', default: false }),
        handleRegister,
      )
      .command(
        'sync',
        'Sync runs and slot status to Mission Control',
        (y: Argv) =>
          y
            .option('repo', { type: 'string', default: '.', describe: 'Path to the repository' })
            .option('api-url', { type: 'string', describe: 'Control API URL' })
            .option('dry-run', { type: 'boolean', default: false })
            .option('json', { type: 'boolean', default: false })
            .option('cloud', {
              type: 'boolean',
              default: false,
              describe: 'Sync to HAR Cloud instead of local Mission Control',
            }),
        handleSync,
      )
      .command(
        'watch',
        'Continuously sync registered repos to Mission Control',
        (y: Argv) =>
          y
            .option('repo', { type: 'string', describe: 'Path to one repository (default: all registered)' })
            .option('interval', { type: 'number', default: 10, describe: 'Poll interval in seconds' })
            .option('api-url', { type: 'string', describe: 'Control API URL' }),
        handleWatch,
      )
      .command(
        'login',
        'Configure HAR Cloud API credentials (hosted sync)',
        (y: Argv) =>
          y.option('api-key', { type: 'string', describe: 'HAR Cloud API key' }),
        handleLogin,
      )
      .demandCommand(1, 'Please specify a subcommand: up, down, register, sync, watch, login'),
  handler: () => {},
};

async function handleUp(argv: { detach: boolean }): Promise<void> {
  header('har control up');
  const { code, apiUrl } = await startMissionControl({ detach: argv.detach });
  if (code !== 0) process.exit(code);
  success(`Mission Control running at ${apiUrl}`);

  if (!isControlEnabled()) return;

  info('Syncing repositories with Mission Control...');
  const { synced, failed, apiReady } = await syncReposAfterControlStart(process.cwd());
  if (!apiReady) {
    warn('Mission Control API did not become ready — run har control sync later');
    return;
  }
  if (synced > 0) {
    success(`Synced ${synced} ${synced === 1 ? 'repository' : 'repositories'} with Mission Control`);
  }
  if (failed > 0) {
    warn(`${failed} ${failed === 1 ? 'repository' : 'repositories'} could not be synced`);
  }
}

async function handleDown(): Promise<void> {
  header('har control down');
  const code = runDockerCompose(['down']);
  process.exit(code);
}

async function handleRegister(argv: {
  repo: string;
  apiUrl?: string;
  dryRun: boolean;
}): Promise<void> {
  const repoPath = path.resolve(argv.repo);
  header('har control register');
  info(`Repository: ${repoPath}`);

  try {
    await syncRepoWithControl({
      repoPath,
      apiUrl: argv.apiUrl,
      dryRun: argv.dryRun,
    });
    if (argv.dryRun) {
      info('Dry run — no API call made');
    } else {
      success('Registered and synced with Mission Control');
    }
  } catch (err: unknown) {
    error((err as Error).message);
    process.exit(1);
  }
}

async function handleSync(argv: {
  repo: string;
  apiUrl?: string;
  dryRun: boolean;
  json: boolean;
  cloud?: boolean;
}): Promise<void> {
  const repoPath = path.resolve(argv.repo);

  try {
    await syncRepoWithControl({
      repoPath,
      apiUrl: argv.apiUrl,
      dryRun: argv.dryRun,
      cloud: argv.cloud,
    });

    if (argv.json) {
      process.stdout.write(JSON.stringify({ ok: true, repoPath }, null, 2) + '\n');
    } else {
      header('har control sync');
      info(`Repository: ${repoPath}`);
      success('Sync complete');
    }
  } catch (err: unknown) {
    if (argv.json) {
      process.stdout.write(
        JSON.stringify({ ok: false, error: (err as Error).message }, null, 2) + '\n',
      );
      process.exit(1);
    }
    error((err as Error).message);
    process.exit(1);
  }
}

async function handleWatch(argv: {
  repo?: string;
  interval: number;
  apiUrl?: string;
}): Promise<void> {
  const apiUrl = argv.apiUrl ?? getControlApiUrl();
  header('har control watch');
  info(`Polling every ${argv.interval}s — Ctrl+C to stop`);

  const syncOne = async (repoPath: string) => {
    try {
      await syncRepoWithControl({ repoPath, apiUrl });
    } catch (err: unknown) {
      warn(`Sync failed for ${repoPath}: ${(err as Error).message}`);
    }
  };

  const tick = async () => {
    if (argv.repo) {
      await syncOne(path.resolve(argv.repo));
      return;
    }

    try {
      const response = await fetch(`${apiUrl}/api/repos`);
      if (!response.ok) return;
      const repos = (await response.json()) as { path: string }[];
      for (const repo of repos) {
        await syncOne(repo.path);
      }
    } catch {
      warn('Control API unreachable');
    }
  };

  await tick();
  setInterval(() => {
    void tick();
  }, argv.interval * 1000);
}

async function handleLogin(argv: { apiKey?: string }): Promise<void> {
  header('har control login');
  if (!argv.apiKey) {
    error('Provide --api-key (HAR Cloud API key)');
    process.exit(1);
  }
  process.env.HAR_CLOUD_API_KEY = argv.apiKey;
  success('HAR_CLOUD_API_KEY set for this process. Export it in your shell for persistence.');
  info('Sync to cloud: har control sync --cloud');
}
