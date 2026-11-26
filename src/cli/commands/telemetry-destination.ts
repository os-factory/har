import type { Argv } from 'yargs';
import { hqSignalsFor, hqTrajectoryForwarding } from '../../core/hq-destination-migration';
import {
  DEFAULT_LANGFUSE_HOST,
  DESTINATION_LOGS_WARNING,
  OTLP_PRESET_DEFAULT_SIGNALS,
  addDestination,
  buildGitNotesDestination,
  buildHqDestination,
  buildLangfuseDestination,
  buildMissionControlDestination,
  buildOtlpDestination,
  defaultHqIngestBaseUrl,
  destinationIngestBaseUrl,
  findDestination,
  getDestinationsPath,
  maskDestination,
  materializeOtlpDestinations,
  parseHeaderPairs,
  parseSignals,
  readDestinations,
  removeDestination,
  testTelemetryDestination,
} from '../../core/telemetry-destinations';
import {
  DESTINATION_PRESETS,
  DESTINATION_PRESET_DEFAULTS,
  DESTINATIONS_FILE_VERSION,
  OTLP_DESTINATION_PROTOCOLS,
  OTLP_SIGNALS,
  harDestinationSchema,
  isIngestReceiver,
  migrateTelemetryDestination,
  otlpSignalUrl,
  type DestinationPreset,
  type HarDestination,
  type OtlpDestinationProtocol,
} from '../../harness/schema';
import { error, header, info, success, warn } from '../../utils/logging';
import { countSpooledPayloads } from '../../core/telemetry-spool';
import { getOtelHooksHome, refreshAgentTelemetryRoute } from '../../core/otel-hooks';
import { appliedRouteNames, describeAgentTelemetryRoute, readAppliedAgentRoute } from '../../core/telemetry-route';
import { flushVerificationTraceSpool } from '../../core/verification-spans';
import {
  checkReceiverCapabilities,
  drainIngestQueues,
  listIngestQueues,
  resolveQueueReceiver,
  summarizeIngestQueues,
} from '../../core/ingest-queue';

export interface DestinationAddArgs {
  name: string;
  preset: DestinationPreset;
  endpoint?: string;
  baseUrl?: string;
  header?: string[];
  signals?: string[];
  protocol?: OtlpDestinationProtocol;
  host?: string;
  publicKey?: string;
  secretKey?: string;
  records?: boolean;
  proofs?: boolean;
  evidence?: boolean;
  disabled?: boolean;
  includeLocalPaths?: boolean;
  includeAccountIdentity?: boolean;
  includeSessionId?: boolean;
  overwrite?: boolean;
}

function rejectFlags(argv: DestinationAddArgs, flags: Array<[keyof DestinationAddArgs, string]>, preset: string): void {
  for (const [key, flag] of flags) {
    const value = argv[key];
    if (value !== undefined && !(Array.isArray(value) && value.length === 0)) {
      throw new Error(`${flag} does not apply to --preset ${preset}`);
    }
  }
}

/** Build the list entry `add` would store. Langfuse keys fall back to Langfuse's own env vars. */
export function destinationFromAddArgs(
  argv: DestinationAddArgs,
  env: NodeJS.ProcessEnv = process.env,
): HarDestination {
  const signals = parseSignals(argv.signals);
  const common = {
    ...(argv.includeLocalPaths ? { includeLocalPaths: true } : {}),
    ...(argv.includeAccountIdentity ? { includeAccountIdentity: true } : {}),
    ...(argv.includeSessionId === false ? { includeSessionId: false } : {}),
  };
  let destination: HarDestination;
  if (argv.preset === 'langfuse') {
    if (argv.endpoint) throw new Error('--endpoint is for --preset otlp; Langfuse takes --host');
    if (argv.header?.length) throw new Error('--header is for --preset otlp; Langfuse builds its Authorization header from the keys');
    rejectFlags(argv, [['baseUrl', '--base-url'], ['records', '--records'], ['proofs', '--proofs'], ['evidence', '--evidence']], 'langfuse');
    if (signals && (signals.length !== 1 || signals[0] !== 'traces')) {
      throw new Error('Langfuse ingests OTLP traces only (no logs or metrics)');
    }
    destination = migrateTelemetryDestination(
      buildLangfuseDestination({
        name: argv.name,
        host: argv.host ?? env.LANGFUSE_BASE_URL ?? env.LANGFUSE_HOST ?? DEFAULT_LANGFUSE_HOST,
        publicKey: argv.publicKey ?? env.LANGFUSE_PUBLIC_KEY ?? '',
        secretKey: argv.secretKey ?? env.LANGFUSE_SECRET_KEY ?? '',
        protocol: argv.protocol,
        enabled: !argv.disabled,
        includeLocalPaths: argv.includeLocalPaths,
        includeAccountIdentity: argv.includeAccountIdentity,
      }),
    );
  } else if (argv.preset === 'otlp') {
    if (!argv.endpoint) throw new Error('--preset otlp needs --endpoint <base OTLP/HTTP URL>');
    if (argv.host || argv.publicKey || argv.secretKey) {
      throw new Error('--host / --public-key / --secret-key are for --preset langfuse');
    }
    rejectFlags(argv, [['baseUrl', '--base-url'], ['records', '--records'], ['proofs', '--proofs'], ['evidence', '--evidence']], 'otlp');
    destination = migrateTelemetryDestination(
      buildOtlpDestination({
        name: argv.name,
        endpoint: argv.endpoint,
        headers: parseHeaderPairs(argv.header ?? []),
        signals,
        protocol: argv.protocol,
        enabled: !argv.disabled,
        includeLocalPaths: argv.includeLocalPaths,
        includeAccountIdentity: argv.includeAccountIdentity,
      }),
    );
  } else {
    rejectFlags(
      argv,
      [['endpoint', '--endpoint'], ['header', '--header'], ['host', '--host'], ['publicKey', '--public-key'], ['secretKey', '--secret-key']],
      argv.preset,
    );
    const capabilities = {
      ...(argv.records !== undefined ? { records: argv.records } : {}),
      ...(argv.proofs !== undefined ? { proofs: argv.proofs } : {}),
      ...(argv.evidence !== undefined ? { evidence: argv.evidence } : {}),
    };
    if (argv.preset === 'git-notes') {
      rejectFlags(argv, [['baseUrl', '--base-url'], ['signals', '--signals']], 'git-notes');
      destination = buildGitNotesDestination({ name: argv.name, enabled: !argv.disabled });
    } else if (argv.preset === 'hq') {
      const baseUrl = argv.baseUrl ?? defaultHqIngestBaseUrl(env);
      if (!baseUrl) {
        throw new Error('--preset hq needs --base-url <ingest base URL>, HAR_HQ_INGEST_URL, or a HAR HQ connection (har hq connect)');
      }
      // Without --signals, the trajectory (logs) only when forwarding to the hosted receiver is on.
      destination = buildHqDestination({
        name: argv.name,
        baseUrl,
        enabled: !argv.disabled,
        signals: hqSignalsFor(hqTrajectoryForwarding(env)),
      });
    } else {
      destination = buildMissionControlDestination({ name: argv.name, enabled: !argv.disabled });
      if (argv.baseUrl) destination = { ...destination, baseUrl: argv.baseUrl };
    }
    destination = { ...destination, ...(signals ? { signals } : {}), ...capabilities };
  }
  if (argv.preset !== 'otlp' && argv.protocol) destination = { ...destination, protocol: argv.protocol };
  return harDestinationSchema.parse({ ...destination, ...common });
}

/**
 * Re-route agent hook telemetry after a destination or Mission Control change
 * and say where it goes now. Silent until `har telemetry on` installed the hook.
 */
export function refreshAgentRouteAndReport(): void {
  const decision = refreshAgentTelemetryRoute();
  if (!decision || decision.route.mode === 'off') return;
  info(`Agent telemetry: ${describeAgentTelemetryRoute(decision.route)} (hooks pick this up on their next event)`);
  if (decision.hint) info(decision.hint);
}

function where(destination: HarDestination): string {
  if (destination.endpoint) return `${destination.endpoint} (${destination.protocol})`;
  const base = destinationIngestBaseUrl(destination);
  if (base) return `${base}${destination.preset === 'mission-control' && !destination.baseUrl ? ' (from HAR_CONTROL_API_URL)' : ''}`;
  return destination.preset === 'git-notes' ? 'refs/notes/factory in each repository' : '—';
}

function capabilitiesLabel(destination: HarDestination): string {
  const kinds = (['records', 'proofs', 'evidence'] as const).filter((kind) => destination[kind]);
  return kinds.length > 0 ? kinds.join(', ') : 'none';
}

function describeDestination(destination: HarDestination): string[] {
  const lines = [
    `${destination.name}${destination.enabled ? '' : ' (disabled)'} — ${destination.preset}`,
    `  ${destination.preset === 'otlp' || destination.preset === 'langfuse' ? 'endpoint' : destination.preset === 'git-notes' ? 'notes' : 'base URL'}: ${where(destination)}`,
    `  signals:  ${destination.signals.length > 0 ? destination.signals.join(', ') : 'none'}`,
    `  records, proofs, evidence: ${capabilitiesLabel(destination)}`,
  ];
  if (destination.signals.length > 0) {
    lines.push(`  local paths: ${destination.includeLocalPaths ? 'included (--include-local-paths)' : 'stripped'}`);
    lines.push(`  account identity: ${destination.includeAccountIdentity ? 'included (--include-account-identity)' : 'stripped'}`);
  }
  if (destination.signals.includes('metrics')) {
    lines.push(`  session.id on metrics: ${destination.includeSessionId === false ? 'off' : 'on'}`);
  }
  if (destination.preset === 'mission-control' && destination.signals.includes('metrics')) {
    lines.push('  metrics: Mission Control books Claude Code usage from Claude Code itself and drops its otel-hook metrics');
  }
  if (destination.auth?.kind === 'hq-token') lines.push('  key: HAR_PORTAL_TOKEN or the HAR HQ connection (never stored here)');
  const headers = Object.entries(destination.headers);
  if (headers.length > 0) lines.push(`  headers:  ${headers.map(([key, value]) => `${key}: ${value}`).join(', ')}`);
  return lines;
}

function handleAdd(argv: DestinationAddArgs): void {
  header('har telemetry destination add');
  const destination = destinationFromAddArgs(argv);
  const result = addDestination(destination, { replace: argv.overwrite });
  success(`${result.replaced ? 'Replaced' : 'Added'} destination "${destination.name}" (${destination.preset}) → ${where(destination)}`);
  for (const line of describeDestination(maskDestination(destination)).slice(2)) info(line.trim());
  if (destination.signals.includes('logs')) warn(DESTINATION_LOGS_WARNING);
  info(`Config:  ${result.path} (mode 0600)`);
  if (destination.preset !== 'git-notes') info(`Check it: har telemetry destination test ${destination.name}`);
  refreshAgentRouteAndReport();
}

function handleList(argv: { json: boolean }): void {
  const file = readDestinations();
  const masked = file.destinations.map(maskDestination);
  // Where agents send now (from the hooks home), by name.
  const agentTelemetry = appliedRouteNames(readAppliedAgentRoute(getOtelHooksHome()));
  const queues = summarizeIngestQueues();
  if (argv.json) {
    process.stdout.write(
      `${JSON.stringify({ path: getDestinationsPath(), version: DESTINATIONS_FILE_VERSION, destinations: masked, agentTelemetry, queues }, null, 2)}\n`,
    );
    return;
  }
  header('har telemetry destination list');
  if (agentTelemetry.length > 0) info(`Agent telemetry: → ${agentTelemetry.join(', ')}`);
  if (masked.length === 0) {
    info('No destinations — nothing leaves this machine.');
    info('Add one: har telemetry destination add <name> --preset mission-control|hq|git-notes|otlp|langfuse …');
    return;
  }
  for (const destination of masked) {
    for (const line of describeDestination(destination)) info(line);
    const queue = queues.find((entry) => entry.destination === destination.name);
    if (queue && queue.depth > 0) info(`  queued: ${queue.depth}${queue.lastError ? ` (last error: ${queue.lastError})` : ''}`);
  }
  info(`Config: ${getDestinationsPath()}`);
}

function handleRemove(argv: { name: string }): void {
  header('har telemetry destination remove');
  const preset = findDestination(argv.name)?.preset;
  if (!removeDestination(argv.name)) {
    error(`No destination named "${argv.name}"`);
    process.exitCode = 1;
    return;
  }
  if (preset === 'mission-control') {
    success(`Disabled "${argv.name}" (kept in the list, disabled, so the default does not bring it back)`);
  } else {
    success(`Removed destination "${argv.name}"`);
  }
  refreshAgentRouteAndReport();
}

async function handleTest(argv: { name: string; json: boolean }): Promise<void> {
  const destination = findDestination(argv.name);
  if (!destination) {
    error(`No destination named "${argv.name}"`);
    process.exitCode = 1;
    return;
  }
  const results: Array<{ kind: string; ok: boolean; detail: string }> = [];
  if (isIngestReceiver(destination)) {
    const receiver = resolveQueueReceiver(destination.name, process.env, [{ ...destination, enabled: true }]);
    if (receiver === 'withdrawn') results.push({ kind: 'ingest v2', ok: false, detail: 'takes no records, proofs or evidence' });
    else if ('error' in receiver) results.push({ kind: 'ingest v2', ok: false, detail: receiver.error });
    else {
      const check = await checkReceiverCapabilities(receiver);
      results.push({ kind: 'ingest v2', ok: check.ok, detail: `GET v2/capabilities: ${check.detail}` });
    }
  }
  const otlp = materializeOtlpDestinations({ version: DESTINATIONS_FILE_VERSION, destinations: [destination] })[0];
  if (otlp) {
    const result = await testTelemetryDestination(otlp);
    results.push({
      kind: 'otlp',
      ok: result.ok,
      detail: `POST ${otlpSignalUrl(otlp.endpoint, result.signal)}: ${result.status === null ? 'no response' : `HTTP ${result.status}`}${result.detail ? ` — ${result.detail}` : ''}`,
    });
  } else if (destination.signals.length > 0) {
    results.push({ kind: 'otlp', ok: false, detail: 'no OTLP endpoint or key resolved' });
  }
  if (destination.preset === 'git-notes') {
    results.push({ kind: 'git-notes', ok: true, detail: 'writes factory notes locally on commit (needs git-factory)' });
  }
  const ok = results.every((result) => result.ok);
  if (argv.json) {
    process.stdout.write(`${JSON.stringify({ name: destination.name, ok, results }, null, 2)}\n`);
  } else {
    header('har telemetry destination test');
    for (const result of results) {
      if (result.ok) success(`${result.kind}: ${result.detail}`);
      else error(`${result.kind}: ${result.detail}`);
    }
    if (!destination.enabled) warn(`"${destination.name}" is disabled — nothing is sent to it.`);
  }
  if (!ok) process.exitCode = 1;
}

/**
 * `har telemetry flush` (and `destination flush`): send everything queued for
 * every destination now — records, proofs and evidence, and verification
 * traces. Non-interactive; exit 1 while something is still queued.
 */
export async function handleTelemetryFlush(argv: { json: boolean; budgetMs?: number }): Promise<void> {
  const before = summarizeIngestQueues();
  const tracesQueued = countSpooledPayloads();
  const ingest = await drainIngestQueues({ budgetMs: argv.budgetMs ?? 60_000, destinations: listIngestQueues() });
  const traces = await flushVerificationTraceSpool({ budgetMs: 30_000, maxSends: 1_000 });
  const after = summarizeIngestQueues();
  const left = after.some((queue) => queue.depth > 0) || (traces?.pending ?? 0) > 0 || (traces?.retried ?? 0) > 0;
  if (argv.json) {
    process.stdout.write(`${JSON.stringify({ ingest, traces: traces ?? null, tracesQueued, queues: after }, null, 2)}\n`);
    if (left) process.exitCode = 1;
    return;
  }
  header('har telemetry flush');
  const queuedBefore = before.reduce((sum, queue) => sum + queue.depth, 0);
  info(
    `Records, proofs, evidence: ${queuedBefore} queued, ${ingest.sent} sent, ${ingest.retried} to retry, ${ingest.dead} rejected or withdrawn, ${ingest.pending} left`,
  );
  for (const queue of after) {
    if (queue.depth === 0) continue;
    warn(`  ${queue.destination}: ${queue.depth} still queued${queue.lastError ? ` (${queue.lastError})` : ''}`);
  }
  if (traces) {
    info(
      `Verification traces: ${tracesQueued} queued, ${traces.sent} sent, ${traces.retried} to retry, ${traces.dropped} dropped, ${traces.pending} left`,
    );
  }
  if (left) {
    warn('Some sends are still queued; they are retried on every har command (records kept 14 days, traces 24 h).');
    process.exitCode = 1;
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
  describe: 'The one destination list: Mission Control, HAR HQ, git notes, any OTLP backend (Langfuse, a Collector, …)',
  builder: (yargs: Argv) =>
    yargs
      .command(
        'add <name>',
        'Add a destination (--preset mission-control | hq | git-notes | otlp | langfuse)',
        (y: Argv) =>
          y
            .positional('name', { type: 'string', demandOption: true })
            .option('preset', { type: 'string', choices: DESTINATION_PRESETS, default: 'otlp' })
            .option('endpoint', { type: 'string', describe: 'otlp: base OTLP/HTTP URL (signals go to <endpoint>/v1/<signal>)' })
            .option('base-url', {
              type: 'string',
              describe: 'hq / mission-control: ingest base URL (hq default: HAR_HQ_INGEST_URL or the HAR HQ connection; Mission Control: HAR_CONTROL_API_URL + /api)',
            })
            .option('header', { type: 'string', array: true, describe: 'otlp: Name=value request header (repeatable; stored 0600)' })
            .option('signals', {
              type: 'string',
              array: true,
              describe: `Comma list of ${OTLP_SIGNALS.join(', ')} (otlp default: ${OTLP_PRESET_DEFAULT_SIGNALS.join(', ')}; mission-control: ${DESTINATION_PRESET_DEFAULTS['mission-control'].signals.join(', ')}; hq: the same, logs only with trajectory forwarding on (har control trajectory on); langfuse: traces)`,
            })
            .option('records', { type: 'boolean', describe: 'mission-control / hq: send ingest v2 records (default on)' })
            .option('proofs', { type: 'boolean', describe: 'mission-control / hq: send proofs (default on)' })
            .option('evidence', { type: 'boolean', describe: 'mission-control / hq: send stage logs and artifacts (default on)' })
            .option('protocol', { type: 'string', choices: OTLP_DESTINATION_PROTOCOLS })
            .option('host', { type: 'string', describe: `langfuse: host (default $LANGFUSE_BASE_URL, $LANGFUSE_HOST or ${DEFAULT_LANGFUSE_HOST})` })
            .option('public-key', { type: 'string', describe: 'langfuse: public key (default $LANGFUSE_PUBLIC_KEY)' })
            .option('secret-key', { type: 'string', describe: 'langfuse: secret key (default $LANGFUSE_SECRET_KEY)' })
            .option('disabled', { type: 'boolean', default: false, describe: 'Store it without sending to it' })
            .option('include-local-paths', {
              type: 'boolean',
              default: false,
              describe: 'Send attributes holding absolute local paths (factory.local.*, process.cwd, …); stripped by default for every destination',
            })
            .option('include-account-identity', {
              type: 'boolean',
              default: false,
              describe: 'Send account identity attributes (user.email, user.account_uuid, user.id, organization.id, …); stripped by default',
            })
            .option('include-session-id', {
              type: 'boolean',
              default: true,
              describe: 'session.id on every metric point; --no-include-session-id where per-session series are too many',
            })
            .option('overwrite', { type: 'boolean', default: false, describe: 'Replace a destination with the same name' }),
        (argv) =>
          run(() =>
            handleAdd({
              name: argv.name as string,
              preset: argv.preset as DestinationPreset,
              endpoint: argv.endpoint as string | undefined,
              baseUrl: argv['base-url'] as string | undefined,
              header: argv.header as string[] | undefined,
              signals: argv.signals as string[] | undefined,
              records: argv.records as boolean | undefined,
              proofs: argv.proofs as boolean | undefined,
              evidence: argv.evidence as boolean | undefined,
              protocol: argv.protocol as OtlpDestinationProtocol | undefined,
              host: argv.host as string | undefined,
              publicKey: argv['public-key'] as string | undefined,
              secretKey: argv['secret-key'] as string | undefined,
              disabled: argv.disabled as boolean,
              includeLocalPaths: argv['include-local-paths'] as boolean,
              includeAccountIdentity: argv['include-account-identity'] as boolean,
              includeSessionId: argv['include-session-id'] as boolean,
              overwrite: argv.overwrite as boolean,
            }),
          ),
      )
      .command(
        'list',
        'List destinations (header values masked) and their queues',
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
        'Check a destination: GET v2/capabilities of a receiver, one OTLP/JSON test record',
        (y: Argv) =>
          y
            .positional('name', { type: 'string', demandOption: true })
            .option('json', { type: 'boolean', default: false }),
        (argv) => run(() => handleTest({ name: argv.name as string, json: argv.json as boolean })),
      )
      .command(
        'flush',
        'Same as har telemetry flush: send everything queued now',
        (y: Argv) => y.option('json', { type: 'boolean', default: false }),
        (argv) => run(() => handleTelemetryFlush({ json: argv.json as boolean })),
      )
      .demandCommand(1, 'Please specify a subcommand: add, list, remove, test, flush'),
  handler: () => {},
};
