import * as path from 'path';
import type { Argv } from 'yargs';
import { getControlApiUrl } from '../../core/control-config';
import { isControlApiReachable } from '../../core/control-sync';
import { resolveHarnessRoot } from '../../harness/manifest';
import {
  disableOtelHooksExport,
  ensureOtelHooks,
  getOtelHooksConfigPath,
  getOtelHooksHome,
} from '../../core/otel-hooks';
import { readSlotRegistry } from '../../core/slot-registry';
import {
  TELEMETRY_SIGNALS,
  ensureDefaultTelemetryPreference,
  getTelemetryPreferencePath,
  getTelemetrySignals,
  isTelemetryEnabled,
  readTelemetryPreference,
  writeTelemetryPreference,
} from '../../core/telemetry-config';
import {
  appendTelemetryEnvToFile,
  buildOtelResourceAttributes,
  buildSessionKey,
  buildTelemetryEnvBlock,
} from '../../core/telemetry-env';
import { ensureTelemetryInfrastructure } from '../../core/telemetry-ensure';
import { error, header, info, success, warn } from '../../utils/logging';

function printSignals(): void {
  info('Collected when enabled (local Mission Control only):');
  for (const signal of TELEMETRY_SIGNALS) {
    info(`  • ${signal}`);
  }
  info('Disable anytime: har telemetry off');
}

async function handleStatus(argv: { json: boolean }): Promise<void> {
  const preference = readTelemetryPreference();
  const enabled = isTelemetryEnabled();
  const signals = getTelemetrySignals();
  const apiUrl = getControlApiUrl();
  const reachable = enabled ? await isControlApiReachable(apiUrl) : false;
  const payload = {
    enabled,
    preferenceEnabled: preference.enabled,
    signals,
    preferencePath: getTelemetryPreferencePath(),
    updatedAt: preference.updatedAt ?? null,
    envOverride: process.env.HAR_TELEMETRY ?? null,
    controlApiUrl: apiUrl,
    controlReachable: reachable,
    otelEndpoint: `${apiUrl.replace(/\/$/, '')}/api/otel`,
    otelHooksHome: getOtelHooksHome(),
    otelHooksConfig: getOtelHooksConfigPath(),
    signalDescriptions: [...TELEMETRY_SIGNALS],
  };

  if (argv.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  header('har telemetry status');
  info(`Enabled:       ${enabled ? 'yes' : 'no'}${process.env.HAR_TELEMETRY ? ' (HAR_TELEMETRY override)' : ''}`);
  info(`Preference:    ${getTelemetryPreferencePath()}${preference.updatedAt ? ` (updated ${preference.updatedAt})` : ' (default on)'}`);
  info(
    `Signals:       metrics=${signals.metrics} logs=${signals.logs} prompts=${signals.prompts} traces=${signals.traces}`,
  );
  info(`Mission Control: ${apiUrl} (${reachable ? 'reachable' : 'not reachable'})`);
  info(`OTLP endpoint: ${payload.otelEndpoint}`);
  info(`Hooks home:    ${payload.otelHooksHome}`);
  printSignals();
}

async function handleOn(argv: { prompts: boolean }): Promise<void> {
  header('har telemetry on');
  const preference = writeTelemetryPreference(true, {
    prompts: argv.prompts,
    traces: true,
  });
  success('Telemetry enabled. Cursor / Claude / Codex export via opentelemetry-hooks → Mission Control.');
  info(
    `Signals: metrics=${preference.signals.metrics} logs=${preference.signals.logs} prompts=${preference.signals.prompts} traces=${preference.signals.traces}`,
  );
  if (preference.signals.prompts) {
    warn('Prompt text will leave the agent machine for local Mission Control (also used as session purpose).');
  } else {
    info('Prompt capture is off — enable with: har telemetry on --prompts');
  }
  printSignals();

  const result = await ensureTelemetryInfrastructure({ startIfNeeded: true });
  if (result.message) success(result.message);
  if (result.warning) warn(result.warning);

  const hooks = ensureOtelHooks({ setupAgents: true });
  if (hooks.message) success(hooks.message);
  if (hooks.warning) warn(hooks.warning);
  if (result.otelReady) {
    info(`OTLP ingest: ${result.apiUrl.replace(/\/$/, '')}/api/otel`);
    info('Usage appears under Mission Control → Worktrees / Usage. Disable: har telemetry off');
  }
}

async function handleOff(): Promise<void> {
  header('har telemetry off');
  writeTelemetryPreference(false);
  try {
    disableOtelHooksExport();
  } catch (err) {
    warn(`Could not refresh hooks config: ${err instanceof Error ? err.message : String(err)}`);
  }
  success('Telemetry disabled.');
  info('Hooks stay registered but OTLP export is cleared in ~/.har/otel-hooks/otel_config.json.');
  info('Mission Control will not auto-start. Existing usage rows are kept.');
}

async function handleWriteEnv(argv: {
  agentId: number;
  repo: string;
  envFile?: string;
  workDir?: string;
  branch?: string;
  suffix?: string;
  sessionKey?: string;
}): Promise<void> {
  const repoPath = path.resolve(argv.repo);
  const harnessRoot = resolveHarnessRoot(repoPath);
  const session = readSlotRegistry(harnessRoot, argv.agentId);
  const workDir = argv.workDir ?? session?.workDir ?? repoPath;
  const branch = argv.branch ?? session?.branch;
  const suffix = argv.suffix ?? session?.suffix;
  const sessionKey =
    argv.sessionKey ??
    buildSessionKey({
      branch,
      agentId: argv.agentId,
      suffix,
      createdAt: session?.createdAt,
    });
  const envFile =
    argv.envFile ??
    path.join(workDir, `.env.agent.${argv.agentId}`);

  const attrs = {
    sessionKey,
    agentId: argv.agentId,
    repoPath,
    workDir,
    branch,
    suffix,
  };

  appendTelemetryEnvToFile(envFile, attrs);

  if (isTelemetryEnabled()) {
    ensureOtelHooks({
      setupAgents: false,
      resourceAttributes: buildOtelResourceAttributes(attrs),
    });
  }

  success(`Wrote session attribution to ${envFile}`);
}

function handlePrintEnv(argv: {
  agentId: number;
  repo: string;
  workDir?: string;
  branch?: string;
  suffix?: string;
}): void {
  const repoPath = path.resolve(argv.repo);
  const workDir = argv.workDir ?? repoPath;
  const sessionKey = buildSessionKey({
    branch: argv.branch,
    agentId: argv.agentId,
    suffix: argv.suffix,
  });
  process.stdout.write(
    buildTelemetryEnvBlock({
      sessionKey,
      agentId: argv.agentId,
      repoPath,
      workDir,
      branch: argv.branch,
      suffix: argv.suffix,
    }),
  );
}

async function handleInstallHooks(): Promise<void> {
  header('har telemetry install-hooks');
  ensureDefaultTelemetryPreference();
  if (!isTelemetryEnabled()) {
    warn('Telemetry is off — enabling preference so hooks can export.');
    writeTelemetryPreference(true, { traces: true, prompts: true });
  }
  const result = await ensureTelemetryInfrastructure({ startIfNeeded: true });
  if (result.message) success(result.message);
  if (result.warning) warn(result.warning);
  const hooks = ensureOtelHooks({ setupAgents: true });
  if (hooks.ok) {
    success(hooks.message ?? 'opentelemetry-hooks installed and agents registered');
    info(`Config: ${hooks.configPath}`);
    info(`Wrapper: ${hooks.wrapperPath}`);
  } else {
    error(hooks.warning ?? 'Failed to install opentelemetry-hooks');
    process.exitCode = 1;
  }
}

export const telemetryCommand = {
  command: 'telemetry <subcommand>',
  describe: 'Agent usage telemetry (Cursor / Claude / Codex via opentelemetry-hooks → Mission Control)',
  builder: (yargs: Argv) =>
    yargs
      .command(
        'status',
        'Show telemetry preference and Mission Control reachability',
        (y: Argv) => y.option('json', { type: 'boolean', default: false }),
        (argv) => {
          void handleStatus({ json: argv.json as boolean });
        },
      )
      .command(
        'on',
        'Enable full telemetry (incl. prompts), ensure Mission Control, install/configure opentelemetry-hooks',
        (y: Argv) =>
          y
            .option('prompts', {
              type: 'boolean',
              default: true,
              describe: 'Ship user prompt text (also fills Mission Control purpose; default on)',
            })
            .option('no-prompts', {
              type: 'boolean',
              default: false,
              describe: 'Disable prompt text capture (traces/logs/metrics still on)',
            }),
        (argv) => {
          const noPrompts = argv['no-prompts'] as boolean;
          void handleOn({
            prompts: noPrompts ? false : (argv.prompts as boolean),
          });
        },
      )
      .command(
        'off',
        'Disable telemetry (clear hooks OTLP endpoint, no MC auto-start)',
        () => {},
        () => {
          void handleOff();
        },
      )
      .command(
        'install-hooks',
        'Install opentelemetry-hooks and register Cursor / Claude / Codex',
        () => {},
        () => {
          void handleInstallHooks().catch((err) => {
            error(err instanceof Error ? err.message : String(err));
            process.exitCode = 1;
          });
        },
      )
      .command(
        'write-env',
        'Append HAR session attribution to .env.agent.<id> and refresh hooks config',
        (y: Argv) =>
          y
            .option('agent-id', { type: 'number', demandOption: true })
            .option('repo', { type: 'string', default: '.' })
            .option('env-file', { type: 'string' })
            .option('work-dir', { type: 'string' })
            .option('branch', { type: 'string' })
            .option('suffix', { type: 'string' })
            .option('session-key', { type: 'string' }),
        (argv) =>
          handleWriteEnv({
            agentId: argv['agent-id'] as number,
            repo: argv.repo as string,
            envFile: argv['env-file'] as string | undefined,
            workDir: argv['work-dir'] as string | undefined,
            branch: argv.branch as string | undefined,
            suffix: argv.suffix as string | undefined,
            sessionKey: argv['session-key'] as string | undefined,
          }).catch((err) => {
            error(err instanceof Error ? err.message : String(err));
            process.exitCode = 1;
          }),
      )
      .command(
        'print-env',
        'Print session attribution env block to stdout',
        (y: Argv) =>
          y
            .option('agent-id', { type: 'number', demandOption: true })
            .option('repo', { type: 'string', default: '.' })
            .option('work-dir', { type: 'string' })
            .option('branch', { type: 'string' })
            .option('suffix', { type: 'string' }),
        (argv) =>
          handlePrintEnv({
            agentId: argv['agent-id'] as number,
            repo: argv.repo as string,
            workDir: argv['work-dir'] as string | undefined,
            branch: argv.branch as string | undefined,
            suffix: argv.suffix as string | undefined,
          }),
      )
      .demandCommand(1, 'Please specify a subcommand: status, on, off, install-hooks, write-env, print-env'),
  handler: () => {},
};
