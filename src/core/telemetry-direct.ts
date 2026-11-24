import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  LOCAL_ATTR_PREFIX,
  destinationIncludesLocalPaths,
  destinationsForSignal,
  otlpSignalUrl,
  type TelemetryDestination,
} from '../harness/schema';
import { DEFAULT_CONTROL_API_URL, isControlEnabled } from './control-config';
import { controlContainerExists } from './control-lifecycle';
import { isTelemetryEnabled } from './telemetry-config';
import { readTelemetryDestinations } from './telemetry-destinations';

/**
 * Where agent hook traces go (`@osfactory/otel-hook`).
 *
 * - `control`: to Mission Control, which stores them and forwards a stripped
 *   copy to every destination (the default, unchanged behavior).
 * - `direct`: Mission Control is disabled or not set up and at least one enabled
 *   destination subscribes to traces, so the hook exports itself to every
 *   enabled destination that subscribes to traces or logs. Nothing strips the
 *   Resource on that path, so HAR leaves `factory.local.*` out unless every one
 *   of them sets `includeLocalPaths` (one hook process has one Resource), sends
 *   logs only to destinations that subscribe to them, and leaves Claude Code's
 *   native telemetry (metrics and logs carrying account identity) off.
 *
 *   The destinations go into the hook config as `exporter.destinations[]`
 *   (otel-hook >= 0.9.0), whose header values are `env:` references to
 *   variables in `direct.env`.
 * - `off`: telemetry is off.
 *
 * Secrets never reach a command line or a world-readable file: header values
 * are written to `direct.env` (mode 0600) in the hooks home, which the hook
 * wrapper sources at run time. The wrapper and the hook config hold no secret.
 */
export type AgentTelemetryRoute =
  | { mode: 'off' }
  | { mode: 'control' }
  /** `destinations` is never empty, in the destinations file's order. */
  | { mode: 'direct'; destinations: TelemetryDestination[] };

export interface AgentTelemetryRouteDecision {
  route: AgentTelemetryRoute;
  /** One line explaining why direct mode was not used although it might be expected. */
  hint?: string;
}

/** First otel-hook release with `exporter.destinations[]` and `env:` header values, which direct export needs. */
export const OTEL_HOOK_DIRECT_MIN_VERSION = '0.9.0';

/** File in the hooks home holding the direct-export environment (mode 0600). */
export const DIRECT_ENV_FILE = 'direct.env';

/** Set in `direct.env` when the wrapper must drop `factory.local.*` from `OTEL_RESOURCE_ATTRIBUTES`. */
export const DIRECT_STRIP_LOCAL_ENV = 'HAR_OTEL_DIRECT_STRIP_LOCAL';

/** Prefix of the `direct.env` variables that hold destination header values (`env:` references in the hook config). */
export const DIRECT_HEADER_ENV_PREFIX = 'HAR_OTEL_DIRECT_HEADER_';

/**
 * Copy of the agent's `OTEL_RESOURCE_ATTRIBUTES` under a name agents do not
 * filter (#484). Claude Code (>= 2.1.128) removes every `OTEL_*` variable from
 * the hooks it runs, so the hook wrapper restores the session profile from
 * this one when `OTEL_RESOURCE_ATTRIBUTES` arrives empty.
 */
export const HAR_RESOURCE_ATTRIBUTES_ENV = 'HAR_RESOURCE_ATTRIBUTES';

const METADATA_PREFIX = '# har-direct:';

export interface AgentTelemetryRouteInput {
  telemetryEnabled: boolean;
  /** Mission Control is enabled (`HAR_CONTROL_DISABLED` unset) and set up (a container, or a custom URL). */
  controlAvailable: boolean;
  destinations: readonly TelemetryDestination[];
  /** The installed otel-hook takes `exporter.destinations[]` with `env:` header values. */
  otelHookSupportsDirect: boolean;
}

/** Enabled destinations a direct route carries: those subscribed to traces or logs. */
export function directRouteDestinations(destinations: readonly TelemetryDestination[]): TelemetryDestination[] {
  return destinations.filter(
    (destination) =>
      destination.enabled && (destination.signals.includes('traces') || destination.signals.includes('logs')),
  );
}

/** Pure mode selection — see `AgentTelemetryRoute`. */
export function selectAgentTelemetryRoute(input: AgentTelemetryRouteInput): AgentTelemetryRouteDecision {
  if (!input.telemetryEnabled) return { route: { mode: 'off' } };
  if (input.controlAvailable) return { route: { mode: 'control' } };
  const traces = destinationsForSignal({ version: 1, destinations: [...input.destinations] }, 'traces');
  if (traces.length === 0) return { route: { mode: 'control' } };
  const destinations = directRouteDestinations(input.destinations);
  if (!input.otelHookSupportsDirect) {
    return {
      route: { mode: 'control' },
      hint:
        `Agent traces are not sent directly to ${formatDestinationNames(destinations)}: ` +
        `direct export needs @osfactory/otel-hook ${OTEL_HOOK_DIRECT_MIN_VERSION} or later. ` +
        'Run har telemetry on after upgrading HAR, or run Mission Control (har control up).',
    };
  }
  return { route: { mode: 'direct', destinations } };
}

/** `"a"`, `"a" and "b"`, `"a", "b" and "c"`. */
function formatDestinationNames(destinations: readonly TelemetryDestination[]): string {
  const quoted = destinations.map((destination) => `"${destination.name}"`);
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}` : quoted.join('');
}

/** Whether Mission Control is enabled and set up on this machine (or reachable at a custom URL). */
export function isControlAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isControlEnabled()) return false;
  const custom = env.HAR_CONTROL_API_URL?.trim();
  if (custom && custom.replace(/\/+$/, '') !== DEFAULT_CONTROL_API_URL) return true;
  try {
    return controlContainerExists();
  } catch {
    return false;
  }
}

function compareVersions(a: string, b: string): number {
  const parse = (value: string) => value.split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let index = 0; index < 3; index += 1) {
    if (x[index] !== y[index]) return x[index] - y[index];
  }
  return 0;
}

/**
 * Whether the otel-hook installed in the hooks home takes `exporter.destinations[]`
 * with `env:` header values: its version is at least `OTEL_HOOK_DIRECT_MIN_VERSION`,
 * or (for an unreleased build installed through `HAR_OTEL_HOOKS_PACKAGE`) its CLI
 * bundle has the `env:` reference support.
 */
export function otelHookSupportsDirectExport(hooksHome: string): boolean {
  const pkgDir = path.join(hooksHome, 'node_modules', '@osfactory', 'otel-hook');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as {
      version?: string;
      bin?: string | Record<string, string>;
    };
    if (typeof pkg.version === 'string' && compareVersions(pkg.version, OTEL_HOOK_DIRECT_MIN_VERSION) >= 0) {
      return true;
    }
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['otel-hook'];
    if (!bin) return false;
    return fs.readFileSync(path.join(pkgDir, bin), 'utf8').includes('HEADER_ENV_REFERENCE_PREFIX');
  } catch {
    return false;
  }
}

/** Resolve the route from this machine's preference, Mission Control and destinations. Never throws. */
export function resolveAgentTelemetryRoute(
  hooksHome: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentTelemetryRouteDecision {
  if (!isTelemetryEnabled()) return { route: { mode: 'off' } };
  if (isControlAvailable(env)) return { route: { mode: 'control' } };
  let destinations: TelemetryDestination[];
  try {
    destinations = readTelemetryDestinations(env).destinations;
  } catch {
    return { route: { mode: 'control' } };
  }
  return selectAgentTelemetryRoute({
    telemetryEnabled: true,
    controlAvailable: false,
    destinations,
    otelHookSupportsDirect: otelHookSupportsDirectExport(hooksHome),
  });
}

/** Whether the destination receives otel-hook's event records (logs). */
export function destinationReceivesLogs(destination: TelemetryDestination): boolean {
  return destination.signals.includes('logs');
}

/** Whether any destination of a direct route receives otel-hook's event records (logs). */
export function directRouteSendsLogs(destinations: readonly TelemetryDestination[]): boolean {
  return destinations.some(destinationReceivesLogs);
}

/**
 * Whether the hook must drop `factory.local.*`: one hook process exports one
 * Resource to every destination, so a single destination without
 * `includeLocalPaths` decides for all.
 */
export function directRouteStripsLocalPaths(destinations: readonly TelemetryDestination[]): boolean {
  return destinations.some((destination) => !destinationIncludesLocalPaths(destination));
}

/** One header of a direct destination: written as `env:<envVar>` in the hook config, its value only in `direct.env`. */
export interface DirectHeaderBinding {
  header: string;
  envVar: string;
  value: string;
}

/** One `exporter.destinations[]` entry of the hook config, with where each header value lives. */
export interface DirectDestinationPlan {
  /** The HAR destination name. */
  destination: string;
  /** otel-hook's name: lowercase letters, digits, `_` and `-`; `default` is reserved. */
  name: string;
  tracesEndpoint?: string;
  logsEndpoint?: string;
  signals: Array<'traces' | 'logs'>;
  headers: DirectHeaderBinding[];
}

/** otel-hook destination names are `[a-z0-9][a-z0-9_-]{0,62}` and also its spool directories. */
function otelHookDestinationName(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 56) || 'destination';
  let candidate = base;
  for (let suffix = 2; candidate === 'default' || taken.has(candidate); suffix += 1) {
    candidate = `${base}-${suffix}`;
  }
  taken.add(candidate);
  return candidate;
}

/**
 * The hook config's `exporter.destinations[]` for a direct route, and the
 * variables holding header values. Deterministic, so the config file and
 * `direct.env` written separately agree on every variable name.
 */
export function planDirectDestinations(destinations: readonly TelemetryDestination[]): DirectDestinationPlan[] {
  const taken = new Set<string>();
  return destinations.map((destination, index) => {
    const traces = destination.signals.includes('traces');
    const logs = destinationReceivesLogs(destination);
    const headers = Object.entries(destination.headers)
      // otel-hook refuses an empty header value; HAR sends none either.
      .filter(([, value]) => value.length > 0)
      .map(([header, value], headerIndex) => ({
        header,
        envVar: `${DIRECT_HEADER_ENV_PREFIX}${index + 1}_${headerIndex + 1}`,
        value,
      }));
    return {
      destination: destination.name,
      name: otelHookDestinationName(destination.name, taken),
      ...(traces ? { tracesEndpoint: otlpSignalUrl(destination.endpoint, 'traces') } : {}),
      ...(logs ? { logsEndpoint: otlpSignalUrl(destination.endpoint, 'logs') } : {}),
      signals: [...(traces ? (['traces'] as const) : []), ...(logs ? (['logs'] as const) : [])],
      headers,
    };
  });
}

function singleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Every variable that would give otel-hook a `default` destination next to the list. */
const DEFAULT_DESTINATION_ENV = [
  'OTEL_HOOK_EXPORTER_ENDPOINT',
  'OTEL_HOOK_LOGS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
];

/**
 * Content of `direct.env` for a direct route. The endpoints are in the hook
 * config's `exporter.destinations[]`; this file holds only the header values its
 * `env:` references name, raw (otel-hook sends them as they are).
 */
export function buildDirectExportEnv(destinations: readonly TelemetryDestination[]): string {
  const logs = directRouteSendsLogs(destinations);
  const stripLocal = directRouteStripsLocalPaths(destinations);
  const names = destinations.map((destination) => destination.name).join(',');
  const lines = [
    `# Managed by har telemetry: agent hook traces go directly to ${destinations.length === 1 ? 'one destination' : `${destinations.length} destinations`}`,
    '# because Mission Control is off. Holds secrets: keep it mode 0600.',
    `${METADATA_PREFIX} destination=${names} logs=${logs} include-local-paths=${!stripLocal}`,
    // Any of these would add a `default` destination next to the list.
    `unset ${DEFAULT_DESTINATION_ENV.join(' ')}`,
    ...planDirectDestinations(destinations).flatMap((plan) =>
      plan.headers.map((binding) => `export ${binding.envVar}=${singleQuote(binding.value)}`),
    ),
    `export OTEL_HOOK_LOGS_ENABLED=${logs ? 'true' : 'false'}`,
    ...(stripLocal ? [`export ${DIRECT_STRIP_LOCAL_ENV}=1`] : []),
  ];
  return `${lines.join('\n')}\n`;
}

export function getDirectExportEnvPath(hooksHome: string): string {
  return path.join(hooksHome, DIRECT_ENV_FILE);
}

/** Write `direct.env` (0600, atomic) for a direct route, or remove it otherwise. Returns the path when written. */
export function writeDirectExportEnv(route: AgentTelemetryRoute, hooksHome: string): string | null {
  const filePath = getDirectExportEnvPath(hooksHome);
  if (route.mode !== 'direct') {
    fs.rmSync(filePath, { force: true });
    return null;
  }
  fs.mkdirSync(hooksHome, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmpPath, buildDirectExportEnv(route.destinations), { mode: 0o600 });
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, filePath);
  return filePath;
}

export interface AppliedDirectRoute {
  /** Destination names, in route order. */
  destinations: string[];
  /** Any of them receives logs. */
  logs: boolean;
  /** Every one of them takes `factory.local.*`. */
  includeLocalPaths: boolean;
}

/** The direct route agents use now, read from the non-secret metadata line of `direct.env`. */
export function readAppliedDirectRoute(hooksHome: string): AppliedDirectRoute | null {
  let raw: string;
  try {
    raw = fs.readFileSync(getDirectExportEnvPath(hooksHome), 'utf8');
  } catch {
    return null;
  }
  const line = raw.split('\n').find((entry) => entry.startsWith(METADATA_PREFIX));
  if (!line) return null;
  const fields = Object.fromEntries(
    line
      .slice(METADATA_PREFIX.length)
      .trim()
      .split(/\s+/)
      .map((pair) => pair.split('=') as [string, string]),
  );
  if (!fields.destination) return null;
  return {
    destinations: fields.destination.split(',').filter(Boolean),
    logs: fields.logs === 'true',
    includeLocalPaths: fields['include-local-paths'] === 'true',
  };
}

/** Drop `factory.local.*` from an `OTEL_RESOURCE_ATTRIBUTES` value. */
export function stripLocalResourceAttributes(raw: string): string {
  return raw
    .split(',')
    .filter((part) => !part.trim().startsWith(LOCAL_ATTR_PREFIX))
    .join(',');
}

/** Human label for `har telemetry status` (never contains secrets). */
export function describeAgentTelemetryRoute(route: AgentTelemetryRoute): string {
  if (route.mode === 'off') return 'off';
  if (route.mode === 'direct') return `direct → ${route.destinations.map((destination) => destination.name).join(', ')}`;
  return 'via Mission Control';
}

