import * as path from 'path';
import type { Argv } from 'yargs';
import {
  getControlApiUrl,
  isControlEnabled,
} from '../../core/control-config';
import { inspectControlUpReadiness } from '../../core/control-port';
import {
  syncRepoWithControl,
} from '../../core/control-sync';
import { writePortalCredentials } from '../../core/portal-credentials';
import { loginViaBrowser } from '../../core/portal-login';
import { startMissionControl, syncReposAfterControlStart, stopMissionControl } from '../../core/control-lifecycle';
import {
  confirmUnregister,
  listUnregisterWorktreeCandidates,
  unregisterRepoWithControl,
} from '../../core/control-unregister';
import { error, header, info, success, warn } from '../../utils/logging';
import { recordRepoForControlSync } from '../../core/control-registry';

export const controlCommand = {
  command: 'control <subcommand>',
  describe: 'Mission Control dashboard (local)',
  builder: (yargs: Argv) =>
    yargs
      .command(
        'up',
        'Start Mission Control (single Docker container, SQLite)',
        (y: Argv) =>
          y
            .option('detach', { alias: 'd', type: 'boolean', default: true })
            .option('build', {
              type: 'boolean',
              default: false,
              describe: 'Build Mission Control locally instead of pulling from Docker Hub',
            }),
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
            .option('dry-run', { type: 'boolean', default: false })
            .option('force', {
              type: 'boolean',
              default: false,
              describe: 'Re-register even if previously unregistered',
            }),
        handleRegister,
      )
      .command(
        'unregister',
        'Remove a repository from Mission Control (optionally delete session worktrees)',
        (y: Argv) =>
          y
            .option('repo', { type: 'string', default: '.', describe: 'Path to the repository' })
            .option('api-url', { type: 'string', describe: 'Control API URL' })
            .option('dry-run', { type: 'boolean', default: false })
            .option('yes', {
              alias: 'y',
              type: 'boolean',
              default: false,
              describe: 'Skip confirmation prompts',
            })
            .option('delete-worktrees', {
              type: 'boolean',
              default: false,
              describe: 'Delete session worktrees for this repo (prompted interactively when omitted)',
            })
            .option('json', { type: 'boolean', default: false }),
        handleUnregister,
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
        'Log in to a har-portal (browser SSO) and store an ingest token',
        (y: Argv) =>
          y
            .option('portal', { type: 'string', describe: 'Portal base URL (or set HAR_PORTAL_URL)' })
            .option('api-key', {
              type: 'string',
              describe: 'Store this ingest token directly instead of browser login',
            }),
        handleLogin,
      )
      .demandCommand(
        1,
        'Please specify a subcommand: up, down, register, unregister, sync, watch, login',
      ),
  handler: () => {},
};

async function handleUp(argv: { detach: boolean; build: boolean }): Promise<void> {
  header('har control up');
  const readiness = inspectControlUpReadiness(process.cwd());
  for (const message of readiness.warnings) {
    warn(message);
  }
  if (readiness.controlAlreadyRunning) {
    success(`Mission Control is already running at ${getControlApiUrl()}`);
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
    return;
  }
  const { code, apiUrl, imageRef } = await startMissionControl({
    detach: argv.detach,
    build: argv.build,
  });
  if (code !== 0) {
    if (!argv.build) {
      warn(
        `Could not pull ${imageRef}. For local development use har control up --build, or publish the matching image.`,
      );
    }
    process.exit(code);
  }
  success(`Mission Control running at ${apiUrl} (${imageRef})`);

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
  const code = stopMissionControl();
  process.exit(code);
}

async function handleRegister(argv: {
  repo: string;
  apiUrl?: string;
  dryRun: boolean;
  force: boolean;
}): Promise<void> {
  const repoPath = path.resolve(argv.repo);
  header('har control register');
  info(`Repository: ${repoPath}`);

  try {
    if (!argv.dryRun) {
      recordRepoForControlSync(repoPath);
    }
    // Explicit register always clears a prior unregister blocklist entry.
    await syncRepoWithControl({
      repoPath,
      apiUrl: argv.apiUrl,
      dryRun: argv.dryRun,
      force: true,
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

async function handleUnregister(argv: {
  repo: string;
  apiUrl?: string;
  dryRun: boolean;
  yes: boolean;
  deleteWorktrees: boolean;
  json: boolean;
}): Promise<void> {
  const repoPath = path.resolve(argv.repo);
  const worktrees = listUnregisterWorktreeCandidates(repoPath);

  try {
    let deleteWorktrees = argv.deleteWorktrees;
    if (!argv.yes && !argv.dryRun) {
      const confirmation = await confirmUnregister({ yes: false, worktrees });
      if (!confirmation.proceed) {
        error('Aborted — repository left registered.');
        process.exit(2);
      }
      // Explicit flag wins; otherwise use the interactive answer.
      deleteWorktrees = argv.deleteWorktrees || confirmation.deleteWorktrees;
    } else if (argv.yes && !argv.deleteWorktrees && worktrees.some((w) => w.exists)) {
      // --yes without --delete-worktrees keeps worktrees (safe default).
      deleteWorktrees = false;
    }

    const result = await unregisterRepoWithControl({
      repoPath,
      apiUrl: argv.apiUrl,
      dryRun: argv.dryRun,
      deleteWorktrees,
    });

    if (argv.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return;
    }

    header('har control unregister');
    info(`Repository: ${result.path}`);
    if (argv.dryRun) {
      info('Dry run — no changes made');
      if (worktrees.filter((w) => w.exists).length > 0) {
        info(
          `Would propose deleting ${worktrees.filter((w) => w.exists).length} session worktree(s)`,
        );
      }
      return;
    }

    if (result.apiUnreachable) {
      warn('Mission Control API unreachable — removed from local registry only');
    } else if (result.id) {
      success('Removed from Mission Control');
    } else {
      info('Repository was not present in Mission Control');
    }
    if (result.removedFromRegistry) {
      success('Removed from local sync registry (~/.har/repos.json)');
    }
    if (result.deleteWorktrees) {
      const deleted = result.worktrees.filter((w) => w.deleted).length;
      const failed = result.worktrees.filter((w) => !w.deleted && w.error);
      success(`Deleted ${deleted} session worktree(s)`);
      for (const failure of failed) {
        warn(`Failed to delete ${failure.path}: ${failure.error}`);
      }
    } else if (result.worktrees.length > 0) {
      info(
        `Left ${result.worktrees.length} session worktree(s) on disk (rerun with --delete-worktrees to remove)`,
      );
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

async function handleLogin(argv: { apiKey?: string; portal?: string }): Promise<void> {
  header('har control login');
  const portalUrl = (argv.portal ?? process.env.HAR_PORTAL_URL ?? '').replace(/\/+$/, '');
  if (!portalUrl) {
    error('Provide --portal <url> (or set HAR_PORTAL_URL)');
    process.exit(1);
  }

  if (argv.apiKey) {
    writePortalCredentials({
      portalUrl,
      token: argv.apiKey,
      createdAt: new Date().toISOString(),
    });
    success(`Saved ingest token for ${portalUrl}`);
    info('Sync: har control sync');
    return;
  }

  try {
    const creds = await loginViaBrowser(portalUrl);
    writePortalCredentials(creds);
    success(
      `Logged in to ${portalUrl}${creds.workspace ? ` (workspace: ${creds.workspace})` : ''}`,
    );
    info('Sync: har control sync');
  } catch (err) {
    error(`Login failed: ${(err as Error).message}`);
    process.exit(1);
  }
}
