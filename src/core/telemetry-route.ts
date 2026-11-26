import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  LOCAL_ATTR_PREFIX,
  destinationIncludesLocalPaths,
  otlpSignalUrl,
  type HarDestination,
  type OtlpSignal,
  type TelemetryDestination,
} from '../harness/schema';
import { DEFAULT_CONTROL_API_URL, getControlApiUrl, isControlEnabled } from './control-config';
import { controlContainerExists } from './control-lifecycle';
import { isTelemetryEnabled } from './telemetry-config';
import { missionControlDestination, readTelemetryDestinations } from './telemetry-destinations';

/**
 * Where agent hook telemetry goes (`@osfactory/otel-hook`): fan-out at the producer.
 *
 * The hook gets one destination list (`exporter.destinations[]`) built from
 * HAR's destination list (ADR 0005 section 6) and sends every batch to each
 * entry itself, with one retry spool per entry. Mission Control is one entry
 * among them, never a relay: it stores what it receives and forwards nothing.
 *
 * - `mission-control`, when its entry is enabled and Mission Control is set up
 *   (a container, or a custom `HAR_CONTROL_API_URL`): `<MC>/api/otel/v1/<signal>`
 *   for each signal of its entry, no headers;
 * - every other enabled destination with OTLP signals, each with only the
 *   signals it subscribes to. Header values are `env:` references to variables
 *   in `direct.env` (mode 0600), never in the hook config.
 *
 * One hook process has one Resource, and work identity is stamped from the
 * session context, not the Resource (ADR 0004 section 3). `factory.local.*` is
 * left out unless every entry, Mission Control included, sets `includeLocalPaths`.
 *
 * Claude Code's native telemetry (metrics and logs carrying account identity)
 * is not part of this list: it goes to Mission Control only, and stays off
 * without it.
 */
export type AgentTelemetryRoute =
  | { mode: 'off' }
  | {
      mode: 'fanout';
      /** Mission Control base URL (no trailing slash) when it is in the list. */
      missionControl?: string;
      /** Signals of the Mission Control entry (default traces and logs). */
      missionControlSignals?: OtlpSignal[];
      /** The Mission Control entry opted in to local paths. */
      missionControlIncludesLocalPaths?: boolean;
      /** The Mission Control entry turned `session.id` off on metric points. */
      missionControlIncludesSessionId?: boolean;
      /** Enabled user destinations subscribed to traces or logs, in the destinations file's order. */
      destinations: TelemetryDestination[];
    };

export type FanoutAgentTelemetryRoute = Extract<AgentTelemetryRoute, { mode: 'fanout' }>;

export interface AgentTelemetryRouteDecision {
  route: AgentTelemetryRoute;
  /** One line explaining why the route is narrower than might be expected. */
  hint?: string;
}

/** The hook config's name for Mission Control's entry. */
export const MISSION_CONTROL_DESTINATION = 'mission-control';

/** First otel-hook release with `exporter.destinations[]` and `env:` header values. */
export const OTEL_HOOK_DESTINATIONS_MIN_VERSION = '0.9.0';

/**
 * File in the hooks home holding the route's environment (mode 0600): the
 * header values of the destinations, and the switches the wrapper reads. The
 * name dates from the direct-only route of 2.0.0-next; wrappers source it.
 */
export const ROUTE_ENV_FILE = 'direct.env';

/** Set in `direct.env` when the wrapper must drop `factory.local.*` from `OTEL_RESOURCE_ATTRIBUTES`. */
export const ROUTE_STRIP_LOCAL_ENV = 'HAR_OTEL_DIRECT_STRIP_LOCAL';

/** Prefix of the `direct.env` variables that hold destination header values (`env:` references in the hook config). */
export const ROUTE_HEADER_ENV_PREFIX = 'HAR_OTEL_DIRECT_HEADER_';

/**
 * Copy of the agent's `OTEL_RESOURCE_ATTRIBUTES` under a name agents do not
 * filter (#484). Claude Code (>= 2.1.128) removes every `OTEL_*` variable from
 * the hooks it runs, so the hook wrapper restores the session profile from
 * this one when `OTEL_RESOURCE_ATTRIBUTES` arrives empty.
 */
export const HAR_RESOURCE_ATTRIBUTES_ENV = 'HAR_RESOURCE_ATTRIBUTES';

const METADATA_PREFIX = '# har-route:';
/** Metadata line of a `direct.env` written by 2.0.0-next.3 or earlier (no Mission Control in the list). */
const LEGACY_METADATA_PREFIX = '# har-direct:';

export interface AgentTelemetryRouteInput {
  telemetryEnabled: boolean;
  /** Mission Control is enabled (`HAR_CONTROL_DISABLED` unset) and set up (a container, or a custom URL). */
  controlAvailable: boolean;
  /** Mission Control base URL, used when it is available. */
  controlApiUrl?: string;
  /** Mission Control's entry in the destination list; absent → traces and logs, defaults. */
  missionControlEntry?: Pick<HarDestination, 'signals' | 'includeLocalPaths' | 'includeSessionId'>;
  destinations: readonly TelemetryDestination[];
  /** The installed otel-hook takes `exporter.destinations[]` with `env:` header values. */
  otelHookSupportsDestinations: boolean;
}

/** Enabled destinations the hook sends to: those with any OTLP signal. */
export function agentRouteDestinations(destinations: readonly TelemetryDestination[]): TelemetryDestination[] {
  return destinations.filter((destination) => destination.enabled && destination.signals.length > 0);
}

/** Pure route selection — see `AgentTelemetryRoute`. */
export function selectAgentTelemetryRoute(input: AgentTelemetryRouteInput): AgentTelemetryRouteDecision {
  if (!input.telemetryEnabled) return { route: { mode: 'off' } };
  const missionControl = input.controlAvailable
    ? (input.controlApiUrl ?? DEFAULT_CONTROL_API_URL).replace(/\/+$/, '')
    : undefined;
  const entry = input.missionControlEntry;
  const mc = missionControl
    ? {
        missionControl,
        ...(entry ? { missionControlSignals: [...entry.signals] } : {}),
        ...(entry?.includeLocalPaths ? { missionControlIncludesLocalPaths: true } : {}),
        ...(entry?.includeSessionId === false ? { missionControlIncludesSessionId: false } : {}),
      }
    : {};
  const destinations = agentRouteDestinations(input.destinations);
  if (destinations.length > 0 && !input.otelHookSupportsDestinations) {
    return {
      route: { mode: 'fanout', ...mc, destinations: [] },
      hint:
        `Agent traces are not sent to ${formatDestinationNames(destinations)}: ` +
        `that needs @osfactory/otel-hook ${OTEL_HOOK_DESTINATIONS_MIN_VERSION} or later. ` +
        'Run har telemetry on after upgrading HAR.',
    };
  }
  return { route: { mode: 'fanout', ...mc, destinations } };
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
 * with `env:` header values: its version is at least `OTEL_HOOK_DESTINATIONS_MIN_VERSION`,
 * or (for an unreleased build installed through `HAR_OTEL_HOOKS_PACKAGE`) its CLI
 * bundle has the `env:` reference support.
 */
export function otelHookSupportsDestinations(hooksHome: string): boolean {
  const pkgDir = path.join(hooksHome, 'node_modules', '@osfactory', 'otel-hook');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as {
      version?: string;
      bin?: string | Record<string, string>;
    };
    if (typeof pkg.version === 'string' && compareVersions(pkg.version, OTEL_HOOK_DESTINATIONS_MIN_VERSION) >= 0) {
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
  let destinations: TelemetryDestination[] = [];
  try {
    destinations = readTelemetryDestinations(env).destinations;
  } catch {
    destinations = [];
  }
  let entry: HarDestination | undefined;
  try {
    entry = missionControlDestination(env);
  } catch {
    entry = undefined;
  }
  return selectAgentTelemetryRoute({
    telemetryEnabled: true,
    controlAvailable: entry !== undefined && entry.signals.length > 0 && isControlAvailable(env),
    controlApiUrl: getControlApiUrl(),
    ...(entry ? { missionControlEntry: entry } : {}),
    destinations,
    otelHookSupportsDestinations: otelHookSupportsDestinations(hooksHome),
  });
}

/** Whether the destination receives otel-hook's event records (logs). */
export function destinationReceivesLogs(destination: TelemetryDestination): boolean {
  return destination.signals.includes('logs');
}

/** Signals of the route's Mission Control entry (none when it is not in the route). */
export function missionControlRouteSignals(route: AgentTelemetryRoute): OtlpSignal[] {
  if (route.mode === 'off' || route.missionControl === undefined) return [];
  return route.missionControlSignals ?? ['traces', 'logs'];
}

/** Whether any entry of the route takes otel-hook's event records (logs), before the level is applied. */
export function routeSendsLogs(route: AgentTelemetryRoute): boolean {
  if (route.mode === 'off') return false;
  return missionControlRouteSignals(route).includes('logs') || route.destinations.some(destinationReceivesLogs);
}

/** Whether any entry of the route takes otel-hook's metrics, before the level is applied. */
export function routeSendsMetrics(route: AgentTelemetryRoute): boolean {
  if (route.mode === 'off') return false;
  return (
    missionControlRouteSignals(route).includes('metrics') ||
    route.destinations.some((destination) => destination.signals.includes('metrics'))
  );
}

/**
 * `exporter.metrics.includeSessionId` for the hook: otel-hook has one setting
 * for every destination, so one metrics destination that turns it off decides
 * for all.
 */
export function routeMetricsIncludeSessionId(route: AgentTelemetryRoute): boolean {
  if (route.mode === 'off') return true;
  if (missionControlRouteSignals(route).includes('metrics') && route.missionControlIncludesSessionId === false) {
    return false;
  }
  return !route.destinations.some(
    (destination) => destination.signals.includes('metrics') && destination.includeSessionId === false,
  );
}

/**
 * Whether the hook must drop `factory.local.*`. Attribution no longer needs
 * them (work identity is stamped from the session context), so they are
 * stripped unless every entry of the route, Mission Control included, opts in
 * with `includeLocalPaths`: one hook process has one Resource.
 */
export function routeStripsLocalPaths(route: AgentTelemetryRoute): boolean {
  if (route.mode === 'off') return false;
  if (route.missionControl !== undefined && route.missionControlIncludesLocalPaths !== true) return true;
  return route.destinations.some((destination) => !destinationIncludesLocalPaths(destination));
}

/** One header of a destination: written as `env:<envVar>` in the hook config, its value only in `direct.env`. */
export interface RouteHeaderBinding {
  header: string;
  envVar: string;
  value: string;
}

/** One `exporter.destinations[]` entry of the hook config, with where each header value lives. */
export interface RouteDestinationPlan {
  /** The HAR destination name, or `mission-control`. */
  destination: string;
  /** Mission Control's entry: no headers, logs per level. */
  missionControl: boolean;
  /** otel-hook's name: lowercase letters, digits, `_` and `-`; `default` is reserved. */
  name: string;
  tracesEndpoint?: string;
  logsEndpoint?: string;
  metricsEndpoint?: string;
  signals: OtlpSignal[];
  headers: RouteHeaderBinding[];
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
 * The hook config's `exporter.destinations[]` for a route — Mission Control
 * first, then the user destinations — and the variables holding header values.
 * Deterministic, so the config file and `direct.env` written separately agree
 * on every variable name.
 */
export function planRouteDestinations(route: AgentTelemetryRoute): RouteDestinationPlan[] {
  if (route.mode === 'off') return [];
  const taken = new Set<string>();
  const plans: RouteDestinationPlan[] = [];
  if (route.missionControl !== undefined) {
    const signals = OTLP_SIGNAL_ORDER.filter((signal) => missionControlRouteSignals(route).includes(signal));
    plans.push({
      destination: MISSION_CONTROL_DESTINATION,
      missionControl: true,
      name: otelHookDestinationName(MISSION_CONTROL_DESTINATION, taken),
      ...(signals.includes('traces') ? { tracesEndpoint: `${route.missionControl}/api/otel/v1/traces` } : {}),
      ...(signals.includes('logs') ? { logsEndpoint: `${route.missionControl}/api/otel/v1/logs` } : {}),
      ...(signals.includes('metrics') ? { metricsEndpoint: `${route.missionControl}/api/otel/v1/metrics` } : {}),
      signals,
      headers: [],
    });
  }
  route.destinations.forEach((destination, index) => {
    const traces = destination.signals.includes('traces');
    const logs = destinationReceivesLogs(destination);
    const metrics = destination.signals.includes('metrics');
    const headers = Object.entries(destination.headers)
      // otel-hook refuses an empty header value; HAR sends none either.
      .filter(([, value]) => value.length > 0)
      .map(([header, value], headerIndex) => ({
        header,
        envVar: `${ROUTE_HEADER_ENV_PREFIX}${index + 1}_${headerIndex + 1}`,
        value,
      }));
    plans.push({
      destination: destination.name,
      missionControl: false,
      name: otelHookDestinationName(destination.name, taken),
      ...(traces ? { tracesEndpoint: otlpSignalUrl(destination.endpoint, 'traces') } : {}),
      ...(logs ? { logsEndpoint: otlpSignalUrl(destination.endpoint, 'logs') } : {}),
      ...(metrics ? { metricsEndpoint: otlpSignalUrl(destination.endpoint, 'metrics') } : {}),
      signals: [
        ...(traces ? (['traces'] as const) : []),
        ...(logs ? (['logs'] as const) : []),
        ...(metrics ? (['metrics'] as const) : []),
      ],
      headers,
    });
  });
  return plans;
}

const OTLP_SIGNAL_ORDER: readonly OtlpSignal[] = ['traces', 'logs', 'metrics'];

/** Names of the route's entries, Mission Control first. */
export function routeDestinationNames(route: AgentTelemetryRoute): string[] {
  if (route.mode === 'off') return [];
  return [
    ...(route.missionControl !== undefined ? [MISSION_CONTROL_DESTINATION] : []),
    ...route.destinations.map((destination) => destination.name),
  ];
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
 * Content of `direct.env` for a route. The endpoints are in the hook config's
 * `exporter.destinations[]`; this file holds only the header values its `env:`
 * references name, raw (otel-hook sends them as they are), and the switches.
 */
export function buildRouteEnv(route: FanoutAgentTelemetryRoute): string {
  const logs = routeSendsLogs(route);
  const stripLocal = routeStripsLocalPaths(route);
  const names = routeDestinationNames(route);
  const lines = [
    `# Managed by har telemetry: agent hook traces go to ${names.length === 1 ? 'one destination' : `${names.length} destinations`},`,
    '# each sent to by otel-hook itself. Holds secrets: keep it mode 0600.',
    `${METADATA_PREFIX} mission-control=${route.missionControl !== undefined} destinations=${route.destinations
      .map((destination) => destination.name)
      .join(',')} logs=${logs} include-local-paths=${!stripLocal}`,
    // Any of these would add a `default` destination next to the list.
    `unset ${DEFAULT_DESTINATION_ENV.join(' ')}`,
    ...planRouteDestinations(route).flatMap((plan) =>
      plan.headers.map((binding) => `export ${binding.envVar}=${singleQuote(binding.value)}`),
    ),
    `export OTEL_HOOK_LOGS_ENABLED=${logs ? 'true' : 'false'}`,
    ...(stripLocal ? [`export ${ROUTE_STRIP_LOCAL_ENV}=1`] : []),
  ];
  return `${lines.join('\n')}\n`;
}

export function getRouteEnvPath(hooksHome: string): string {
  return path.join(hooksHome, ROUTE_ENV_FILE);
}

/** Write `direct.env` (0600, atomic) for a route, or remove it when telemetry is off. Returns the path when written. */
export function writeRouteEnv(route: AgentTelemetryRoute, hooksHome: string): string | null {
  const filePath = getRouteEnvPath(hooksHome);
  if (route.mode !== 'fanout') {
    fs.rmSync(filePath, { force: true });
    return null;
  }
  fs.mkdirSync(hooksHome, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmpPath, buildRouteEnv(route), { mode: 0o600 });
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, filePath);
  return filePath;
}

export interface AppliedAgentRoute {
  /** Mission Control is in the list. */
  missionControl: boolean;
  /** User destination names, in route order. */
  destinations: string[];
  /** Any entry receives logs. */
  logs: boolean;
  /** The Resource keeps `factory.local.*`. */
  includeLocalPaths: boolean;
}

function parseMetadata(line: string, prefix: string): Record<string, string> {
  return Object.fromEntries(
    line
      .slice(prefix.length)
      .trim()
      .split(/\s+/)
      .map((pair) => {
        const eq = pair.indexOf('=');
        return eq < 0 ? [pair, ''] : [pair.slice(0, eq), pair.slice(eq + 1)];
      }),
  );
}

/** The route agents use now, read from the non-secret metadata line of `direct.env`. */
export function readAppliedAgentRoute(hooksHome: string): AppliedAgentRoute | null {
  let raw: string;
  try {
    raw = fs.readFileSync(getRouteEnvPath(hooksHome), 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n');
  const current = lines.find((entry) => entry.startsWith(METADATA_PREFIX));
  if (current) {
    const fields = parseMetadata(current, METADATA_PREFIX);
    return {
      missionControl: fields['mission-control'] === 'true',
      destinations: (fields.destinations ?? '').split(',').filter(Boolean),
      logs: fields.logs === 'true',
      includeLocalPaths: fields['include-local-paths'] === 'true',
    };
  }
  const legacy = lines.find((entry) => entry.startsWith(LEGACY_METADATA_PREFIX));
  if (!legacy) return null;
  const fields = parseMetadata(legacy, LEGACY_METADATA_PREFIX);
  if (!fields.destination) return null;
  return {
    missionControl: false,
    destinations: fields.destination.split(',').filter(Boolean),
    logs: fields.logs === 'true',
    includeLocalPaths: fields['include-local-paths'] === 'true',
  };
}

/** Names of an applied route's entries, Mission Control first. */
export function appliedRouteNames(applied: AppliedAgentRoute | null): string[] {
  if (!applied) return [];
  return [...(applied.missionControl ? [MISSION_CONTROL_DESTINATION] : []), ...applied.destinations];
}

/** Drop `factory.local.*` from an `OTEL_RESOURCE_ATTRIBUTES` value. */
export function stripLocalResourceAttributes(raw: string): string {
  return raw
    .split(',')
    .filter((part) => !part.trim().startsWith(LOCAL_ATTR_PREFIX))
    .join(',');
}

/** Human label for status output (never contains secrets): `→ mission-control, langfuse`. */
export function describeAgentTelemetryRoute(route: AgentTelemetryRoute): string {
  if (route.mode === 'off') return 'off';
  const names = routeDestinationNames(route);
  return names.length > 0 ? `→ ${names.join(', ')}` : 'nowhere (start Mission Control or add a destination)';
}
