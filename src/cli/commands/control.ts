import * as path from 'path';
import inquirer from 'inquirer';
import type { Argv } from 'yargs';
import {
  DEFAULT_PORTAL_URL,
  getControlApiUrl,
  isControlEnabled,
  resolvePortalUrl,
  type PortalUrlSource,
} from '../../core/control-config';
import { inspectControlUpReadiness } from '../../core/control-port';
import {
  discoverHarRepos,
  syncRepoWithControl,
  syncReposWithControl,
} from '../../core/control-sync';
import {
  readSyncSelection,
  resolveSyncSelection,
  writeSyncSelection,
} from '../../core/control-sync-selection';
import { writePortalCredentials } from '../../core/portal-credentials';
import { loginViaBrowser } from '../../core/portal-login';
import { startMissionControl, syncReposAfterControlStart, stopMissionControl } from '../../core/control-lifecycle';
import {
  confirmUnregister,
  listUnregisterWorktreeCandidates,
  unregisterRepoWithControl,
} from '../../core/control-unregister';
import {
  confirmControlReset,
  resetMissionControlFromCli,
} from '../../core/control-reset';
import { error, header, info, success, warn } from '../../utils/logging';
import {
  isRepoPortalSyncEnabled,
  listRegisteredRepos,
  recordRepoForControlSync,
  setRepoPortalSync,
} from '../../core/control-registry';
import {
  isTelemetryEnabled,
  readTelemetryPreference,
  writePortalTrajectoryPreference,
} from '../../core/telemetry-config';
import { finishCommand } from '../finish-command';

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
            })
            .option('portal', {
              type: 'boolean',
              describe:
                'Sync this repo to the hosted portal when logged in. Use --no-portal to keep it local-only.',
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
            .option('select', {
              type: 'boolean',
              default: false,
              describe: 'Choose which repositories to sync (interactive)',
            })
            .option('api-url', { type: 'string', describe: 'Control API URL' })
            .option('dry-run', { type: 'boolean', default: false })
            .option('json', { type: 'boolean', default: false })
            .option('cloud', {
              type: 'boolean',
              default: false,
              describe: 'Sync to HAR Cloud instead of local Mission Control',
            })
            .option('full', {
              type: 'boolean',
              default: false,
              describe: 'Ignore the portal watermark and resend the complete payload',
            }),
        handleSync,
      )
      .command(
        'login',
        'Log in to a har-portal (browser SSO) and store an ingest token',
        (y: Argv) =>
          y
            .option('portal', {
              type: 'string',
              describe: `Portal base URL (or HAR_PORTAL_URL; defaults to the last login, else ${DEFAULT_PORTAL_URL})`,
            })
            .option('api-key', {
              type: 'string',
              describe: 'Store this ingest token directly instead of browser login',
            }),
        handleLogin,
      )
      .command(
        'reset',
        'Clear all Mission Control data and optionally scrub local .har history',
        (y: Argv) =>
          y
            .option('api-url', { type: 'string', describe: 'Control API URL' })
            .option('yes', {
              alias: 'y',
              type: 'boolean',
              default: false,
              describe: 'Skip confirmation prompt',
            })
            .option('no-scrub-local', {
              type: 'boolean',
              default: false,
              describe: 'Keep local .har/{runs,validations,state,slots} directories',
            })
            .option('keep-registry', {
              type: 'boolean',
              default: false,
              describe: 'Keep ~/.har/repos.json entries (default clears them)',
            })
            .option('dry-run', { type: 'boolean', default: false })
            .option('json', { type: 'boolean', default: false }),
        handleReset,
      )
      .command(
        'trajectory [state]',
        'Forward agent prompts, tool arguments and tool results to the hosted portal (off by default)',
        (y: Argv) =>
          y.positional('state', {
            type: 'string',
            choices: ['on', 'off'] as const,
            describe: 'Omit to print the current setting',
          }),
        handleTrajectory,
      )
      .demandCommand(
        1,
        'Please specify a subcommand: up, down, register, unregister, sync, login, reset, trajectory',
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
    return finishCommand(code);
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
  return finishCommand(code);
}

async function handleRegister(argv: {
  repo: string;
  apiUrl?: string;
  dryRun: boolean;
  force: boolean;
  portal?: boolean;
}): Promise<void> {
  const repoPath = path.resolve(argv.repo);
  header('har control register');
  info(`Repository: ${repoPath}`);

  try {
    if (!argv.dryRun) {
      recordRepoForControlSync(repoPath);
      // Only persist when the user passed --portal / --no-portal (undefined = leave as-is).
      if (argv.portal !== undefined) {
        setRepoPortalSync(repoPath, argv.portal);
      }
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
      if (!isRepoPortalSyncEnabled(repoPath)) {
        info('Local-only — skipped hosted portal sync');
      }
    }
  } catch (err: unknown) {
    error((err as Error).message);
    return finishCommand(1);
  }
}

async function handleReset(argv: {
  apiUrl?: string;
  yes: boolean;
  noScrubLocal: boolean;
  keepRegistry: boolean;
  dryRun: boolean;
  json: boolean;
}): Promise<void> {
  try {
    const repoCount = listRegisteredRepos().length;
    if (!argv.yes && !argv.dryRun) {
      const proceed = await confirmControlReset({ yes: false, repoCount });
      if (!proceed) {
        error('Aborted — Mission Control left unchanged.');
        return finishCommand(2);
      }
    }

    const result = await resetMissionControlFromCli({
      apiUrl: argv.apiUrl,
      dryRun: argv.dryRun,
      scrubLocalHarness: !argv.noScrubLocal,
      clearRegistry: !argv.keepRegistry,
    });

    if (argv.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return;
    }

    header('har control reset');
    if (argv.dryRun) {
      info(
        `Dry run — would clear Mission Control for ${result.repoPaths.length} repositor${
          result.repoPaths.length === 1 ? 'y' : 'ies'
        }`,
      );
      if (result.scrubLocalHarness) {
        info(`Would scrub ${result.scrubbed.length} local .har director${result.scrubbed.length === 1 ? 'y' : 'ies'}`);
      }
      if (result.clearRegistry) {
        info('Would clear local sync registry (~/.har/repos.json)');
      }
      return;
    }

    if (result.apiUnreachable) {
      warn('Mission Control API unreachable — dashboard DB not cleared');
    } else {
      success(
        `Cleared ${result.repositoriesDeleted} repositor${
          result.repositoriesDeleted === 1 ? 'y' : 'ies'
        } from Mission Control`,
      );
      if (result.unregisteredCleared > 0) {
        success(`Cleared ${result.unregisteredCleared} unregister blocklist entr${result.unregisteredCleared === 1 ? 'y' : 'ies'}`);
      }
    }

    if (result.scrubLocalHarness) {
      const deleted = result.scrubbed.filter((row) => row.deleted).length;
      const failed = result.scrubbed.filter((row) => !row.deleted && row.error);
      success(`Scrubbed ${deleted} local .har director${deleted === 1 ? 'y' : 'ies'}`);
      for (const failure of failed) {
        warn(`Failed to delete ${failure.path}: ${failure.error}`);
      }
    }

    if (result.registryCleared) {
      success('Cleared local sync registry (~/.har/repos.json)');
    } else if (result.clearRegistry) {
      info('Local sync registry was already empty');
    }

    info('Re-register with: har control register --repo <path>');
  } catch (err: unknown) {
    if (argv.json) {
      process.stdout.write(
        JSON.stringify({ ok: false, error: (err as Error).message }, null, 2) + '\n',
      );
      return finishCommand(1);
    }
    error((err as Error).message);
    return finishCommand(1);
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
        return finishCommand(2);
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
      return finishCommand(1);
    }
    error((err as Error).message);
    return finishCommand(1);
  }
}

async function handleSync(argv: {
  select: boolean;
  apiUrl?: string;
  dryRun: boolean;
  json: boolean;
  cloud?: boolean;
  full: boolean;
}): Promise<void> {
  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const discovered = await discoverHarRepos({ apiUrl: argv.apiUrl, cwd: process.cwd() });

  if (argv.select && !isTTY) {
    error('--select needs an interactive terminal.');
    return finishCommand(1);
  }

  if (discovered.length === 0) {
    if (argv.json) {
      process.stdout.write(JSON.stringify({ ok: true, synced: 0, failed: 0, results: [] }, null, 2) + '\n');
    } else {
      header('har control sync');
      info('No repositories are registered with Mission Control.');
      info('Register one with: har control register --repo <path>');
    }
    return;
  }

  const resolution = resolveSyncSelection({
    discovered,
    stored: readSyncSelection(),
    forceSelect: argv.select,
    isTTY,
  });

  let repoPaths = resolution.toSync;
  if (resolution.needsPrompt) {
    info('Only repositories registered with Mission Control are listed.');
    info('Missing one? Register it with: har control register --repo <path>');
    const defaults = new Set(resolution.promptDefaults);
    const { selection } = await inquirer.prompt<{ selection: string[] }>([
      {
        type: 'checkbox',
        name: 'selection',
        message: 'Select repositories to sync',
        choices: discovered.map((repoPath) => ({
          name: repoPath,
          value: repoPath,
          checked: defaults.has(repoPath),
        })),
      },
    ]);
    writeSyncSelection(selection);
    repoPaths = selection;
  }

  if (repoPaths.length === 0) {
    if (argv.json) {
      process.stdout.write(JSON.stringify({ ok: true, results: [] }, null, 2) + '\n');
    } else {
      header('har control sync');
      info('No repositories selected to sync.');
    }
    return;
  }

  const { synced, failed, results } = await syncReposWithControl({
    repoPaths,
    apiUrl: argv.apiUrl,
    dryRun: argv.dryRun,
    cloud: argv.cloud,
    full: argv.full,
  });

  if (argv.json) {
    process.stdout.write(JSON.stringify({ ok: failed === 0, synced, failed, results }, null, 2) + '\n');
    if (failed > 0) return finishCommand(1);
    return;
  }

  header('har control sync');
  for (const result of results) {
    if (result.ok) {
      success(`Synced ${result.repoPath}`);
    } else {
      warn(`Failed ${result.repoPath}: ${result.error}`);
    }
  }
  if (synced > 0) {
    success(`Synced ${synced} ${synced === 1 ? 'repository' : 'repositories'}`);
  }
  if (failed > 0) {
    warn(`${failed} ${failed === 1 ? 'repository' : 'repositories'} could not be synced`);
    return finishCommand(1);
  }
}

const PORTAL_SOURCE_LABEL: Record<PortalUrlSource, string> = {
  flag: '--portal',
  env: 'HAR_PORTAL_URL',
  saved: 'saved login',
  default: 'default',
};

async function handleLogin(argv: { apiKey?: string; portal?: string }): Promise<void> {
  header('har control login');
  const { url: portalUrl, source } = resolvePortalUrl(argv.portal);
  info(`Portal: ${portalUrl} (${PORTAL_SOURCE_LABEL[source]})`);

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
    return finishCommand(1);
  }
}

async function handleTrajectory(argv: { state?: string }): Promise<void> {
  header('har control trajectory');

  if (!argv.state) {
    const enabled = readTelemetryPreference().portalTrajectory === true;
    info(`Trajectory forwarding: ${enabled ? 'on' : 'off'}`);
    if (!enabled) {
      info('Enable: har control trajectory on');
    }
    if (!isTelemetryEnabled()) {
      warn('Telemetry is off, so nothing is forwarded regardless of this setting.');
    }
    return;
  }

  const enabled = argv.state === 'on';
  writePortalTrajectoryPreference(enabled);

  if (!enabled) {
    success('Trajectory forwarding off — the portal receives token counts and events only.');
    return;
  }

  success('Trajectory forwarding on.');
  info(
    'Prompts, tool arguments and tool results now sync to the hosted portal, ' +
      'capped and redacted by the local policy (HAR_TRAJECTORY_MAX_PAYLOAD_BYTES).',
  );
  if (!isTelemetryEnabled()) {
    warn('Telemetry is off, so nothing is forwarded yet — enable it with har telemetry on.');
  }
}
