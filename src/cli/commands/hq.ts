import inquirer from 'inquirer';
import type { Argv } from 'yargs';
import {
  DEFAULT_DEV_PORTAL_URL,
  DEFAULT_PORTAL_URL,
  resolvePortalUrl,
  type PortalUrlSource,
} from '../../core/control-config';
import { runPortalConnect } from '../../core/portal-connect';
import {
  applyRepoWorkspaceMap,
  planRepoWorkspaceMap,
  remainingConnections,
  remainingUnassignedRepos,
} from '../../core/portal-repo-map';
import {
  displayPortalTargetLabel,
  findPortalTargetRecord,
  listPortalTargetRecords,
  readPortalTargetsStore,
  redactPortalTargetRecord,
  removePortalTarget,
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
  describe: 'HAR HQ hosted portal (workspaces, connections)',
  builder: (yargs: Argv) =>
    yargs
      .command(
        'connect',
        'Connect this repository to a HAR HQ workspace (browser SSO)',
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
        'List saved HAR HQ connections and attached repositories',
        (y: Argv) => y.option('json', { type: 'boolean', default: false }),
        (argv) => handleHqList(argv as { json: boolean }),
      )
      .command(
        'disconnect [name]',
        'Remove a saved HAR HQ connection',
        (y: Argv) =>
          y
            .positional('name', {
              type: 'string',
              describe: 'Workspace name, alias, or "name @ host"',
            })
            .option('json', { type: 'boolean', default: false })
            .option('yes', {
              alias: 'y',
              type: 'boolean',
              default: false,
              describe: 'Do not prompt when multiple connections exist',
            }),
        (argv) =>
          handleHqDisconnect(argv as { name?: string; json: boolean; yes: boolean }),
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

async function promptExtraRepoAttachments(opts: {
  currentRepo: string | null;
  currentAlias: string;
}): Promise<string[]> {
  const plan = planRepoWorkspaceMap(opts);
  if (plan.kind === 'none') return [];

  const noun = plan.repos.length === 1 ? 'repository' : 'repositories';
  info(`${plan.repos.length} other registered ${noun}:`);
  for (const repoPath of plan.repos) info(`  ${repoPath}`);

  if (plan.kind === 'attach-more') {
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
    return applyRepoWorkspaceMap(
      selected.map((repoPath) => ({ repoPath, alias: plan.workspaceAlias })),
    );
  }

  const { sendAll } = await inquirer.prompt<{ sendAll: boolean }>([
    {
      type: 'confirm',
      name: 'sendAll',
      message: `Send all ${plan.repos.length} ${noun} to the same workspace?`,
      default: true,
    },
  ]);

  if (sendAll) {
    const { alias } = await inquirer.prompt<{ alias: string }>([
      {
        type: 'list',
        name: 'alias',
        message: 'Which workspace?',
        default: plan.currentAlias,
        choices: plan.connections.map((entry) => ({
          name: entry.label,
          value: entry.alias,
        })),
      },
    ]);
    return applyRepoWorkspaceMap(plan.repos.map((repoPath) => ({ repoPath, alias })));
  }

  const attached: string[] = [];
  let remainingRepos = [...plan.repos];
  let remainingOrgs = [...plan.connections];
  while (remainingRepos.length > 0 && remainingOrgs.length > 0) {
    const left = remainingRepos.length === 1 ? 'repository' : 'repositories';
    info(`${remainingRepos.length} ${left} left to assign.`);
    const { alias } = await inquirer.prompt<{ alias: string }>([
      {
        type: 'list',
        name: 'alias',
        message: 'Workspace to assign repositories to',
        default:
          remainingOrgs.some((entry) => entry.alias === plan.currentAlias)
            ? plan.currentAlias
            : remainingOrgs[0]?.alias,
        choices: [
          ...remainingOrgs.map((entry) => ({
            name: entry.label,
            value: entry.alias,
          })),
          { name: 'Done — leave the rest unattached', value: '' },
        ],
      },
    ]);
    if (!alias) break;
    const { selected } = await inquirer.prompt<{ selected: string[] }>([
      {
        type: 'checkbox',
        name: 'selected',
        message: `Repositories for ${remainingOrgs.find((entry) => entry.alias === alias)?.label ?? alias}`,
        choices: remainingRepos.map((repoPath) => ({ name: repoPath, value: repoPath })),
      },
    ]);
    if (selected.length > 0) {
      attached.push(...applyRepoWorkspaceMap(selected.map((repoPath) => ({ repoPath, alias }))));
    }
    remainingRepos = remainingUnassignedRepos(remainingRepos, selected);
    remainingOrgs = remainingConnections(remainingOrgs, [alias]);
  }
  return attached;
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
    const { record, attachedRepo, extraAttached, mappedInBrowser } = await runPortalConnect({
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
          },
          null,
          2,
        ) + '\n',
      );
      return;
    }
    success(`Connected to ${label}`);
    if (record.email) info(`Account: ${record.email}`);
    if (attachedRepo) {
      success(`Attached ${attachedRepo}`);
    } else {
      info('No local repository attached (run this from a repo, or pass --repo).');
    }
    for (const repoPath of extraAttached) {
      success(`Attached ${repoPath}`);
    }

    if (!argv.json && !argv.yes && !mappedInBrowser && isInteractive()) {
      const extra = await promptExtraRepoAttachments({
        currentRepo: attachedRepo,
        currentAlias: record.alias,
      });
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
  const store = readPortalTargetsStore();
  const records = listPortalTargetRecords();
  const connections = records.map((record) => {
    const attachedRepos = Object.entries(store.repoTargets ?? {})
      .filter(([, aliases]) => aliases.includes(record.alias))
      .map(([repoPath]) => repoPath);
    return {
      ...redactPortalTargetRecord(record),
      label: displayPortalTargetLabel(record),
      attachedRepos,
    };
  });

  if (argv.json) {
    process.stdout.write(JSON.stringify({ connections }, null, 2) + '\n');
    return;
  }

  header('har hq list');
  if (records.length === 0) {
    info('No HAR HQ connections yet.');
    info('Add one with: har hq connect');
    return;
  }

  for (const record of records) {
    const attachedRepos = Object.entries(store.repoTargets ?? {})
      .filter(([, aliases]) => aliases.includes(record.alias))
      .map(([repoPath]) => repoPath);
    info(displayPortalTargetLabel(record));
    info(`  portal: ${record.portalUrl}`);
    if (record.email) info(`  account: ${record.email}`);
    if (attachedRepos.length === 0) {
      info('  repos: (none attached — run har hq connect from a repository)');
    } else {
      info(`  repos: ${attachedRepos.join(', ')}`);
    }
  }
}

async function handleHqDisconnect(argv: {
  name?: string;
  json: boolean;
  yes: boolean;
}): Promise<void> {
  const records = listPortalTargetRecords();
  if (records.length === 0) {
    error('No HAR HQ connections saved.');
    return finishCommand(1);
  }

  let record = argv.name ? findPortalTargetRecord(argv.name) : null;
  if (argv.name && !record) {
    error(`Unknown connection "${argv.name}".`);
    info('See: har hq list');
    return finishCommand(1);
  }

  if (!record) {
    if (records.length === 1) {
      record = records[0];
    } else if (isInteractive() && !argv.yes) {
      const { selected } = await inquirer.prompt<{ selected: string }>([
        {
          type: 'list',
          name: 'selected',
          message: 'Disconnect which connection?',
          choices: records.map((entry) => ({
            name: displayPortalTargetLabel(entry),
            value: entry.alias,
          })),
        },
      ]);
      record = findPortalTargetRecord(selected);
    } else {
      error('Multiple connections saved — pass a workspace name (see har hq list).');
      return finishCommand(1);
    }
  }

  if (!record) {
    error('Could not resolve which connection to disconnect.');
    return finishCommand(1);
  }

  const label = displayPortalTargetLabel(record);
  removePortalTarget(record.alias);
  if (argv.json) {
    process.stdout.write(JSON.stringify({ removed: redactPortalTargetRecord(record) }, null, 2) + '\n');
    return;
  }
  header('har hq disconnect');
  success(`Disconnected ${label}`);
}