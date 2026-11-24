import * as path from 'path';
import type { Argv } from 'yargs';
import { getControlApiUrl } from '../../core/control-config';
import { ensureRepoRegisteredWithControl, isControlApiReachable } from '../../core/control-sync';
import { resolveHarnessRoot } from '../../harness/manifest';
import {
  disableOtelHooksExport,
  ensureOtelHooks,
  getOtelHooksConfigPath,
  getOtelHooksHome,
  inspectTelemetryDrift,
} from '../../core/otel-hooks';
import { readSlotRegistry } from '../../core/slot-registry';
import {
  DEFAULT_TELEMETRY_LEVEL,
  TELEMETRY_LEVELS,
  TELEMETRY_LEVEL_DESCRIPTIONS,
  describeTelemetryLevel,
  ensureDefaultTelemetryPreference,
  getTelemetryLevel,
  getTelemetryPreferencePath,
  getTelemetrySignals,
  isTelemetryEnabled,
  readTelemetryPreference,
  writeTelemetryLevel,
  type TelemetryLevel,
} from '../../core/telemetry-config';
import {
  appendTelemetryEnvToFile,
  buildSessionKey,
  buildTelemetryEnvBlock,
} from '../../core/telemetry-env';
import { ensureTelemetryInfrastructure } from '../../core/telemetry-ensure';
import {
  describeAgentTelemetryRoute,
  readAppliedDirectRoute,
  resolveAgentTelemetryRoute,
} from '../../core/telemetry-direct';
import { error, header, info, success, warn } from '../../utils/logging';
import { telemetryDestinationCommand } from './telemetry-destination';

function printLevels(current: TelemetryLevel): void {
  info('Levels (each includes the ones below it; recorded in local Mission Control):');
  for (const entry of TELEMETRY_LEVEL_DESCRIPTIONS) {
    const marker = entry.level === current ? '❯' : ' ';
    info(`  ${marker} ${entry.level.padEnd(7)} ${entry.label} — ${entry.detail}`);
  }
  info('Change: har telemetry on --level <full|outline|usage>   •   har telemetry off');
  info('HAR HQ gets the text only with har control trajectory on.');
}

async function handleStatus(argv: { json: boolean }): Promise<void> {
  const preference = readTelemetryPreference();
  const enabled = isTelemetryEnabled();
  const level = getTelemetryLevel();
  const signals = getTelemetrySignals();
  const drift = inspectTelemetryDrift();
  const apiUrl = getControlApiUrl();
  const reachable = enabled ? await isControlApiReachable(apiUrl) : false;
  const routeDecision = resolveAgentTelemetryRoute(getOtelHooksHome());
  const route = routeDecision.route;
  const applied = readAppliedDirectRoute(getOtelHooksHome());
  // Names only: a destination's endpoint headers never reach this output.
  const agentTraces = {
    mode: route.mode,
    label: describeAgentTelemetryRoute(route),
    ...(route.mode === 'direct' ? { destination: route.destination.name } : {}),
    appliedDirectDestination: applied?.destination ?? null,
    ...(routeDecision.hint ? { hint: routeDecision.hint } : {}),
  };
  const payload = {
    enabled,
    level,
    preferenceEnabled: preference.enabled,
    preferenceLevel: preference.level,
    signals,
    hookConfigDrift: drift.mismatches,
    preferencePath: getTelemetryPreferencePath(),
    updatedAt: preference.updatedAt ?? null,
    envOverride: process.env.HAR_TELEMETRY ?? null,
    controlApiUrl: apiUrl,
    controlReachable: reachable,
    agentTraces,
    otelEndpoint: `${apiUrl.replace(/\/$/, '')}/api/otel`,
    otelHooksHome: getOtelHooksHome(),
    otelHooksConfig: getOtelHooksConfigPath(),
    levels: TELEMETRY_LEVEL_DESCRIPTIONS.map((entry) => ({ ...entry })),
  };

  if (argv.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  header('har telemetry status');
  const described = describeTelemetryLevel(level);
  info(
    `Level:         ${level} — ${described.label}: ${described.summary}${process.env.HAR_TELEMETRY ? ' (HAR_TELEMETRY override)' : ''}`,
  );
  info(`Preference:    ${getTelemetryPreferencePath()}${preference.updatedAt ? ` (updated ${preference.updatedAt})` : ` (default ${DEFAULT_TELEMETRY_LEVEL})`}`);
  info(`Mission Control: ${apiUrl} (${reachable ? 'reachable' : 'not reachable'})`);
  info(`Agent traces:  ${agentTraces.label}`);
  if (routeDecision.hint) info(routeDecision.hint);
  const appliedName = applied?.destination ?? null;
  const wantedName = route.mode === 'direct' ? route.destination.name : null;
  if (appliedName !== wantedName) {
    warn(
      `Agents currently send traces ${appliedName ? `directly to "${appliedName}"` : 'to Mission Control'} — run har telemetry on to apply the route above.`,
    );
  }
  info(`OTLP endpoint: ${payload.otelEndpoint}`);
  info(`Hooks home:    ${payload.otelHooksHome}`);

  // Hooks installed + collector down is the failure state worth naming (#328):
  // every agent turn pays the export budget for telemetry nobody receives.
  if (enabled && !reachable && route.mode === 'control') {
    warn(
      'Agent hooks are installed but Mission Control is not reachable — each turn pays the export timeout for telemetry nobody receives.',
    );
    info('Start it with: har control up   •   or stop exporting: har telemetry off');
  }

  // The hook config agents read disagrees with the level: they record
  // something other than what this command just claimed.
  if (drift.mismatches.length > 0) {
    warn(`Agents are not recording at level ${level} — ${drift.configPath} is out of date:`);
    for (const mismatch of drift.mismatches) warn(`  • ${mismatch}`);
    info(`Fix: har telemetry on --level ${level === 'off' ? DEFAULT_TELEMETRY_LEVEL : level}   (then start a new agent session)`);
  }

  printLevels(level);
}

async function handleOn(argv: { level: TelemetryLevel }): Promise<void> {
  header('har telemetry on');
  const preference = writeTelemetryLevel(argv.level);
  const described = describeTelemetryLevel(preference.level);
  success(`Telemetry level: ${preference.level} — ${described.label}: ${described.summary}.`);
  if (preference.signals.prompts) {
    warn('Prompt and tool text will leave the agent for local Mission Control (also used as session purpose).');
  }

  const result = await ensureTelemetryInfrastructure({ startIfNeeded: true });
  if (result.message) success(result.message);

  const hooks = ensureOtelHooks({ setupAgents: true });
  // Without Mission Control, one destination takes agent traces directly.
  if (result.warning && hooks.route.mode !== 'direct') warn(result.warning);
  if (hooks.message) success(hooks.message);
  if (hooks.warning) warn(hooks.warning);
  if (hooks.route.mode === 'direct') {
    success(`Agent traces: ${describeAgentTelemetryRoute(hooks.route)} (Mission Control is off; only otel-hook traces go direct)`);
  }
  if (hooks.routeHint) info(hooks.routeHint);
  if (result.otelReady) {
    await ensureRepoRegisteredWithControl(process.cwd(), result.apiUrl);
    info(`OTLP ingest: ${result.apiUrl.replace(/\/$/, '')}/api/otel`);
    info('Usage appears under Mission Control → Worktrees / Usage. Disable: har telemetry off');
  }
  info('Agent sessions already running keep their old settings — start a new session to pick this up.');
  printLevels(preference.level);
}

/**
 * The level `har telemetry on` writes: `--level` wins; the older
 * `--prompts` / `--no-prompts` flags map to full / outline.
 */
export function resolveOnLevel(argv: { level?: string; prompts?: boolean }): TelemetryLevel {
  if (argv.level) return argv.level as TelemetryLevel;
  if (argv.prompts === false) return 'outline';
  return DEFAULT_TELEMETRY_LEVEL;
}

async function handleOff(): Promise<void> {
  header('har telemetry off');
  writeTelemetryLevel('off');
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

  // Do not write per-session resource attributes into the global
  // ~/.har/otel-hooks/otel_config.json — that file is shared by every Cursor /
  // Claude / Codex hook invocation. A stale session.id / factory.local.* from
  // the last launch made Mission Control drop or mis-attribute IDE activity.
  // Session attribution for OTEL ingest uses workspace / otelhook.workspace.id
  // matching against registered repos and active slots instead.
  if (isTelemetryEnabled()) {
    ensureOtelHooks({ setupAgents: false });
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
    warn(`Telemetry is off — setting level ${DEFAULT_TELEMETRY_LEVEL} so hooks can export.`);
    writeTelemetryLevel(DEFAULT_TELEMETRY_LEVEL);
  }
  const result = await ensureTelemetryInfrastructure({ startIfNeeded: true });
  if (result.message) success(result.message);
  if (result.warning) warn(result.warning);
  if (result.otelReady) {
    await ensureRepoRegisteredWithControl(process.cwd(), result.apiUrl);
  }
  const hooks = ensureOtelHooks({ setupAgents: true });
  if (hooks.ok) {
    success(hooks.message ?? '@osfactory/otel-hook installed and agents registered');
    info(`Config: ${hooks.configPath}`);
    info(`Wrapper: ${hooks.wrapperPath}`);
  } else {
    error(hooks.warning ?? 'Failed to install @osfactory/otel-hook');
    process.exitCode = 1;
  }
}

export const telemetryCommand = {
  command: 'telemetry <subcommand>',
  describe: 'Agent usage telemetry (Cursor / Claude / Codex via @osfactory/otel-hook → Mission Control)',
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
        'Turn telemetry on at a level (default full), ensure Mission Control, install/configure @osfactory/otel-hook',
        (y: Argv) =>
          y
            .option('level', {
              type: 'string',
              choices: TELEMETRY_LEVELS.filter((level) => level !== 'off'),
              describe:
                'full: prompts, replies, tool I/O · outline: steps and timing, no text · usage: tokens and cost (default full)',
            })
            .option('prompts', {
              type: 'boolean',
              describe: 'Older spelling: --prompts = --level full, --no-prompts = --level outline',
            }),
        (argv) => {
          void handleOn({
            level: resolveOnLevel({
              level: argv.level as string | undefined,
              prompts: argv.prompts as boolean | undefined,
            }),
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
        'Install @osfactory/otel-hook and register Cursor / Claude / Codex',
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
      .command(telemetryDestinationCommand)
      .demandCommand(1, 'Please specify a subcommand: status, on, off, install-hooks, write-env, print-env, destination'),
  handler: () => {},
};
