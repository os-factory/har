import type { Argv } from 'yargs';
import {
  CONTROL_CONTAINER_NAME,
  controlContainerExists,
  controlContainerMountsDestinations,
} from '../../core/control-lifecycle';
import {
  DEFAULT_LANGFUSE_HOST,
  DESTINATION_LOGS_WARNING,
  OTLP_PRESET_DEFAULT_SIGNALS,
  addTelemetryDestination,
  buildLangfuseDestination,
  buildOtlpDestination,
  findTelemetryDestination,
  getTelemetryDestinationsPath,
  maskTelemetryDestination,
  parseHeaderPairs,
  parseSignals,
  readTelemetryDestinations,
  removeTelemetryDestination,
  testTelemetryDestination,
} from '../../core/telemetry-destinations';
import {
  OTLP_DESTINATION_PROTOCOLS,
  OTLP_SIGNALS,
  TELEMETRY_DESTINATION_PRESETS,
  otlpSignalUrl,
  type OtlpDestinationProtocol,
  type TelemetryDestination,
  type TelemetryDestinationPreset,
} from '../../harness/schema';
import { error, header, info, success, warn } from '../../utils/logging';
import { countSpooledPayloads } from '../../core/telemetry-spool';
import { flushVerificationTraceSpool } from '../../core/verification-spans';

export interface DestinationAddArgs {
  name: string;
  preset: TelemetryDestinationPreset;
  endpoint?: string;
  header?: string[];
  signals?: string[];
  protocol?: OtlpDestinationProtocol;
  host?: string;
  publicKey?: string;
  secretKey?: string;
  disabled?: boolean;
  includeLocalPaths?: boolean;
  includeAccountIdentity?: boolean;
  overwrite?: boolean;
}

/** Build the destination `add` would store. Langfuse keys fall back to Langfuse's own env vars. */
export function destinationFromAddArgs(
  argv: DestinationAddArgs,
  env: NodeJS.ProcessEnv = process.env,
): TelemetryDestination {
  if (argv.preset === 'langfuse') {
    if (argv.endpoint) throw new Error('--endpoint is for --preset otlp; Langfuse takes --host');
    if (argv.header?.length) throw new Error('--header is for --preset otlp; Langfuse builds its Authorization header from the keys');
    const signals = parseSignals(argv.signals);
    if (signals && (signals.length !== 1 || signals[0] !== 'traces')) {
      throw new Error('Langfuse ingests OTLP traces only (no logs or metrics)');
    }
    return buildLangfuseDestination({
      name: argv.name,
      host: argv.host ?? env.LANGFUSE_BASE_URL ?? env.LANGFUSE_HOST ?? DEFAULT_LANGFUSE_HOST,
      publicKey: argv.publicKey ?? env.LANGFUSE_PUBLIC_KEY ?? '',
      secretKey: argv.secretKey ?? env.LANGFUSE_SECRET_KEY ?? '',
      protocol: argv.protocol,
      enabled: !argv.disabled,
      includeLocalPaths: argv.includeLocalPaths,
      includeAccountIdentity: argv.includeAccountIdentity,
    });
  }
  if (!argv.endpoint) throw new Error('--preset otlp needs --endpoint <base OTLP/HTTP URL>');
  if (argv.host || argv.publicKey || argv.secretKey) {
    throw new Error('--host / --public-key / --secret-key are for --preset langfuse');
  }
  return buildOtlpDestination({
    name: argv.name,
    endpoint: argv.endpoint,
    headers: parseHeaderPairs(argv.header ?? []),
    signals: parseSignals(argv.signals),
    protocol: argv.protocol,
    enabled: !argv.disabled,
    includeLocalPaths: argv.includeLocalPaths,
    includeAccountIdentity: argv.includeAccountIdentity,
  });
}

function controlMountHint(): void {
  try {
    if (controlContainerExists() && controlContainerMountsDestinations() === false) {
      info(`The running ${CONTROL_CONTAINER_NAME} container predates destinations — run har control up to recreate it so Mission Control can forward.`);
    }
  } catch {
    // docker missing or not running: nothing to hint
  }
}

function localPathsLabel(destination: TelemetryDestination): string {
  return destination.includeLocalPaths ? 'included (--include-local-paths)' : 'stripped';
}

function accountIdentityLabel(destination: TelemetryDestination): string {
  return destination.includeAccountIdentity ? 'included (--include-account-identity)' : 'stripped';
}

function handleAdd(argv: DestinationAddArgs): void {
  header('har telemetry destination add');
  const destination = destinationFromAddArgs(argv);
  const result = addTelemetryDestination(destination, { replace: argv.overwrite });
  success(`${result.replaced ? 'Replaced' : 'Added'} destination "${destination.name}" (${destination.preset ?? 'otlp'}) → ${destination.endpoint}`);
  info(`Signals: ${destination.signals.join(', ')}${destination.enabled ? '' : ' (disabled)'}`);
  if (destination.signals.includes('logs')) warn(DESTINATION_LOGS_WARNING);
  info(`Local paths: ${localPathsLabel(destination)}`);
  info(`Account identity: ${accountIdentityLabel(destination)}`);
  info(`Config:  ${result.path} (mode 0600)`);
  info(`Check it: har telemetry destination test ${destination.name}`);
  controlMountHint();
}

function handleList(argv: { json: boolean }): void {
  const file = readTelemetryDestinations();
  const masked = file.destinations.map(maskTelemetryDestination);
  if (argv.json) {
    process.stdout.write(`${JSON.stringify({ path: getTelemetryDestinationsPath(), destinations: masked }, null, 2)}\n`);
    return;
  }
  header('har telemetry destination list');
  if (masked.length === 0) {
    info('No destinations — telemetry stays on this machine.');
    info('Add one: har telemetry destination add <name> --preset langfuse|otlp …');
    return;
  }
  for (const destination of masked) {
    info(`${destination.name}${destination.enabled ? '' : ' (disabled)'} — ${destination.preset ?? 'otlp'}`);
    info(`  endpoint: ${destination.endpoint} (${destination.protocol})`);
    info(`  signals:  ${destination.signals.join(', ')}`);
    info(`  local paths: ${localPathsLabel(destination)}`);
    info(`  account identity: ${accountIdentityLabel(destination)}`);
    const headers = Object.entries(destination.headers);
    if (headers.length > 0) info(`  headers:  ${headers.map(([key, value]) => `${key}: ${value}`).join(', ')}`);
  }
  info(`Config: ${getTelemetryDestinationsPath()}`);
}

function handleRemove(argv: { name: string }): void {
  header('har telemetry destination remove');
  if (!removeTelemetryDestination(argv.name)) {
    error(`No destination named "${argv.name}"`);
    process.exitCode = 1;
    return;
  }
  success(`Removed destination "${argv.name}"`);
}

async function handleTest(argv: { name: string; json: boolean }): Promise<void> {
  const destination = findTelemetryDestination(argv.name);
  if (!destination) {
    error(`No destination named "${argv.name}"`);
    process.exitCode = 1;
    return;
  }
  const result = await testTelemetryDestination(destination);
  if (argv.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    header('har telemetry destination test');
    info(`POST ${otlpSignalUrl(destination.endpoint, result.signal)} (one OTLP/JSON test ${result.signal} record)`);
    if (result.ok) success(`HTTP ${result.status} — ${destination.name} accepted the test record`);
    else error(`${result.status === null ? 'No response' : `HTTP ${result.status}`}${result.detail ? ` — ${result.detail}` : ''}`);
    if (!destination.enabled) warn(`"${destination.name}" is disabled — nothing is forwarded to it.`);
  }
  if (!result.ok) process.exitCode = 1;
}

async function handleFlush(argv: { json: boolean }): Promise<void> {
  const queued = countSpooledPayloads();
  // Everything due, with a longer budget than the flush at the start of verify / launch.
  const result = (await flushVerificationTraceSpool({ budgetMs: 30_000, maxSends: 1_000 })) ?? {
    sent: 0,
    retried: 0,
    dropped: 0,
    pending: queued,
  };
  if (argv.json) {
    process.stdout.write(`${JSON.stringify({ queued, ...result }, null, 2)}\n`);
    return;
  }
  header('har telemetry destination flush');
  if (queued === 0) {
    info('Nothing queued: every verification trace was delivered.');
    return;
  }
  info(`${queued} queued, ${result.sent} sent, ${result.retried} to retry, ${result.dropped} dropped, ${result.pending} left`);
  if (result.retried > 0 || result.pending > 0) {
    warn('Some traces are still queued; they are retried at the next verify or launch (kept up to 24 h).');
  }
}

function run(fn: () => void | Promise<void>): void {
  try {
    void Promise.resolve(fn()).catch((err: unknown) => {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export const telemetryDestinationCommand = {
  command: 'destination <subcommand>',
  describe: 'Send a copy of agent telemetry to any OTLP backend (Langfuse, an OpenTelemetry Collector, …)',
  builder: (yargs: Argv) =>
    yargs
      .command(
        'add <name>',
        'Add an OTLP destination (--preset langfuse | otlp)',
        (y: Argv) =>
          y
            .positional('name', { type: 'string', demandOption: true })
            .option('preset', { type: 'string', choices: TELEMETRY_DESTINATION_PRESETS, default: 'otlp' })
            .option('endpoint', { type: 'string', describe: 'otlp: base OTLP/HTTP URL (signals go to <endpoint>/v1/<signal>)' })
            .option('header', { type: 'string', array: true, describe: 'otlp: Name=value request header (repeatable; stored 0600)' })
            .option('signals', { type: 'string', array: true, describe: `Comma list of ${OTLP_SIGNALS.join(', ')} (otlp default: ${OTLP_PRESET_DEFAULT_SIGNALS.join(', ')}; add logs explicitly; langfuse: traces)` })
            .option('protocol', { type: 'string', choices: OTLP_DESTINATION_PROTOCOLS })
            .option('host', { type: 'string', describe: `langfuse: host (default $LANGFUSE_BASE_URL, $LANGFUSE_HOST or ${DEFAULT_LANGFUSE_HOST})` })
            .option('public-key', { type: 'string', describe: 'langfuse: public key (default $LANGFUSE_PUBLIC_KEY)' })
            .option('secret-key', { type: 'string', describe: 'langfuse: secret key (default $LANGFUSE_SECRET_KEY)' })
            .option('disabled', { type: 'boolean', default: false, describe: 'Store it without forwarding to it' })
            .option('include-local-paths', {
              type: 'boolean',
              default: false,
              describe: 'Forward attributes holding absolute local paths (factory.local.*, process.cwd, …); stripped by default',
            })
            .option('include-account-identity', {
              type: 'boolean',
              default: false,
              describe: 'Forward account identity attributes (user.email, user.account_uuid, user.id, organization.id, …); stripped by default',
            })
            .option('overwrite', { type: 'boolean', default: false, describe: 'Replace a destination with the same name' }),
        (argv) =>
          run(() =>
            handleAdd({
              name: argv.name as string,
              preset: argv.preset as TelemetryDestinationPreset,
              endpoint: argv.endpoint as string | undefined,
              header: argv.header as string[] | undefined,
              signals: argv.signals as string[] | undefined,
              protocol: argv.protocol as OtlpDestinationProtocol | undefined,
              host: argv.host as string | undefined,
              publicKey: argv['public-key'] as string | undefined,
              secretKey: argv['secret-key'] as string | undefined,
              disabled: argv.disabled as boolean,
              includeLocalPaths: argv['include-local-paths'] as boolean,
              includeAccountIdentity: argv['include-account-identity'] as boolean,
              overwrite: argv.overwrite as boolean,
            }),
          ),
      )
      .command(
        'list',
        'List destinations (header values masked)',
        (y: Argv) => y.option('json', { type: 'boolean', default: false }),
        (argv) => run(() => handleList({ json: argv.json as boolean })),
      )
      .command(
        'remove <name>',
        'Remove a destination',
        (y: Argv) => y.positional('name', { type: 'string', demandOption: true }),
        (argv) => run(() => handleRemove({ name: argv.name as string })),
      )
      .command(
        'test <name>',
        'Send one OTLP/JSON test record and report the HTTP status',
        (y: Argv) =>
          y
            .positional('name', { type: 'string', demandOption: true })
            .option('json', { type: 'boolean', default: false }),
        (argv) => run(() => handleTest({ name: argv.name as string, json: argv.json as boolean })),
      )
      .command(
        'flush',
        'Retry verification traces queued while a destination or Mission Control was down',
        (y: Argv) => y.option('json', { type: 'boolean', default: false }),
        (argv) => run(() => handleFlush({ json: argv.json as boolean })),
      )
      .demandCommand(1, 'Please specify a subcommand: add, list, remove, test, flush'),
  handler: () => {},
};
