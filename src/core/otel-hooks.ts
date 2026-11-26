import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { removeClaudeNativeTelemetry } from './claude-native-telemetry';
import { getControlApiUrl } from './control-config';
import {
  getTelemetryLevel,
  getTelemetrySignals,
  isTelemetryEnabled,
  signalsForLevel,
  type TelemetryLevel,
} from './telemetry-config';
import {
  HAR_RESOURCE_ATTRIBUTES_ENV,
  ROUTE_STRIP_LOCAL_ENV,
  appliedRouteNames,
  getRouteEnvPath,
  otelHookSupportsDestinations,
  planRouteDestinations,
  readAppliedAgentRoute,
  resolveAgentTelemetryRoute,
  routeMetricsIncludeSessionId,
  routeSendsLogs,
  routeSendsMetrics,
  routeStripsLocalPaths,
  writeRouteEnv,
  type AgentTelemetryRoute,
  type AgentTelemetryRouteDecision,
} from './telemetry-route';
import { LOCAL_ATTR_PREFIX, type OtelHookScope } from '../harness/schema';
import { sessionContextRoot } from './session-context';

/**
 * The otel-hook version HAR installs: the one place to change it. 0.14.0 has
 * per-destination repository `scopes` (HAR HQ opt-in per repository); 0.13.2
 * subagent usage, Codex rollout usage with a bounded export, and the Windows
 * spool claim; 0.12.0 brought the session context (`sessionContext.dir`, ADR
 * 0004 section 3), 0.11.0 per-destination metrics, 0.10.0 Claude Code
 * transcript usage.
 */
export const OTEL_HOOKS_VERSION = '0.14.0';

/** Pinned npm package for reproducible installs (replaces Python opentelemetry-hooks). */
export const OTEL_HOOKS_PACKAGE = `@osfactory/otel-hook@${OTEL_HOOKS_VERSION}`;

/**
 * Environment override for the package spec HAR installs: any spec the package
 * manager accepts (`@osfactory/otel-hook@0.14.0`, a local `.tgz`, a directory).
 * For testing an unreleased otel-hook build; unset, HAR installs the pin.
 */
export const OTEL_HOOKS_PACKAGE_ENV = 'HAR_OTEL_HOOKS_PACKAGE';

/** The package spec HAR installs: the override when set, else the pin. */
export function otelHooksPackageSpec(env: NodeJS.ProcessEnv = process.env): string {
  return env[OTEL_HOOKS_PACKAGE_ENV]?.trim() || OTEL_HOOKS_PACKAGE;
}

/** Records the spec of the last install, so a changed override reinstalls. */
const INSTALLED_SPEC_FILE = '.har-package-spec';

/**
 * Budgets for the hooks HAR installs into agent settings (#328).
 *
 * A telemetry hook must never cost the user a turn. Hooks fire on session
 * start, every prompt, before and after every tool call, and on stop — so an
 * export that blocks compounds across a single turn. Without an explicit
 * per-hook timeout the agent falls back to its own generous default, and an
 * unreachable Mission Control stalls the session before its first model
 * request, indistinguishable from a broken API.
 *
 * The export budget is deliberately well inside the per-hook ceiling, so the
 * hook returns on its own rather than being killed by the agent. It is also
 * kept small in absolute terms: six or more hooks fire per turn, so every
 * second here is paid several times over whenever the collector is down. A
 * local Mission Control answers in milliseconds, so this costs nothing in the
 * normal case.
 */
export const HOOK_TIMEOUT_SECONDS = 10;
const HOOK_EXPORT_TIMEOUT_MS = 1500;
const HOOK_FLUSH_TIMEOUT_MS = 500;

/** Providers HAR registers with `otel-hook setup --provider`. */
export const OTEL_HOOKS_PROVIDERS = [
  { id: 'cursor', label: 'cursor' },
  { id: 'claude-code', label: 'claude' },
  { id: 'codex', label: 'codex' },
] as const;

export type OtelHooksProviderId = (typeof OTEL_HOOKS_PROVIDERS)[number]['id'];

/** @deprecated Use OTEL_HOOKS_PROVIDERS — kept for callers that still say "agents". */
export const OTEL_HOOKS_AGENTS = ['cursor', 'claude', 'codex'] as const;
export type OtelHooksAgent = (typeof OTEL_HOOKS_AGENTS)[number];

/**
 * HAR-managed `@osfactory/otel-hook` config file (`--config-file`).
 * Shape matches the package's `OtelHookConfigPatch` (not the old Python IDE_OTEL_* keys).
 */
/**
 * One `exporter.destinations[]` entry (otel-hook >= 0.9.0). Header values are
 * always `env:<VAR>` references to `direct.env`, never the secret itself;
 * Mission Control's entry has none.
 */
export interface OtelHooksDestinationConfig {
  name: string;
  tracesEndpoint?: string;
  logsEndpoint?: string;
  metricsEndpoint?: string;
  headers?: Record<string, string>;
  signals: Array<'traces' | 'logs' | 'metrics'>;
  /** Per-repository filter (otel-hook with destination scopes); never written to an otel-hook without them. */
  scopes?: OtelHookScope[];
}

export interface OtelHooksConfig {
  exporter: {
    enabled: boolean;
    endpoint?: string;
    protocol: 'http/protobuf';
    serviceName: string;
    resourceAttributes?: Record<string, string | number | boolean>;
    /** Every place the hook sends to, Mission Control first (see `telemetry-route.ts`). */
    destinations?: OtelHooksDestinationConfig[];
    logs: {
      enabled: boolean;
      endpoint?: string;
      includeContent: boolean;
    };
    /**
     * Hook-derived metrics (otel-hook >= 0.11.0). A destination receives them
     * when its `signals` name `metrics`; `includeSessionId` is one setting for
     * every destination in otel-hook.
     */
    metrics?: {
      includeSessionId: boolean;
    };
  };
  privacy: {
    contentMode: 'omit' | 'raw';
    allowRawContent: boolean;
  };
  /** Claude Code token usage read from the transcript at Stop (hooks carry none; ADR 0005 section 6). */
  providers?: {
    claudeCode: { readTranscriptUsage: boolean };
  };
  /** The session context directory HAR writes (ADR 0004 section 3): the only source of work identity. */
  sessionContext?: {
    dir: string;
  };
}

/** What the installed otel-hook understands; written keys it does not know make it reject the whole file. */
export interface OtelHookFeatures {
  /** `exporter.destinations[]` with `env:` header values (0.9.0). */
  destinations: boolean;
  /** `providers.claudeCode.readTranscriptUsage` (0.10.0). */
  transcriptUsage: boolean;
  /** Per-destination `metrics` signal and `exporter.metrics` (0.11.0). */
  metrics: boolean;
  /** `sessionContext.dir` (0.12.0). */
  sessionContext: boolean;
  /** Per-destination repository `scopes` (0.14.0). */
  scopes: boolean;
}

/** Every feature: the pinned version, and what a config is built for when no hook is installed yet. */
export const ALL_OTEL_HOOK_FEATURES: OtelHookFeatures = Object.freeze({
  destinations: true,
  transcriptUsage: true,
  metrics: true,
  sessionContext: true,
  scopes: true,
});

export interface EnsureOtelHooksResult {
  ok: boolean;
  hooksHome: string;
  configPath: string;
  wrapperPath: string;
  otelHookCommand: string | null;
  message?: string;
  warning?: string;
  agentsSetup: OtelHooksAgent[];
  providersSetup: OtelHooksProviderId[];
  errors: string[];
  /** Where agent hook traces go now (see `telemetry-route.ts`). */
  route: AgentTelemetryRoute;
  /** Why the route is narrower than might be expected. */
  routeHint?: string;
}

/**
 * First otel-hook release with per-destination repository `scopes`
 * (otel-hook#78), and a string its CLI bundle contains from then on, so
 * an unreleased build installed through `HAR_OTEL_HOOKS_PACKAGE` is detected.
 */
export const OTEL_HOOK_SCOPES_MIN_VERSION = '0.14.0';
export const OTEL_HOOK_SCOPES_MARKER = 'scope_count';

export function getOtelHooksHome(): string {
  if (process.env.HAR_OTEL_HOOKS_HOME) {
    return path.resolve(process.env.HAR_OTEL_HOOKS_HOME);
  }
  return path.join(os.homedir(), '.har', 'otel-hooks');
}

export function getOtelHooksConfigPath(hooksHome = getOtelHooksHome()): string {
  return path.join(hooksHome, 'otel_config.json');
}

export function getOtelHooksWrapperPath(hooksHome = getOtelHooksHome()): string {
  return path.join(hooksHome, 'run-otel-hook.sh');
}

export function getOtelHooksStateDir(hooksHome = getOtelHooksHome()): string {
  return path.join(hooksHome, 'state');
}

function localOtelHookBin(hooksHome: string): string {
  return path.join(hooksHome, 'node_modules', '.bin', 'otel-hook');
}

function installedPackageVersion(hooksHome: string): string | null {
  try {
    const pkgPath = path.join(
      hooksHome,
      'node_modules',
      '@osfactory',
      'otel-hook',
      'package.json',
    );
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function installedSpec(hooksHome: string): string | null {
  try {
    return fs.readFileSync(path.join(hooksHome, INSTALLED_SPEC_FILE), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function recordInstalledSpec(hooksHome: string, spec: string): void {
  try {
    fs.writeFileSync(path.join(hooksHome, INSTALLED_SPEC_FILE), `${spec}\n`);
  } catch {
    // best-effort: a missing record only means the next run reinstalls
  }
}

/**
 * Whether the hooks prefix needs a (re)install. The pin is checked by the
 * installed version; an override, whose version HAR cannot know up front, by
 * the spec recorded at install time. Switching between them reinstalls.
 */
export function needsPackageInstall(hooksHome: string, spec: string): boolean {
  const recorded = installedSpec(hooksHome);
  if (spec !== OTEL_HOOKS_PACKAGE) return recorded !== spec;
  if (recorded !== null && recorded !== spec) return true;
  return installedPackageVersion(hooksHome) !== pinnedVersion();
}

function pinnedVersion(): string {
  const at = OTEL_HOOKS_PACKAGE.lastIndexOf('@');
  // package name is @osfactory/otel-hook@version — split on the last @
  return at > 0 ? OTEL_HOOKS_PACKAGE.slice(at + 1) : OTEL_HOOKS_PACKAGE;
}

/** Parse `OTEL_RESOURCE_ATTRIBUTES` / HAR session attrs into a config object. */
export function parseResourceAttributesString(
  raw: string | null | undefined,
): Record<string, string> {
  if (!raw?.trim()) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!key || key === 'service.name' || key === 'service.namespace') continue;
    out[key] = value;
  }
  return out;
}

function versionAtLeast(version: string, min: string): boolean {
  const parse = (value: string) => value.split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const [x, y] = [parse(version), parse(min)];
  for (let index = 0; index < 3; index += 1) {
    if (x[index] !== y[index]) return x[index] > y[index];
  }
  return true;
}

/**
 * What the otel-hook installed in the hooks home understands, by version, or
 * (for an unreleased build installed through `HAR_OTEL_HOOKS_PACKAGE`) by what
 * its CLI bundle contains. Null when none is installed.
 */
export function detectOtelHookFeatures(hooksHome = getOtelHooksHome()): OtelHookFeatures | null {
  const pkgDir = path.join(hooksHome, 'node_modules', '@osfactory', 'otel-hook');
  let pkg: { version?: string; bin?: string | Record<string, string> };
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as typeof pkg;
  } catch {
    return null;
  }
  const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  let bundle = '';
  try {
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['otel-hook'];
    if (bin) bundle = fs.readFileSync(path.join(pkgDir, bin), 'utf8');
  } catch {
    bundle = '';
  }
  const has = (min: string, marker: string) => versionAtLeast(version, min) || bundle.includes(marker);
  return {
    destinations: otelHookSupportsDestinations(hooksHome),
    transcriptUsage: has('0.10.0', 'readTranscriptUsage'),
    metrics: has('0.11.0', 'metricsEndpoint'),
    sessionContext: has('0.12.0', 'session-context-dir'),
    scopes: has(OTEL_HOOK_SCOPES_MIN_VERSION, OTEL_HOOK_SCOPES_MARKER),
  };
}

/** Build HAR-managed otel-hook config from current telemetry signals and the destination route. */
export function buildOtelHooksConfig(options?: {
  enabled?: boolean;
  apiUrl?: string;
  resourceAttributes?: string;
  /**
   * Where telemetry goes. Default: Mission Control alone, at `apiUrl`. Every
   * entry goes into `exporter.destinations[]`; no `exporter.endpoint` is
   * written, since otel-hook would add it as a `default` destination next to the list.
   */
  route?: AgentTelemetryRoute;
  /**
   * The installed otel-hook predates `exporter.destinations[]` (< 0.9.0):
   * write Mission Control as the single `exporter.endpoint` instead.
   */
  legacySingleEndpoint?: boolean;
  /** What the installed otel-hook understands (default: every feature of the pinned version). */
  features?: OtelHookFeatures;
  /** Session context directory (default: `~/.har/sessions` or `HAR_SESSIONS_DIR`). */
  sessionContextDir?: string;
}): OtelHooksConfig {
  // Every switch comes from the level: the hook exports spans from Outline up,
  // its event records (the only channel that carries text) alongside them,
  // and the text itself only at Full.
  const signals = options?.enabled === false ? signalsForLevel('off') : getTelemetrySignals();
  const features = options?.features ?? ALL_OTEL_HOOK_FEATURES;
  const apiUrl = (options?.apiUrl ?? getControlApiUrl()).replace(/\/$/, '');
  const route: AgentTelemetryRoute = options?.route ?? { mode: 'fanout', missionControl: apiUrl, destinations: [] };
  const resourceAttributes = parseResourceAttributesString(options?.resourceAttributes);
  if (routeStripsLocalPaths(route)) {
    // A destination that does not take local paths: every destination gets the same Resource.
    for (const key of Object.keys(resourceAttributes)) {
      if (key.startsWith(LOCAL_ATTR_PREFIX)) delete resourceAttributes[key];
    }
  }
  const legacy = options?.legacySingleEndpoint === true && route.mode === 'fanout' && route.missionControl !== undefined;
  const plans = planRouteDestinations(route);
  // Nothing to send to (no Mission Control, no destination): export nothing.
  const enabled = signals.traces && (legacy || plans.length > 0);
  const logsEnabled = enabled && signals.logs && routeSendsLogs(route);
  const metricsEnabled = enabled && !legacy && features.metrics && signals.metrics && routeSendsMetrics(route);
  const capturePrompts = logsEnabled && signals.prompts;
  const destinations =
    enabled && !legacy
      ? plans
          // A scoped destination (every hosted receiver) is never written without its scopes:
          // an otel-hook that cannot filter by repository would send it every repository.
          .filter((plan) => plan.scopes === undefined || features.scopes)
          .map((plan): OtelHooksDestinationConfig => {
          const logs = logsEnabled && plan.signals.includes('logs');
          const metrics = metricsEnabled && plan.signals.includes('metrics');
          const planSignals = plan.signals.filter(
            (signal) => signal === 'traces' || (signal === 'logs' && logs) || (signal === 'metrics' && metrics),
          );
          return {
            name: plan.name,
            ...(plan.tracesEndpoint ? { tracesEndpoint: plan.tracesEndpoint } : {}),
            ...(logs && plan.logsEndpoint ? { logsEndpoint: plan.logsEndpoint } : {}),
            ...(metrics && plan.metricsEndpoint ? { metricsEndpoint: plan.metricsEndpoint } : {}),
            ...(plan.headers.length > 0
              ? { headers: Object.fromEntries(plan.headers.map((binding) => [binding.header, `env:${binding.envVar}`])) }
              : {}),
            signals: planSignals,
            ...(plan.scopes ? { scopes: plan.scopes } : {}),
          };
        })
      : undefined;
  // A logs- or metrics-only destination with that signal off at this level has nothing left to receive.
  const sending = destinations?.filter((destination) => destination.signals.length > 0);
  const legacyUrl = legacy && route.mode === 'fanout' ? route.missionControl : undefined;

  return {
    exporter: {
      enabled,
      ...(enabled && legacyUrl ? { endpoint: `${legacyUrl}/api/otel/v1/traces` } : {}),
      // otel-hook exports OTLP/HTTP protobuf only; every OTLP/HTTP receiver takes it.
      protocol: 'http/protobuf',
      serviceName: 'har-ide-agent',
      ...(Object.keys(resourceAttributes).length > 0 ? { resourceAttributes } : {}),
      ...(sending && sending.length > 0 ? { destinations: sending } : {}),
      logs: {
        enabled: logsEnabled,
        ...(logsEnabled && legacyUrl ? { endpoint: `${legacyUrl}/api/otel/v1/logs` } : {}),
        includeContent: capturePrompts,
      },
      ...(metricsEnabled ? { metrics: { includeSessionId: routeMetricsIncludeSessionId(route) } } : {}),
    },
    privacy: {
      contentMode: capturePrompts ? 'raw' : 'omit',
      allowRawContent: capturePrompts,
    },
    // Hooks carry no token counts: otel-hook reads Claude Code's from the transcript at Stop.
    ...(features.transcriptUsage && !legacy ? { providers: { claudeCode: { readTranscriptUsage: true } } } : {}),
    // Work identity comes from the session context only, never from the environment.
    ...(features.sessionContext && !legacy
      ? { sessionContext: { dir: path.resolve(options?.sessionContextDir ?? sessionContextRoot()) } }
      : {}),
  };
}

export function writeOtelHooksConfig(
  config: OtelHooksConfig,
  hooksHome = getOtelHooksHome(),
): string {
  fs.mkdirSync(hooksHome, { recursive: true });
  const configPath = getOtelHooksConfigPath(hooksHome);
  // Write schema-only JSON — @osfactory/otel-hook rejects unknown keys (e.g. `_comment`)
  // and falls back to defaults with OTLP export disabled.
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

export function writeOtelHooksWrapper(
  otelHookCommand: string,
  hooksHome = getOtelHooksHome(),
): string {
  fs.mkdirSync(hooksHome, { recursive: true });
  fs.mkdirSync(getOtelHooksStateDir(hooksHome), { recursive: true });
  const wrapperPath = getOtelHooksWrapperPath(hooksHome);
  const configPath = getOtelHooksConfigPath(hooksHome);
  const stateDir = getOtelHooksStateDir(hooksHome);
  const routeEnvPath = getRouteEnvPath(hooksHome);
  const script = `#!/usr/bin/env bash
# Managed by har telemetry — invokes @osfactory/otel-hook with HAR config.
#
# Two rules for this wrapper (#328):
#   1. Bounded. Export and flush budgets keep it well inside the per-hook
#      timeout the agent enforces, so an unreachable Mission Control costs
#      milliseconds instead of stalling the session.
#   2. Silent about its own failures. Dropped telemetry must never fail an
#      agent turn, so the exit status is always 0 — a non-zero hook exit can
#      block a tool call.
set -uo pipefail
# Claude Code (>= 2.1.128) removes every OTEL_* variable from the hooks it runs
# (#484): restore the session profile from the copy HAR writes next to it in
# .env.agent.<id>. Before the strip below, so the privacy filter still applies.
if [ -z "\${OTEL_RESOURCE_ATTRIBUTES:-}" ] && [ -n "\${${HAR_RESOURCE_ATTRIBUTES_ENV}:-}" ]; then
  export OTEL_RESOURCE_ATTRIBUTES="$${HAR_RESOURCE_ATTRIBUTES_ENV}"
fi
# Destination header values live in a mode-0600 file, never in this script,
# the hook config or on a command line.
if [ -f "${routeEnvPath}" ]; then
  . "${routeEnvPath}" || true
fi
# No Mission Control in the destination list, and a destination that does not
# take local paths: drop local-only paths from the Resource.
if [ -n "\${${ROUTE_STRIP_LOCAL_ENV}:-}" ] && [ -n "\${OTEL_RESOURCE_ATTRIBUTES:-}" ]; then
  _har_kept=""
  IFS=',' read -ra _har_parts <<< "$OTEL_RESOURCE_ATTRIBUTES"
  for _har_part in "\${_har_parts[@]}"; do
    case "\${_har_part#"\${_har_part%%[![:space:]]*}"}" in
      ${LOCAL_ATTR_PREFIX}*) ;;
      *) _har_kept="\${_har_kept:+$_har_kept,}$_har_part" ;;
    esac
  done
  export OTEL_RESOURCE_ATTRIBUTES="$_har_kept"
fi
"${otelHookCommand}" run \\
  --config-file "${configPath}" \\
  --state-dir "${stateDir}" \\
  --timeout-ms ${HOOK_EXPORT_TIMEOUT_MS} \\
  --flush-timeout-ms ${HOOK_FLUSH_TIMEOUT_MS} \\
  "$@" || true
exit 0
`;
  fs.writeFileSync(wrapperPath, script, { mode: 0o755 });
  try {
    fs.chmodSync(wrapperPath, 0o755);
  } catch {
    // best-effort on platforms without chmod
  }
  return wrapperPath;
}

function commandExists(command: string): boolean {
  const result = spawnSync('sh', ['-c', `command -v ${JSON.stringify(command)}`], {
    encoding: 'utf8',
  });
  return result.status === 0 && Boolean(result.stdout?.trim());
}

function resolveOtelHookCommand(hooksHome: string): string | null {
  const local = localOtelHookBin(hooksHome);
  if (fs.existsSync(local)) return local;
  return null;
}

/**
 * Installer for the private hooks prefix, in preference order. Each writes into
 * `hooksHome/node_modules/.bin`, so a machine with any one of them can run the
 * hook — npm is not a hard requirement.
 */
function resolveHooksInstaller(
  hooksHome: string,
  spec: string,
): { command: string; args: string[] } | null {
  const candidates: Array<{ command: string; args: string[] }> = [
    {
      command: 'npm',
      args: ['install', '--prefix', hooksHome, '--no-fund', '--no-audit', spec],
    },
    { command: 'bun', args: ['add', '--cwd', hooksHome, spec] },
    { command: 'pnpm', args: ['add', '--dir', hooksHome, spec] },
  ];
  return candidates.find((candidate) => commandExists(candidate.command)) ?? null;
}

function tryInstallPackage(hooksHome: string, spec: string): { ok: boolean; detail: string } {
  fs.mkdirSync(hooksHome, { recursive: true });
  const installer = resolveHooksInstaller(hooksHome, spec);
  if (!installer) {
    return {
      ok: false,
      detail: 'no package manager found; install Node.js or bun to use @osfactory/otel-hook',
    };
  }
  const described = `${installer.command} ${installer.args.join(' ')}`;
  const result = spawnSync(installer.command, installer.args, {
    encoding: 'utf8',
    timeout: 180_000,
  });
  if (result.status === 0 && fs.existsSync(localOtelHookBin(hooksHome))) {
    recordInstalledSpec(hooksHome, spec);
    return { ok: true, detail: described };
  }
  return {
    ok: false,
    detail: `${described} failed: ${(result.stderr || result.stdout || '').trim().slice(0, 400)}`,
  };
}

/** Best-effort removal of the legacy Python package so only the TS CLI remains. */
function uninstallLegacyPythonHooks(hooksHome: string): void {
  const attempts: Array<[string, string[]]> = [
    ['uv', ['tool', 'uninstall', 'opentelemetry-hooks']],
    ['pipx', ['uninstall', 'opentelemetry-hooks']],
    ['pip', ['uninstall', '-y', 'opentelemetry-hooks']],
    ['pip3', ['uninstall', '-y', 'opentelemetry-hooks']],
  ];
  for (const [cmd, args] of attempts) {
    if (!commandExists(cmd)) continue;
    try {
      spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000 });
    } catch {
      // ignore
    }
  }
  removeLegacyPythonArtifacts(hooksHome);
}

/** Drop the old prefix-local Python venv and config files HAR no longer uses. */
function removeLegacyPythonArtifacts(hooksHome: string): void {
  const legacyPaths = [
    path.join(hooksHome, '.venv'),
    path.join(hooksHome, 'otel_config.yaml'),
    path.join(hooksHome, 'venv'),
  ];
  for (const target of legacyPaths) {
    try {
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
      }
    } catch {
      // best-effort
    }
  }
}

function isOtelHookCommand(command: string, wrapperPath?: string): boolean {
  if (
    command.includes('otel-hook') ||
    command.includes('otel_hook.py') ||
    command.includes('opentelemetry-hooks')
  ) {
    return true;
  }
  return wrapperPath !== undefined && command.includes(wrapperPath);
}

function normalizeLegacyProviderFlagsInCommand(command: string): string {
  return command
    .replace(/(^|\s)--cursor(?=\s|$)/g, '$1--provider cursor')
    .replace(/(^|\s)--claude(?=\s|$)/g, '$1--provider claude-code')
    .replace(/(^|\s)--codex(?=\s|$)/g, '$1--provider codex');
}

/**
 * Cursor events the legacy Python installer registered but the TypeScript
 * otel-hook deliberately skips (duplicate or unpairable telemetry).
 * Keep in sync with otel-hook `CURSOR_UNREGISTERED_HOOK_EVENTS`.
 */
export const LEGACY_CURSOR_ONLY_HOOK_EVENTS = [
  'afterAgentResponse',
  'afterAgentThought',
  'beforeShellExecution',
  'afterShellExecution',
  'beforeMCPExecution',
  'afterMCPExecution',
  'beforeReadFile',
  'subagentStart',
  'subagentStop',
] as const;

/**
 * Argv for `otel-hook setup`, split out so the hook budget is testable without
 * spawning the installer.
 */
export function buildOtelHookSetupArgs(
  providerId: OtelHooksProviderId,
  hookCommand: string,
): string[] {
  return [
    'setup',
    '--provider',
    providerId,
    '--scope',
    'global',
    '--hook-command',
    hookCommand,
    '--managed-marker',
    'otel-hook',
    // Written into each generated hook entry so the agent bounds it (#328).
    // Without this the agent falls back to its own default and an unreachable
    // collector stalls the session before its first model request.
    '--timeout-seconds',
    String(HOOK_TIMEOUT_SECONDS),
  ];
}

/**
 * Flags on the Claude Code hook command. Claude Code strips every `OTEL_*`
 * variable from the hooks it runs, so these go on the command line, next to
 * the config file (ADR 0005 section 6):
 *
 * - `--claude-transcript-usage`: token usage of each turn and each subagent,
 *   read from the transcript. Claude Code usage comes from otel-hook only, so
 *   without it no Claude Code tokens are recorded at all.
 * - `--logs`: the event records the trajectory is built from. Which
 *   destinations receive them still follows each one's `signals` in the config.
 * - `--metrics`: token metrics, likewise only to destinations listing `metrics`.
 */
export const CLAUDE_CODE_HOOK_FLAGS = ['--claude-transcript-usage', '--logs', '--metrics'] as const;

/**
 * Flags on the Codex hook command. `--codex-rollout-usage`: each turn's token
 * usage, read from the session's rollout file at `Stop` (Codex's `Stop` hook
 * carries none). Opt-in in otel-hook, so without it no Codex tokens are recorded.
 */
export const CODEX_HOOK_FLAGS = ['--codex-rollout-usage'] as const;

/** The flags HAR puts on a provider's hook command. */
export function providerHookFlags(providerId: OtelHooksProviderId): readonly string[] {
  if (providerId === 'claude-code') return CLAUDE_CODE_HOOK_FLAGS;
  if (providerId === 'codex') return CODEX_HOOK_FLAGS;
  return [];
}

/** The hook command `otel-hook setup` writes into a provider's hook settings. */
export function buildProviderHookCommand(providerId: OtelHooksProviderId, wrapperPath: string): string {
  const flags = providerHookFlags(providerId);
  return `${wrapperPath} --provider ${providerId}${flags.length > 0 ? ` ${flags.join(' ')}` : ''}`;
}

/**
 * Registered hook commands that miss a flag HAR passes today (e.g. hooks
 * registered by HAR 1.x, before `--codex-rollout-usage`): one line each.
 */
export function inspectHookCommandFlags(home = os.homedir()): string[] {
  const files: Array<[OtelHooksProviderId, string]> = [
    ['claude-code', path.join(home, '.claude', 'settings.json')],
    ['codex', path.join(home, '.codex', 'hooks.json')],
  ];
  const out: string[] = [];
  for (const [providerId, filePath] of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }
    const commands: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (!node || typeof node !== 'object') return;
      const command = (node as { command?: unknown }).command;
      if (typeof command === 'string' && isOtelHookCommand(command)) commands.push(command);
      for (const value of Object.values(node as Record<string, unknown>)) walk(value);
    };
    walk((parsed as { hooks?: unknown } | null)?.hooks ?? parsed);
    const missing = new Set<string>();
    for (const command of commands) {
      const words = command.split(/\s+/);
      for (const flag of providerHookFlags(providerId)) if (!words.includes(flag)) missing.add(flag);
    }
    if (missing.size > 0) {
      out.push(`${providerLabel(providerId)} hook command lacks ${[...missing].join(' ')} (har telemetry install-hooks)`);
    }
  }
  return out;
}

function runSetupProvider(
  providerId: OtelHooksProviderId,
  otelHookCommand: string,
  wrapperPath: string,
): { ok: boolean; detail: string } {
  const hookCommand = buildProviderHookCommand(providerId, wrapperPath);
  const result = spawnSync(otelHookCommand, buildOtelHookSetupArgs(providerId, hookCommand), {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.status === 0) {
    return { ok: true, detail: `setup --provider ${providerId}` };
  }
  return {
    ok: false,
    detail: `setup --provider ${providerId} failed: ${(result.stderr || result.stdout || '').trim().slice(0, 400)}`,
  };
}

/**
 * Rewrite hook command entries that invoke otel-hook so they use the HAR wrapper
 * (ensures --config-file / --state-dir point at ~/.har/otel-hooks).
 */
export function rewriteHookCommandsToWrapper(
  filePath: string,
  wrapperPath: string,
): boolean {
  if (!fs.existsSync(filePath)) return false;
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;

  const rewriteCommand = (command: string): string => {
    if (!isOtelHookCommand(command, wrapperPath)) {
      return command;
    }
    const normalized = normalizeLegacyProviderFlagsInCommand(command);
    if (command.includes(wrapperPath)) {
      return normalized;
    }
    // Preserve current CLI args while translating legacy Python source flags.
    const rewritten = normalized.replace(
      /(?:^|[;&|]\s*)(?:env\s+[^=\s]+=\S+\s+)*(?:python3?\s+)?(?:npx\s+)?(?:\S*otel[_-]hook\S*|\S*opentelemetry-hooks\S*)/,
      (match) =>
        match.replace(
          /(?:python3?\s+)?(?:npx\s+)?(?:\S*otel[_-]hook\S*|\S*opentelemetry-hooks\S*)/,
          wrapperPath,
        ),
    );
    return normalizeLegacyProviderFlagsInCommand(rewritten);
  };

  const walk = (node: unknown): boolean => {
    let changed = false;
    if (Array.isArray(node)) {
      for (const item of node) changed = walk(item) || changed;
      return changed;
    }
    if (!node || typeof node !== 'object') return false;
    const obj = node as Record<string, unknown>;
    if (typeof obj.command === 'string') {
      const next = rewriteCommand(obj.command);
      if (next !== obj.command) {
        obj.command = next;
        changed = true;
      }
    }
    for (const value of Object.values(obj)) changed = walk(value) || changed;
    return changed;
  };

  if (!walk(parsed)) return false;
  fs.writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
  return true;
}

/**
 * Remove otel-hook registrations on Cursor events the TypeScript adapter does
 * not manage. The legacy Python installer registered these; they duplicate
 * preToolUse/postToolUse or cannot pair (subagentStop, beforeReadFile).
 */
export function pruneLegacyCursorHookEvents(
  filePath: string,
  wrapperPath: string,
): boolean {
  if (!fs.existsSync(filePath)) return false;
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;
  const root = parsed as Record<string, unknown>;
  if (!root.hooks || typeof root.hooks !== 'object' || Array.isArray(root.hooks)) {
    return false;
  }
  const hooks = root.hooks as Record<string, unknown>;
  let changed = false;

  for (const event of LEGACY_CURSOR_ONLY_HOOK_EVENTS) {
    const list = hooks[event];
    if (!Array.isArray(list)) continue;
    const kept = list.filter((entry) => {
      if (!entry || typeof entry !== 'object') return true;
      const command = (entry as { command?: unknown }).command;
      if (typeof command !== 'string') return true;
      return !isOtelHookCommand(command, wrapperPath);
    });
    if (kept.length === list.length) continue;
    changed = true;
    if (kept.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = kept;
    }
  }

  if (!changed) return false;
  fs.writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
  return true;
}

function rewriteKnownHookRegistrations(wrapperPath: string): void {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.cursor', 'hooks.json'),
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.codex', 'hooks.json'),
  ];
  for (const filePath of candidates) {
    try {
      rewriteHookCommandsToWrapper(filePath, wrapperPath);
      if (filePath.endsWith(`${path.sep}.cursor${path.sep}hooks.json`)) {
        pruneLegacyCursorHookEvents(filePath, wrapperPath);
      }
    } catch {
      // best-effort
    }
  }
}

function providerLabel(id: OtelHooksProviderId): OtelHooksAgent {
  if (id === 'claude-code') return 'claude';
  if (id === 'cursor') return 'cursor';
  return 'codex';
}

/**
 * Install @osfactory/otel-hook (if needed), write HAR config, register Cursor/Claude/Codex.
 * Replaces the legacy Python opentelemetry-hooks install path.
 */
export function ensureOtelHooks(options?: {
  setupAgents?: boolean;
  resourceAttributes?: string;
}): EnsureOtelHooksResult {
  const hooksHome = getOtelHooksHome();
  const errors: string[] = [];
  const providersSetup: OtelHooksProviderId[] = [];

  fs.mkdirSync(hooksHome, { recursive: true });

  let otelHookCommand = resolveOtelHookCommand(hooksHome);
  const packageSpec = otelHooksPackageSpec();
  const needsInstall = !otelHookCommand || needsPackageInstall(hooksHome, packageSpec);
  if (needsInstall) {
    // Prefer a prefix-local install so HAR pins the version under ~/.har/otel-hooks.
    const installed = tryInstallPackage(hooksHome, packageSpec);
    if (!installed.ok) {
      errors.push(installed.detail);
      const { configPath, decision } = applyAgentTelemetryRoute(hooksHome, options?.resourceAttributes);
      return {
        ok: false,
        hooksHome,
        configPath,
        wrapperPath: getOtelHooksWrapperPath(hooksHome),
        otelHookCommand: null,
        warning: installed.detail,
        agentsSetup: [],
        providersSetup,
        errors,
        route: decision.route,
        routeHint: decision.hint,
      };
    }
    otelHookCommand = resolveOtelHookCommand(hooksHome);
    if (!otelHookCommand) {
      errors.push('@osfactory/otel-hook installed but otel-hook binary is missing');
      const { configPath, decision } = applyAgentTelemetryRoute(hooksHome, options?.resourceAttributes);
      return {
        ok: false,
        hooksHome,
        configPath,
        wrapperPath: getOtelHooksWrapperPath(hooksHome),
        otelHookCommand: null,
        warning: errors[errors.length - 1],
        agentsSetup: [],
        providersSetup,
        errors,
        route: decision.route,
        routeHint: decision.hint,
      };
    }
  }

  const resolvedCommand = otelHookCommand;
  if (!resolvedCommand) {
    errors.push('@osfactory/otel-hook binary is missing');
    const { configPath, decision } = applyAgentTelemetryRoute(hooksHome, options?.resourceAttributes);
    return {
      ok: false,
      hooksHome,
      configPath,
      wrapperPath: getOtelHooksWrapperPath(hooksHome),
      otelHookCommand: null,
      warning: errors[errors.length - 1],
      agentsSetup: [],
      providersSetup,
      errors,
      route: decision.route,
      routeHint: decision.hint,
    };
  }

  const { configPath, decision } = applyAgentTelemetryRoute(hooksHome, options?.resourceAttributes);
  const wrapperPath = writeOtelHooksWrapper(resolvedCommand, hooksHome);
  // Remove the old Python tool only after the npm replacement and wrapper are
  // ready. If npm installation fails, an existing HAR hook remains usable.
  uninstallLegacyPythonHooks(hooksHome);

  const signals = getTelemetrySignals();
  if (options?.setupAgents !== false && isTelemetryEnabled()) {
    // Hooks export from Usage up: they are the only source of agent usage.
    if (signals.traces) {
      for (const provider of OTEL_HOOKS_PROVIDERS) {
        const setup = runSetupProvider(provider.id, resolvedCommand, wrapperPath);
        if (setup.ok) providersSetup.push(provider.id);
        else errors.push(setup.detail);
      }
    }
    rewriteKnownHookRegistrations(wrapperPath);
  }
  if (options?.setupAgents !== false) {
    // Claude Code usage comes from otel-hook only: drop the native telemetry
    // keys an earlier HAR wrote into the Claude settings.
    removeOldClaudeNativeTelemetry(hooksHome);
  }

  const agentsSetup = providersSetup.map(providerLabel);
  const ok = errors.length === 0;
  return {
    ok,
    hooksHome,
    configPath,
    wrapperPath,
    otelHookCommand: resolvedCommand,
    message: ok
      ? `@osfactory/otel-hook ready (${agentsSetup.join(', ') || 'config only'}) → ${configPath}`
      : undefined,
    warning: errors.length ? errors.join('; ') : undefined,
    agentsSetup,
    providersSetup,
    errors,
    route: decision.route,
    routeHint: decision.hint,
  };
}

/** Best-effort: a malformed Claude settings file must never block telemetry. */
function removeOldClaudeNativeTelemetry(hooksHome: string): void {
  try {
    removeClaudeNativeTelemetry({ hooksHome });
  } catch {
    // best-effort
  }
}

/**
 * Resolve where agent traces go and write what the hook reads for it: the
 * config file, and `direct.env` (0600) with the destinations' header values.
 */
export function applyAgentTelemetryRoute(
  hooksHome = getOtelHooksHome(),
  resourceAttributes?: string,
): { configPath: string; decision: AgentTelemetryRouteDecision } {
  const decision = resolveAgentTelemetryRoute(hooksHome);
  const features = detectOtelHookFeatures(hooksHome);
  const configPath = writeOtelHooksConfig(
    buildOtelHooksConfig({
      resourceAttributes,
      route: decision.route,
      legacySingleEndpoint: features !== null && !features.destinations,
      ...(features ? { features } : {}),
    }),
    hooksHome,
  );
  writeRouteEnv(decision.route, hooksHome);
  return { configPath, decision };
}

/**
 * Re-route agent traces after something they depend on changed (a destination
 * added or removed, Mission Control started or stopped), without installing or
 * registering anything. A no-op until `har telemetry on` installed the hook.
 * Fail-open: returns undefined on any error.
 */
export function refreshAgentTelemetryRoute(): AgentTelemetryRouteDecision | undefined {
  try {
    const hooksHome = getOtelHooksHome();
    const command = resolveOtelHookCommand(hooksHome);
    if (!command) {
      writeRouteEnv({ mode: 'off' }, hooksHome);
      return undefined;
    }
    if (!isTelemetryEnabled()) {
      writeRouteEnv({ mode: 'off' }, hooksHome);
      return { route: { mode: 'off' } };
    }
    const { decision } = applyAgentTelemetryRoute(hooksHome);
    // Wrappers written before 2.0 do not source direct.env.
    writeOtelHooksWrapper(command, hooksHome);
    removeOldClaudeNativeTelemetry(hooksHome);
    return decision;
  } catch {
    return undefined;
  }
}

/** Refresh config for telemetry off (exporter disabled) without uninstalling hooks. */
export function disableOtelHooksExport(): string {
  try {
    writeRouteEnv({ mode: 'off' }, getOtelHooksHome());
  } catch {
    // best-effort
  }
  removeOldClaudeNativeTelemetry(getOtelHooksHome());
  return writeOtelHooksConfig(buildOtelHooksConfig({ enabled: false }));
}

export interface TelemetryDrift {
  level: TelemetryLevel;
  configPath: string;
  /** Each way the hook config on disk records more or less than the level asks for. */
  mismatches: string[];
}

/**
 * Compare the hook config agents actually read with what the effective level
 * asks for. A preference changed by hand, or a level chosen before this
 * version, leaves the file behind — agents then record less (or more) than
 * `har telemetry status` claims.
 */
export function inspectTelemetryDrift(
  hooksHome = getOtelHooksHome(),
  /** Whose agent hook registrations to check; null skips them (default: the user's, for the default hooks home only). */
  agentHome: string | null = path.resolve(hooksHome) === path.join(os.homedir(), '.har', 'otel-hooks') ? os.homedir() : null,
): TelemetryDrift {
  const level = getTelemetryLevel();
  const configPath = getOtelHooksConfigPath(hooksHome);
  const applied = readAppliedAgentRoute(hooksHome);
  const expected = buildOtelHooksConfig();
  // A route with nowhere to send exports nothing; event records only go out
  // when an entry of the route takes them.
  if (applied && appliedRouteNames(applied).length === 0) {
    expected.exporter.enabled = false;
  }
  if (applied && (!applied.logs || !expected.exporter.enabled)) {
    expected.exporter.logs.enabled = false;
    expected.exporter.logs.includeContent = false;
    expected.privacy.contentMode = 'omit';
  }
  const mismatches: string[] = [];
  let actual: Partial<OtelHooksConfig> | null = null;
  try {
    actual = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<OtelHooksConfig>;
  } catch {
    actual = null;
  }
  if (!actual) {
    if (expected.exporter.enabled) mismatches.push('no hook config written yet');
    return { level, configPath, mismatches };
  }
  const check = (label: string, want: unknown, got: unknown) => {
    if (want !== got) mismatches.push(`${label}: ${String(got)} (level ${level} needs ${String(want)})`);
  };
  check('spans export', expected.exporter.enabled, actual.exporter?.enabled ?? false);
  check('event records export', expected.exporter.logs.enabled, actual.exporter?.logs?.enabled ?? false);
  check('text capture', expected.exporter.logs.includeContent, actual.exporter?.logs?.includeContent ?? false);
  check('content mode', expected.privacy.contentMode, actual.privacy?.contentMode ?? 'omit');
  if (expected.exporter.enabled && agentHome !== null) mismatches.push(...inspectHookCommandFlags(agentHome));
  return { level, configPath, mismatches };
}
