import inquirer from 'inquirer';
import type { Argv } from 'yargs';
import {
  DEFAULT_DEV_PORTAL_URL,
  DEFAULT_PORTAL_URL,
  resolvePortalUrl,
  type PortalUrlSource,
} from '../../core/control-config';
import { runPortalConnect } from '../../core/portal-connect';
import { attachReposToPortal, planRepoWorkspaceMap } from '../../core/portal-repo-map';
import {
  disconnectPortal,
  displayPortalTargetLabel,
  readPortalConnectionState,
  redactPortalTargetRecord,
} from '../../core/portal-targets';
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
            .option('json', { type: 'boolean', default: false })
            .option('yes', {
              alias: 'y',
              type: 'boolean',
              default: false,
              describe: 'Skip interactive prompts (portal URL and extra-repo mapping)',
            }),
        (argv) =>
          handleHqConnect(
            argv as {
              portal?: string;
              apiKey?: string;
              repo: string;
              json: boolean;
              yes: boolean;
              alias?: string;
              deprecated?: boolean;
            },
          ),
      )
      .command(
        'list',
        'Show the HAR HQ org connection and its attached repositories',
        (y: Argv) => y.option('json', { type: 'boolean', default: false }),
        (argv) => handleHqList(argv as { json: boolean }),
      )
      .command(
        'disconnect',
        'Remove the HAR HQ org connection (nothing syncs until you connect again)',
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

async function promptExtraRepoAttachments(currentRepo: string | null): Promise<string[]> {
  const plan = planRepoWorkspaceMap({ currentRepo });
  if (plan.kind === 'none') return [];

  const noun = plan.repos.length === 1 ? 'repository' : 'repositories';
  info(`${plan.repos.length} other registered ${noun}:`);
  for (const repoPath of plan.repos) info(`  ${repoPath}`);

  const { selected } = await inquirer.prompt<{ selected: string[] }>([
    {
      type: 'checkbox',
      name: 'selected',
      message: `Attach which of these ${plan.repos.length} ${noun} to ${plan.workspaceLabel}?`,
      choices: plan.repos.map((repoPath) => ({
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
  json?: boolean;
  yes?: boolean;
  alias?: string;
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
      alias: argv.alias,
    });
    const label = displayPortalTargetLabel(record);
    if (argv.json) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: true,
            connection: redactPortalTargetRecord(record),
            attachedRepo,
            replaced: replaced ? redactPortalTargetRecord(replaced) : null,
            detachedRepos,
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
      const extra = await promptExtraRepoAttachments(attachedRepo);
      for (const repoPath of extra) {
        success(`Attached ${repoPath}`);
      }
    }

    info('Sync: har control sync');
  } catch (err) {
    error(`Connect failed: ${(err as Error).message}`);
    return finishCommand(1);
  }
}

async function handleHqList(argv: { json: boolean }): Promise<void> {
  const { connection, attachedRepos } = readPortalConnectionState();

  if (argv.json) {
    process.stdout.write(
      JSON.stringify(
        {
          connection: connection
            ? { ...redactPortalTargetRecord(connection), label: displayPortalTargetLabel(connection) }
            : null,
          attachedRepos,
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
  if (attachedRepos.length === 0) {
    info('  repos: (none attached — run har hq connect from a repository)');
  } else {
    info(`  repos: ${attachedRepos.join(', ')}`);
  }
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
