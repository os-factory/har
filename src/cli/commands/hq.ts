import inquirer from 'inquirer';
import type { Argv } from 'yargs';
import {
  DEFAULT_DEV_PORTAL_URL,
  DEFAULT_PORTAL_URL,
  resolvePortalUrl,
  type PortalUrlSource,
} from '../../core/control-config';
import {
  CONTENT_LABELS,
  SCOPE_LABELS,
  describeRepositoryEntry,
  isRepositoryContent,
  isRepositoryScope,
  resolveRepositoryReference,
  type RepositoryReference,
} from '../../core/destination-scopes';
import {
  alignHqDestinationAfterLogin,
  chooseHqRepositories,
  defaultHqScope,
  hqRepositoryCandidates,
  listHqRepositories,
  removeHqRepositories,
  type HqRepositoryCandidate,
  type HqRepositoryChoice,
} from '../../core/hq-repositories';
import { hqLoginDefaults } from '../../core/hq-upgrade';
import { describeHqStatus, runPortalConnect, type HqStatus } from '../../core/portal-connect';
import {
  disconnectPortal,
  displayPortalTargetLabel,
  redactPortalTargetRecord,
} from '../../core/portal-targets';
import { describeTelemetryLevel, getTelemetryLevel, levelIncludes } from '../../core/telemetry-config';
import {
  DESTINATION_REPOSITORY_CONTENT,
  DESTINATION_REPOSITORY_SCOPES,
  type DestinationRepository,
  type DestinationRepositoryContent,
  type DestinationRepositoryScope,
} from '../../harness/schema';
import { error, header, info, success, warn } from '../../utils/logging';
import { finishCommand } from '../finish-command';

const PORTAL_SOURCE_LABEL: Record<PortalUrlSource, string> = {
  flag: '--portal',
  env: 'HAR_PORTAL_URL',
  saved: 'saved login',
  default: 'default',
};

interface ScopeFlags {
  repo?: string[];
  scope?: string;
  content?: string;
}

function scopeOptions(y: Argv, repoDescribe: string): Argv {
  return y
    .option('repo', {
      type: 'string',
      array: true,
      describe: repoDescribe,
    })
    .option('scope', {
      type: 'string',
      choices: [...DESTINATION_REPOSITORY_SCOPES],
      describe:
        'What HAR HQ receives for these repositories: off (nothing), usage (records, verification, tokens, cost), outline (+ every step, no text), full (+ text, see --content)',
    })
    .option('content', {
      type: 'string',
      choices: [...DESTINATION_REPOSITORY_CONTENT],
      describe: 'Text at the full scope: none (default), redacted, masked or raw',
    });
}

export const hqCommand = {
  command: 'hq <subcommand>',
  describe: 'HAR HQ hosted portal: log in, and choose which repositories it receives',
  builder: (yargs: Argv) =>
    yargs
      .command(
        'connect',
        'Log in to a HAR HQ org (browser SSO), then choose which repositories it receives and at what scope',
        (y: Argv) =>
          scopeOptions(
            y
              .option('portal', {
                type: 'string',
                describe: `Portal base URL (or HAR_PORTAL_URL; default ${DEFAULT_PORTAL_URL})`,
              })
              .option('api-key', {
                type: 'string',
                describe: 'Store this ingest token directly instead of browser login',
              })
              .option('trajectory', {
                type: 'boolean',
                hidden: true,
                describe: 'Removed in 2.0: use --scope full --content raw',
              })
              .option('json', { type: 'boolean', default: false })
              .option('yes', {
                alias: 'y',
                type: 'boolean',
                default: false,
                describe: 'Never prompt: log in, and choose repositories only from --repo/--scope',
              }),
            'Repository to send (local path or repository URL; repeatable). Default with --scope: the current repository',
          ),
        (argv) => handleHqConnect(argv as unknown as HqConnectArgs),
      )
      .command(
        'repos [action] [repos..]',
        'List, add or remove the repositories HAR HQ receives',
        (y: Argv) =>
          scopeOptions(
            y
              .positional('action', {
                type: 'string',
                choices: ['list', 'add', 'remove'],
                default: 'list',
              })
              .positional('repos', {
                type: 'string',
                array: true,
                describe: 'Local paths or repository URLs (default: the current repository)',
              })
              .option('json', { type: 'boolean', default: false })
              .option('yes', { alias: 'y', type: 'boolean', default: false, describe: 'Never prompt' }),
            'Repository (local path or repository URL; repeatable), in addition to the positional ones',
          ),
        (argv) => handleHqRepos(argv as unknown as HqReposArgs),
      )
      .command(
        ['status', 'list'],
        'Show the HAR HQ login and which repositories it receives, at which scope',
        (y: Argv) => y.option('json', { type: 'boolean', default: false }),
        (argv) => handleHqStatus(argv as { json: boolean }),
      )
      .command(
        'disconnect',
        'Log out of HAR HQ (nothing is sent there until you connect again)',
        (y: Argv) => y.option('json', { type: 'boolean', default: false }),
        (argv) => handleHqDisconnect(argv as { json: boolean }),
      )
      .demandCommand(1, 'Please specify a subcommand: connect, repos, status, disconnect'),
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
      message: 'Where should this machine log in?',
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

/** The current directory as a repository, when it is one (has a `.git` above it). */
function currentRepository(): RepositoryReference | null {
  try {
    const reference = resolveRepositoryReference('.');
    return reference.path ? reference : null;
  } catch {
    return null;
  }
}

/** Parse `--scope` / `--content`; throws on a content without the full scope. */
function parseScopeFlags(flags: ScopeFlags): { scope?: DestinationRepositoryScope; content?: DestinationRepositoryContent } {
  const scope = flags.scope;
  const content = flags.content;
  if (scope !== undefined && !isRepositoryScope(scope)) throw new Error(`--scope must be one of ${DESTINATION_REPOSITORY_SCOPES.join(', ')}`);
  if (content !== undefined && !isRepositoryContent(content)) {
    throw new Error(`--content must be one of ${DESTINATION_REPOSITORY_CONTENT.join(', ')}`);
  }
  if (content !== undefined && content !== 'none' && scope !== 'full') {
    throw new Error('--content applies to --scope full only');
  }
  return { ...(scope ? { scope } : {}), ...(content ? { content } : {}) };
}

/** The exact command that chooses repositories later. */
function chooseCommand(repos: readonly string[], scope = 'usage'): string {
  const targets = repos.length > 0 ? repos : ['.'];
  return `har hq repos add ${targets.map(shellWord).join(' ')} --scope ${scope}`;
}

function shellWord(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function scopeChoices(): { name: string; value: DestinationRepositoryScope; short: string }[] {
  return (['full', 'outline', 'usage', 'off'] as const).map((scope) => ({
    name: SCOPE_LABELS[scope],
    value: scope,
    short: scope,
  }));
}

function contentChoices(): { name: string; value: DestinationRepositoryContent; short: string }[] {
  return (['none', 'masked', 'redacted', 'raw'] as const).map((content) => ({
    name: CONTENT_LABELS[content],
    value: content,
    short: content,
  }));
}

const PER_REPOSITORY = '__per-repository__';

async function promptContent(message: string, current: DestinationRepositoryContent): Promise<DestinationRepositoryContent> {
  const { content } = await inquirer.prompt<{ content: DestinationRepositoryContent }>([
    { type: 'list', name: 'content', message, choices: contentChoices(), default: current },
  ]);
  return content;
}

async function promptScope(
  message: string,
  current: { scope: DestinationRepositoryScope; content: DestinationRepositoryContent },
  allowPerRepository: boolean,
): Promise<{ scope: DestinationRepositoryScope; content: DestinationRepositoryContent } | 'per-repository'> {
  const { scope } = await inquirer.prompt<{ scope: string }>([
    {
      type: 'list',
      name: 'scope',
      message,
      choices: [
        ...scopeChoices(),
        ...(allowPerRepository ? [{ name: 'Choose per repository…', value: PER_REPOSITORY, short: 'per repository' }] : []),
      ],
      default: current.scope,
    },
  ]);
  if (scope === PER_REPOSITORY) return 'per-repository';
  const chosen = scope as DestinationRepositoryScope;
  if (chosen !== 'full') return { scope: chosen, content: 'none' };
  const content = await promptContent(
    'Prompts, agent replies and tool output: how should HAR HQ receive the text?',
    current.content,
  );
  return { scope: chosen, content };
}

function candidateLabel(candidate: HqRepositoryCandidate): string {
  const notes = [
    ...(candidate.current ? ['this repository'] : []),
    ...(candidate.chosen ? [`now: ${candidate.chosen.scope}`] : []),
    ...(!candidate.chosen && candidate.attachedIn1x ? ['sent in 1.x'] : []),
    ...(!candidate.url ? ['no origin remote: records only'] : []),
  ];
  return notes.length > 0 ? `${candidate.path}  (${notes.join(', ')})` : candidate.path;
}

/** Interactive: which repositories, then one scope for all (or one per repository). */
async function promptRepositoryChoices(orgLabel: string, currentRepo: string | null): Promise<HqRepositoryChoice[]> {
  const defaults = hqLoginDefaults();
  const candidates = hqRepositoryCandidates(currentRepo, { attachedIn1x: defaults?.repositories ?? [] });
  if (candidates.length === 0) {
    info('No repository registered on this machine yet: run har hq repos add <path> --scope usage from one later.');
    return [];
  }
  const { selected } = await inquirer.prompt<{ selected: string[] }>([
    {
      type: 'checkbox',
      name: 'selected',
      message: `Which repositories should ${orgLabel} receive? (space to toggle; nothing else is sent)`,
      choices: candidates.map((candidate) => ({
        name: candidateLabel(candidate),
        value: candidate.path,
        checked: candidate.preselected,
      })),
    },
  ]);
  const unselected = candidates.filter((candidate) => candidate.chosen && candidate.chosen.scope !== 'off' && !selected.includes(candidate.path));
  const picked = candidates.filter((candidate) => selected.includes(candidate.path));
  const offs: HqRepositoryChoice[] = unselected.map((candidate) => ({ reference: referenceOf(candidate), scope: 'off' }));
  if (picked.length === 0) return offs;

  const preset = picked.find((candidate) => candidate.chosen && candidate.chosen.scope !== 'off')?.chosen;
  const current = preset
    ? { scope: preset.scope, content: preset.content ?? 'none' }
    : defaultHqScope(defaults);
  const answer = await promptScope(
    picked.length === 1 ? `What should ${orgLabel} receive from it?` : `What should ${orgLabel} receive from these ${picked.length} repositories?`,
    current,
    picked.length > 1,
  );
  if (answer !== 'per-repository') {
    return [...offs, ...picked.map((candidate) => ({ reference: referenceOf(candidate), ...answer }))];
  }
  const choices: HqRepositoryChoice[] = [...offs];
  for (const candidate of picked) {
    const own = candidate.chosen && candidate.chosen.scope !== 'off'
      ? { scope: candidate.chosen.scope, content: candidate.chosen.content ?? 'none' }
      : current;
    const one = await promptScope(`${candidate.path}:`, own, false);
    if (one !== 'per-repository') choices.push({ reference: referenceOf(candidate), ...one });
  }
  return choices;
}

function referenceOf(candidate: HqRepositoryCandidate): RepositoryReference {
  return { path: candidate.path, ...(candidate.url ? { url: candidate.url } : {}) };
}

/** What the local level lets through, said once when it caps a chosen scope. */
function levelCapNote(entries: readonly DestinationRepository[]): string | undefined {
  const level = getTelemetryLevel();
  const highest = entries.reduce<DestinationRepositoryScope>(
    (top, entry) => (DESTINATION_REPOSITORY_SCOPES.indexOf(entry.scope) > DESTINATION_REPOSITORY_SCOPES.indexOf(top) ? entry.scope : top),
    'off',
  );
  if (highest === 'off' || highest === 'usage' || levelIncludes(level, highest)) return undefined;
  return `This machine records agent activity at the ${describeTelemetryLevel(level).label} level, so HAR HQ gets at most that: har telemetry on --level ${highest}`;
}

function printChosen(entries: readonly DestinationRepository[], orgLabel: string): void {
  const sent = entries.filter((entry) => entry.scope !== 'off');
  const off = entries.filter((entry) => entry.scope === 'off');
  for (const entry of sent) success(`${orgLabel} receives ${describeRepositoryEntry(entry)}`);
  for (const entry of off) info(`Not sent: ${entry.path ?? entry.url}`);
  const note = levelCapNote(sent);
  if (note) info(note);
}

interface HqConnectArgs extends ScopeFlags {
  portal?: string;
  apiKey?: string;
  trajectory?: boolean;
  json?: boolean;
  yes?: boolean;
  deprecated?: boolean;
}

export async function handleHqConnect(argv: HqConnectArgs): Promise<void> {
  if (argv.deprecated) {
    warn('har control login is deprecated — use har hq connect');
  }
  let flags: ReturnType<typeof parseScopeFlags>;
  try {
    flags = parseScopeFlags(argv);
  } catch (err) {
    error((err as Error).message);
    return finishCommand(1);
  }
  if (argv.trajectory !== undefined && !argv.json) {
    warn('--trajectory no longer applies: HAR HQ receives each repository at the scope you choose (--scope full --content raw).');
  }

  const { url: portalUrl, source } = await resolveConnectPortalUrl(argv.portal, argv.yes || argv.json);
  if (!argv.json) {
    header('har hq connect');
    info(`Portal: ${portalUrl} (${PORTAL_SOURCE_LABEL[source]})`);
  }

  const current = currentRepository();
  const repoFlags = argv.repo ?? [];
  try {
    const { record, replaced } = await runPortalConnect({
      portalUrl,
      apiKey: argv.apiKey,
      ...(current?.path ? { repoPath: current.path } : {}),
    });
    const label = displayPortalTargetLabel(record);
    const forgotten = alignHqDestinationAfterLogin({ switchedOrg: replaced !== null });

    // Repositories and scope: from the flags, else asked on a TTY, else none (print the command).
    let choices: HqRepositoryChoice[] | undefined;
    if (flags.scope) {
      const references = repoFlags.length > 0 ? repoFlags.map((repo) => resolveRepositoryReference(repo)) : current ? [current] : [];
      if (references.length === 0) throw new Error('--scope needs --repo <path|url> outside a repository');
      choices = references.map((reference) => ({ reference, scope: flags.scope!, ...(flags.content ? { content: flags.content } : {}) }));
    }
    const ask = !choices && !argv.yes && !argv.json && isInteractive();

    if (!argv.json) {
      if (replaced) {
        warn(`Switched org: ${displayPortalTargetLabel(replaced)} → ${label}. Nothing is sent to the previous org any more.`);
        if (forgotten.length > 0) info(`${forgotten.length} repositories chosen for the previous org are no longer sent; choose again below.`);
      }
      success(`Logged in to ${label}`);
      if (record.email) info(`Account: ${record.email}`);
    }

    if (ask) choices = await promptRepositoryChoices(label, current?.path ?? null);
    const written = choices && choices.length > 0 ? chooseHqRepositories(choices) : undefined;

    if (argv.json) {
      const status = describeHqStatus();
      process.stdout.write(
        JSON.stringify(
          {
            ok: true,
            connection: redactPortalTargetRecord(record),
            replaced: replaced ? redactPortalTargetRecord(replaced) : null,
            chosen: written?.entries ?? [],
            repositories: status.repositories,
            next: status.repositories.some((entry) => entry.scope !== 'off') ? null : chooseCommand(repoFlags),
          },
          null,
          2,
        ) + '\n',
      );
      return;
    }

    if (written) {
      printChosen(written.entries, label);
    } else if (!ask) {
      const chosen = listHqRepositories().filter((entry) => entry.scope !== 'off');
      if (chosen.length > 0) {
        info(`${label} keeps receiving ${chosen.length === 1 ? 'the repository' : `the ${chosen.length} repositories`} chosen before:`);
        for (const entry of chosen) info(`  ${describeRepositoryEntry(entry)}`);
      } else {
        info('No repository chosen: nothing is sent to HAR HQ yet. Choose with:');
        info(`  ${chooseCommand(repoFlags)}`);
        info('  (scopes: off, usage, outline, full; with full, --content none|redacted|masked|raw)');
      }
    } else {
      info('No repository chosen: nothing is sent to HAR HQ. Choose later with: har hq repos add <repo> --scope usage');
    }
    printAgentTelemetryNote(describeHqStatus());
  } catch (err) {
    error(`Connect failed: ${(err as Error).message}`);
    return finishCommand(1);
  }
}

function printAgentTelemetryNote(status: HqStatus): void {
  if (status.agentTelemetryScoped === false && status.repositories.some((entry) => entry.scope !== 'off')) {
    info(
      'The installed otel-hook cannot filter by repository, so HAR HQ gets records and verification only (no agent telemetry) until it is upgraded: har telemetry on',
    );
  }
}

interface HqReposArgs extends ScopeFlags {
  action?: string;
  repos?: string[];
  json?: boolean;
  yes?: boolean;
}

async function handleHqRepos(argv: HqReposArgs): Promise<void> {
  const action = argv.action ?? 'list';
  if (action === 'list') return handleHqStatus({ json: argv.json === true });
  let flags: ReturnType<typeof parseScopeFlags>;
  try {
    flags = parseScopeFlags(argv);
  } catch (err) {
    error((err as Error).message);
    return finishCommand(1);
  }
  const named = [...(argv.repos ?? []), ...(argv.repo ?? [])];
  try {
    const references = (named.length > 0 ? named : ['.']).map((repo) => resolveRepositoryReference(repo));
    if (action === 'remove') {
      const removed = removeHqRepositories(references);
      if (argv.json) {
        process.stdout.write(JSON.stringify({ removed, repositories: listHqRepositories() }, null, 2) + '\n');
        return;
      }
      if (removed === 0) info('None of these repositories was sent to HAR HQ.');
      else success(`HAR HQ no longer receives ${removed === 1 ? 'this repository' : `these ${removed} repositories`}.`);
      return;
    }

    let scope = flags.scope;
    let content = flags.content;
    if (!scope) {
      if (argv.yes || argv.json || !isInteractive()) {
        error(`Choose a scope: ${chooseCommand(named)}   (off, usage, outline, full; with full, --content none|redacted|masked|raw)`);
        return finishCommand(1);
      }
      const answer = await promptScope('What should HAR HQ receive from it?', defaultHqScope(hqLoginDefaults()), false);
      if (answer === 'per-repository') return;
      scope = answer.scope;
      content = answer.content;
    }
    const written = chooseHqRepositories(references.map((reference) => ({ reference, scope: scope!, ...(content ? { content } : {}) })));
    if (argv.json) {
      process.stdout.write(JSON.stringify({ chosen: written.entries, repositories: written.destination.repositories ?? [] }, null, 2) + '\n');
      return;
    }
    printChosen(written.entries, 'HAR HQ');
    if (!describeHqStatus().connection && !process.env.HAR_PORTAL_TOKEN) {
      info('Not logged in: nothing is sent until you log in with har hq connect.');
    }
    printAgentTelemetryNote(describeHqStatus());
  } catch (err) {
    error((err as Error).message);
    return finishCommand(1);
  }
}

async function handleHqStatus(argv: { json: boolean }): Promise<void> {
  const status = describeHqStatus();
  const { connection } = status;

  if (argv.json) {
    process.stdout.write(
      JSON.stringify(
        {
          connection: connection
            ? { ...redactPortalTargetRecord(connection), label: displayPortalTargetLabel(connection) }
            : null,
          envToken: status.envToken,
          repositories: status.repositories,
          destinationEnabled: status.destinationEnabled,
          telemetryLevel: status.telemetryLevel,
          agentTelemetryScoped: status.agentTelemetryScoped,
          hint: status.hint ?? null,
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  header('har hq status');
  if (connection) {
    info(displayPortalTargetLabel(connection));
    info(`  portal: ${connection.portalUrl}`);
    if (connection.email) info(`  account: ${connection.email}`);
  } else if (status.envToken) {
    info('Using HAR_PORTAL_TOKEN (no stored login).');
  } else {
    info('Not logged in to HAR HQ: nothing is sent there.');
  }
  if (status.repositories.length === 0) {
    info('  repositories: none chosen — nothing is sent (har hq repos add <repo> --scope usage)');
  } else {
    info('  repositories:');
    for (const entry of status.repositories) info(`    ${describeRepositoryEntry(entry)}`);
    if (!status.destinationEnabled) warn('  the hq destination is disabled: nothing is sent');
  }
  info(`  local telemetry: ${describeTelemetryLevel(status.telemetryLevel).label} (caps every destination — har telemetry on --level <level>)`);
  printAgentTelemetryNote(status);
  if (status.hint) info(status.hint);
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
  success(`Logged out of ${displayPortalTargetLabel(removed)}. The chosen repositories are kept for the next login.`);
}
