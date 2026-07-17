import * as fs from 'fs';
import * as path from 'path';
import type { Argv } from 'yargs';
import { getControlApiUrl } from '../../core/control-config';
import { isControlApiReachable } from '../../core/control-sync';
import { resolveHarnessRoot } from '../../harness/manifest';
import { readSlotRegistry } from '../../core/slot-registry';
import {
  TELEMETRY_SIGNALS,
  getTelemetryPreferencePath,
  getTelemetrySignals,
  isTelemetryEnabled,
  readTelemetryPreference,
  writeTelemetryPreference,
} from '../../core/telemetry-config';
import {
  appendTelemetryEnvToFile,
  buildCodexOtelSnippet,
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
  printSignals();
}

async function handleOn(argv: { prompts?: boolean; traces?: boolean }): Promise<void> {
  header('har telemetry on');
  const preference = writeTelemetryPreference(true, {
    prompts: argv.prompts === true ? true : undefined,
    traces: argv.traces === true ? true : undefined,
  });
  success('Telemetry enabled (opt-out). Agent usage will be stored in local Mission Control.');
  info(
    `Signals: metrics=${preference.signals.metrics} logs=${preference.signals.logs} prompts=${preference.signals.prompts} traces=${preference.signals.traces}`,
  );
  if (preference.signals.prompts) {
    warn('Prompt/response text will leave the agent machine for local Mission Control storage.');
  }
  printSignals();
  const result = await ensureTelemetryInfrastructure({ startIfNeeded: true });
  if (result.message) success(result.message);
  if (result.warning) warn(result.warning);
  if (result.otelReady) {
    info(`OTLP ingest: ${result.apiUrl.replace(/\/$/, '')}/api/otel`);
    info('Usage appears under Mission Control → Worktrees / Usage. Disable: har telemetry off');
  }
}

async function handleOff(): Promise<void> {
  header('har telemetry off');
  writeTelemetryPreference(false);
  success('Telemetry disabled.');
  info('Future launches will not inject OTEL exporters or auto-start Mission Control.');
  info('Existing usage rows in Mission Control are kept. Historical data is not deleted.');
}

async function handleWriteEnv(argv: {
  agentId: number;
  repo: string;
  envFile?: string;
  workDir?: string;
  branch?: string;
  suffix?: string;
  purpose?: string;
  sessionKey?: string;
  otelReady?: boolean;
}): Promise<void> {
  const repoPath = path.resolve(argv.repo);
  const harnessRoot = resolveHarnessRoot(repoPath);
  const session = readSlotRegistry(harnessRoot, argv.agentId);
  const workDir = argv.workDir ?? session?.workDir ?? repoPath;
  const branch = argv.branch ?? session?.branch;
  const suffix = argv.suffix ?? session?.suffix;
  const purpose = argv.purpose ?? session?.purpose;
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

  let otelReady = argv.otelReady;
  if (otelReady === undefined && isTelemetryEnabled()) {
    const ensured = await ensureTelemetryInfrastructure({ startIfNeeded: false });
    otelReady = ensured.otelReady;
  }

  const attrs = {
    sessionKey,
    agentId: argv.agentId,
    repoPath,
    workDir,
    branch,
    suffix,
    purpose,
  };

  appendTelemetryEnvToFile(envFile, attrs, { otelReady: otelReady !== false && isTelemetryEnabled() });
  success(`Wrote telemetry env to ${envFile}`);
}

function handlePrintEnv(argv: {
  agentId: number;
  repo: string;
  workDir?: string;
  branch?: string;
  suffix?: string;
  otelReady: boolean;
}): void {
  const repoPath = path.resolve(argv.repo);
  const workDir = argv.workDir ?? repoPath;
  const sessionKey = buildSessionKey({
    branch: argv.branch,
    agentId: argv.agentId,
    suffix: argv.suffix,
  });
  process.stdout.write(
    buildTelemetryEnvBlock(
      {
        sessionKey,
        agentId: argv.agentId,
        repoPath,
        workDir,
        branch: argv.branch,
        suffix: argv.suffix,
      },
      { otelReady: argv.otelReady && isTelemetryEnabled() },
    ),
  );
}

function handleCodexSnippet(argv: {
  agentId: number;
  repo: string;
  workDir?: string;
  branch?: string;
  suffix?: string;
  write: boolean;
}): void {
  const repoPath = path.resolve(argv.repo);
  const harnessRoot = resolveHarnessRoot(repoPath);
  const session = readSlotRegistry(harnessRoot, argv.agentId);
  const workDir = argv.workDir ?? session?.workDir ?? repoPath;
  const branch = argv.branch ?? session?.branch;
  const suffix = argv.suffix ?? session?.suffix;
  const sessionKey = buildSessionKey({
    branch,
    agentId: argv.agentId,
    suffix,
    createdAt: session?.createdAt,
  });
  const snippet = buildCodexOtelSnippet({
    sessionKey,
    agentId: argv.agentId,
    repoPath,
    workDir,
    branch,
    suffix,
    purpose: session?.purpose,
  });

  if (argv.write) {
    const outDir = path.join(harnessRoot, '.har', 'telemetry');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'codex.otel.toml.snippet');
    fs.writeFileSync(outPath, snippet);
    success(`Wrote ${outPath}`);
    info('Merge the [otel] table into ~/.codex/config.toml manually.');
    return;
  }

  process.stdout.write(snippet);
}

export const telemetryCommand = {
  command: 'telemetry <subcommand>',
  describe: 'Agent usage telemetry (Claude Code / Codex → Mission Control)',
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
        'Enable telemetry (default) and ensure Mission Control is running',
        (y: Argv) =>
          y
            .option('prompts', {
              type: 'boolean',
              default: false,
              describe: 'Opt in to shipping user/assistant prompt text to Mission Control',
            })
            .option('traces', {
              type: 'boolean',
              default: false,
              describe: 'Opt in to thin OTEL traces ingest (Claude beta)',
            }),
        (argv) => {
          void handleOn({
            prompts: argv.prompts as boolean,
            traces: argv.traces as boolean,
          });
        },
      )
      .command(
        'off',
        'Disable telemetry (no OTEL injection, no MC auto-start)',
        () => {},
        () => {
          void handleOff();
        },
      )
      .command(
        'write-env',
        'Append session + OTEL env vars to .env.agent.<id>',
        (y: Argv) =>
          y
            .option('agent-id', { type: 'number', demandOption: true })
            .option('repo', { type: 'string', default: '.' })
            .option('env-file', { type: 'string' })
            .option('work-dir', { type: 'string' })
            .option('branch', { type: 'string' })
            .option('suffix', { type: 'string' })
            .option('purpose', { type: 'string' })
            .option('session-key', { type: 'string' })
            .option('otel-ready', { type: 'boolean' }),
        (argv) =>
          handleWriteEnv({
            agentId: argv['agent-id'] as number,
            repo: argv.repo as string,
            envFile: argv['env-file'] as string | undefined,
            workDir: argv['work-dir'] as string | undefined,
            branch: argv.branch as string | undefined,
            suffix: argv.suffix as string | undefined,
            purpose: argv.purpose as string | undefined,
            sessionKey: argv['session-key'] as string | undefined,
            otelReady: argv['otel-ready'] as boolean | undefined,
          }).catch((err) => {
            error(err instanceof Error ? err.message : String(err));
            process.exitCode = 1;
          }),
      )
      .command(
        'print-env',
        'Print telemetry env block to stdout',
        (y: Argv) =>
          y
            .option('agent-id', { type: 'number', demandOption: true })
            .option('repo', { type: 'string', default: '.' })
            .option('work-dir', { type: 'string' })
            .option('branch', { type: 'string' })
            .option('suffix', { type: 'string' })
            .option('otel-ready', { type: 'boolean', default: true }),
        (argv) =>
          handlePrintEnv({
            agentId: argv['agent-id'] as number,
            repo: argv.repo as string,
            workDir: argv['work-dir'] as string | undefined,
            branch: argv.branch as string | undefined,
            suffix: argv.suffix as string | undefined,
            otelReady: argv['otel-ready'] as boolean,
          }),
      )
      .command(
        'codex-snippet',
        'Print or write a Codex [otel] config snippet',
        (y: Argv) =>
          y
            .option('agent-id', { type: 'number', demandOption: true })
            .option('repo', { type: 'string', default: '.' })
            .option('work-dir', { type: 'string' })
            .option('branch', { type: 'string' })
            .option('suffix', { type: 'string' })
            .option('write', {
              type: 'boolean',
              default: false,
              describe: 'Write to .har/telemetry/codex.otel.toml.snippet',
            }),
        (argv) =>
          handleCodexSnippet({
            agentId: argv['agent-id'] as number,
            repo: argv.repo as string,
            workDir: argv['work-dir'] as string | undefined,
            branch: argv.branch as string | undefined,
            suffix: argv.suffix as string | undefined,
            write: argv.write as boolean,
          }),
      )
      .demandCommand(1, 'Please specify a subcommand: status, on, off, write-env, print-env, codex-snippet'),
  handler: () => {},
};
