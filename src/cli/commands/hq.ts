import inquirer from 'inquirer';
import type { Argv } from 'yargs';
import {
  DEFAULT_DEV_PORTAL_URL,
  DEFAULT_PORTAL_URL,
  resolvePortalUrl,
  type PortalUrlSource,
} from '../../core/control-config';
import {
  applyHqTrajectoryChoice,
  hqFullExperienceHint,
  hqTrajectoryForwarding,
  type HqTrajectoryApplyOutcome,
} from '../../core/hq-destination-migration';
import { describePortalSync, runPortalConnect } from '../../core/portal-connect';
import { attachReposToPortal, unattachedRegisteredRepos } from '../../core/portal-repo-map';
import {
  disconnectPortal,
  displayPortalTargetLabel,
  redactPortalTargetRecord,
  writePortalConnectionTrajectoryPreference,
} from '../../core/portal-targets';
import { describeTelemetryLevel, getTelemetryLevel } from '../../core/telemetry-config';
import { promptHqTrajectory } from '../telemetry-prompts';
import { error, header, info, success, warn } from '../../utils/logging';
import { finishCommand } from '../finish-command';

const PORTAL_SOURCE_LABEL: Record<PortalUrlSource, string> = {
  flag: '--portal',
  env: 'HAR_PORTAL_URL',
  saved: 'saved login',
  default: 'default',
};

export const hqCommand = {
  command: 'hq <subcommand>',
  describe: 'HAR HQ hosted portal (one org connection at a time)',
  builder: (yargs: Argv) =>
    yargs
      .command(
        'connect',
        'Connect to a HAR HQ org (browser SSO); replaces any connection to another org',
        (y: Argv) =>
          y
            .option('portal', {
              type: 'string',
              describe: `Portal base URL (or HAR_PORTAL_URL; default ${DEFAULT_PORTAL_URL})`,
            })
            .option('api-key', {
              type: 'string',
              describe: 'Store this ingest token directly instead of browser login',
            })
            .option('repo', {
              type: 'string',
              default: '.',
              describe: 'Repository to attach to the chosen workspace',
            })
            .option('trajectory', {
              type: 'boolean',
              describe:
                'Forward the full trajectory (prompts, replies, tool output) to this org. Asked interactively when omitted; off by default.',
            })
            .option('json', { type: 'boolean', default: false })
            .option('yes', {
              alias: 'y',
              type: 'boolean',
              default: false,
              describe: 'Skip interactive prompts (portal URL, extra-repo mapping, trajectory forwarding)',
            }),
        (argv) =>
          handleHqConnect(
            argv as {
              portal?: string;
              apiKey?: string;
              repo: string;
              trajectory?: boolean;
              json: boolean;
              yes: boolean;
              deprecated?: boolean;
            },
          ),
      )
      .command(
        ['list', 'status'],
        'Show the HAR HQ org connection, its attached repositories and what it receives',
        (y: Argv) => y.option('json', { type: 'boolean', default: false }),
        (argv) => handleHqList(argv as { json: boolean }),
      )
      .command(
        'disconnect',
        'Remove the HAR HQ org connection (nothing is sent to HQ until you connect again)',
        (y: Argv) => y.option('json', { type: 'boolean', default: false }),
        (argv) => handleHqDisconnect(argv as { json: boolean }),
      )
      .demandCommand(1, 'Please specify a subcommand: connect, list, disconnect'),
  handler: () => {},
};

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

async function resolveConnectPortalUrl(
  explicit?: string,
  skipPrompt?: boolean,
): Promise<{ url: string; source: PortalUrlSource }> {
  if (explicit?.trim()) return resolvePortalUrl(explicit);
  if (process.env.HAR_PORTAL_URL?.trim()) return resolvePortalUrl();
  if (skipPrompt || !isInteractive()) return resolvePortalUrl();

  const { choice } = await inquirer.prompt<{ choice: 'prod' | 'dev' | 'custom' }>([
    {
      type: 'list',
      name: 'choice',
      message: 'Where should this repository connect?',
      choices: [
        { name: `Production (${DEFAULT_PORTAL_URL})`, value: 'prod' },
        { name: `Development (${DEFAULT_DEV_PORTAL_URL})`, value: 'dev' },
        { name: 'Custom URL', value: 'custom' },
      ],
    },
  ]);

  if (choice === 'prod') return { url: DEFAULT_PORTAL_URL, source: 'flag' };
  if (choice === 'dev') return { url: DEFAULT_DEV_PORTAL_URL, source: 'flag' };

  const { url } = await inquirer.prompt<{ url: string }>([
    {
      type: 'input',
      name: 'url',
      message: 'Portal URL',
      default: DEFAULT_PORTAL_URL,
    },
  ]);
  return resolvePortalUrl(url);
}

async function promptExtraRepoAttachments(
  currentRepo: string | null,
  orgLabel: string,
): Promise<string[]> {
  const repos = unattachedRegisteredRepos(currentRepo);
  if (repos.length === 0) return [];

  const noun = repos.length === 1 ? 'repository' : 'repositories';
  info(`${repos.length} other registered ${noun}:`);
  for (const repoPath of repos) info(`  ${repoPath}`);

  const { selected } = await inquirer.prompt<{ selected: string[] }>([
    {
      type: 'checkbox',
      name: 'selected',
      message: `Attach which of these ${repos.length} ${noun} to ${orgLabel}?`,
      choices: repos.map((repoPath) => ({
        name: repoPath,
        value: repoPath,
        checked: true,
      })),
    },
  ]);
  return attachReposToPortal(selected);
}

export async function handleHqConnect(argv: {
  portal?: string;
  apiKey?: string;
  repo?: string;
  trajectory?: boolean;
  json?: boolean;
  yes?: boolean;
  deprecated?: boolean;
}): Promise<void> {
  if (argv.deprecated) {
    warn('har control login is deprecated — use har hq connect');
  }

  const { url: portalUrl, source } = await resolveConnectPortalUrl(argv.portal, argv.yes);
  if (!argv.json) {
    header('har hq connect');
    info(`Portal: ${portalUrl} (${PORTAL_SOURCE_LABEL[source]})`);
  }

  try {
    const { record, attachedRepo, replaced, detachedRepos } = await runPortalConnect({
      portalUrl,
      apiKey: argv.apiKey,
      repoPath: argv.repo ?? '.',
    });
    const label = displayPortalTargetLabel(record);
    if (argv.trajectory !== undefined) {
      writePortalConnectionTrajectoryPreference(argv.trajectory);
    }
    // Non-interactive (agents, --yes, --json): the destination follows the saved choice now.
    const askTrajectory =
      argv.trajectory === undefined && !argv.json && !argv.yes && isInteractive() && getTelemetryLevel() === 'full';
    const destination = askTrajectory ? undefined : connectHqDestination();
    if (argv.json) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: true,
            connection: redactPortalTargetRecord(record),
            attachedRepo,
            replaced: replaced ? redactPortalTargetRecord(replaced) : null,
            detachedRepos,
            trajectoryForwarding: hqTrajectoryForwarding(),
            destination: destination && 'destinations' in destination ? destination.destinations : null,
            hint: hqFullExperienceHint() ?? null,
          },
          null,
          2,
        ) + '\n',
      );
      return;
    }
    if (replaced) {
      warn(
        `Switched org: ${displayPortalTargetLabel(replaced)} → ${label}. ` +
          'Nothing is sent to the previous org any more.',
      );
      if (detachedRepos.length > 0) {
        const noun = detachedRepos.length === 1 ? 'repository' : 'repositories';
        info(`${detachedRepos.length} ${noun} attached to the previous org no longer sync:`);
        for (const repoPath of detachedRepos) info(`  ${repoPath}`);
      }
    }
    success(`Connected to ${label}`);
    if (record.email) info(`Account: ${record.email}`);
    if (attachedRepo) {
      success(`Attached ${attachedRepo}`);
    } else {
      info('No local repository attached (run this from a repo, or pass --repo).');
    }

    if (!argv.yes && isInteractive()) {
      const extra = await promptExtraRepoAttachments(attachedRepo, label);
      for (const repoPath of extra) {
        success(`Attached ${repoPath}`);
      }
    }

    // Only the Full level records text, so only then is forwarding a choice.
    let outcome = destination;
    if (askTrajectory) {
      const forward = await promptHqTrajectory(label, record.trajectoryForwarding === true);
      writePortalConnectionTrajectoryPreference(forward);
      outcome = connectHqDestination();
    }

    printHqDestinationOutcome(outcome);
    printHqTrajectorySummary();
  } catch (err) {
    error(`Connect failed: ${(err as Error).message}`);
    return finishCommand(1);
  }
}

/**
 * Connecting is consent to send to the hosted receiver: add (or align) the
 * `hq` destination, the trajectory (logs) only when forwarding is on.
 */
function connectHqDestination(): HqTrajectoryApplyOutcome | { status: 'error'; message: string } {
  try {
    return applyHqTrajectoryChoice(hqTrajectoryForwarding(), { addMissing: true });
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

function printHqDestinationOutcome(
  outcome: HqTrajectoryApplyOutcome | { status: 'error'; message: string } | undefined,
): void {
  if (!outcome) return;
  switch (outcome.status) {
    case 'added':
    case 'updated':
      for (const destination of outcome.destinations) {
        success(
          `${outcome.status === 'added' ? 'Added' : 'Updated'} destination "${destination.name}": ${destination.signals.join(', ')}, records, proofs, evidence`,
        );
      }
      return;
    case 'no-base-url':
      warn('The hosted receiver ingest URL is unknown, so nothing is sent there: har telemetry destination add hq --preset hq --base-url <ingest base URL>');
      return;
    case 'error':
      warn(`Could not add the hq destination: ${outcome.message}`);
      return;
    default:
      return;
  }
}

const HQ_TRAJECTORY_LABEL = {
  none: 'nothing (telemetry is off)',
  usage: 'tokens and cost',
  outline: 'tokens, cost and the step outline (no text)',
  full: 'the full trajectory (prompts, replies, tool output)',
} as const;

/** One line on what HQ receives for agent sessions, and how to get more. */
function printHqTrajectorySummary(): void {
  const overview = describePortalSync();
  const level = describeTelemetryLevel(overview.telemetryLevel);
  info(`  telemetry: ${level.label} (local level — har telemetry on --level <level>)`);
  info(`  HQ receives: ${HQ_TRAJECTORY_LABEL[overview.hqTrajectory]}`);
  const hint = hqFullExperienceHint();
  if (hint) info(`  ${hint}`);
}

async function handleHqList(argv: { json: boolean }): Promise<void> {
  const overview = describePortalSync();
  const { connection } = overview;

  if (argv.json) {
    process.stdout.write(
      JSON.stringify(
        {
          connection: connection
            ? { ...redactPortalTargetRecord(connection), label: displayPortalTargetLabel(connection) }
            : null,
          attachedRepos: overview.repos.map((repo) => repo.repoPath),
          repos: overview.repos,
          telemetryLevel: overview.telemetryLevel,
          trajectoryForwarding: overview.trajectoryForwarding,
          hqTrajectory: overview.hqTrajectory,
          hint: hqFullExperienceHint() ?? null,
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  header('har hq list');
  if (!connection) {
    info('Not connected to a HAR HQ org.');
    info('Connect with: har hq connect');
    return;
  }

  info(displayPortalTargetLabel(connection));
  info(`  portal: ${connection.portalUrl}`);
  if (connection.email) info(`  account: ${connection.email}`);
  if (overview.repos.length === 0) {
    info('  repos: (none attached — run har hq connect from a repository)');
  } else {
    info('  repos:');
    for (const repo of overview.repos) {
      if (repo.sendsToHq) {
        info(`    ${repo.repoPath}`);
      } else {
        warn(
          `    ${repo.repoPath} — kept local-only, nothing is sent. ` +
            `Send it: har control register --repo ${repo.repoPath} --portal`,
        );
      }
    }
  }
  printHqTrajectorySummary();
}

async function handleHqDisconnect(argv: { json: boolean }): Promise<void> {
  const removed = disconnectPortal();
  if (!removed) {
    error('Not connected to a HAR HQ org.');
    return finishCommand(1);
  }

  if (argv.json) {
    process.stdout.write(JSON.stringify({ removed: redactPortalTargetRecord(removed) }, null, 2) + '\n');
    return;
  }
  header('har hq disconnect');
  success(`Disconnected ${displayPortalTargetLabel(removed)}`);
}
