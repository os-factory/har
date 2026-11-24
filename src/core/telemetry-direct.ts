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
 * - `direct`: Mission Control is disabled or not set up and exactly one enabled
 *   destination subscribes to traces, so the hook exports to it itself. Nothing
 *   strips the Resource on that path, so HAR leaves `factory.local.*` out
 *   (unless the destination sets `includeLocalPaths`), sends logs only when the
 *   destination subscribes to them, and leaves Claude Code's native telemetry
 *   (metrics and logs carrying account identity) off.
 * - `off`: telemetry is off.
 *
 * Secrets never reach a command line or a world-readable file: the endpoint and
 * headers are written to `direct.env` (mode 0600) in the hooks home, which the
 * hook wrapper sources at run time. The wrapper itself holds no secret.
 */
export type AgentTelemetryRoute =
  | { mode: 'off' }
  | { mode: 'control' }
  | { mode: 'direct'; destination: TelemetryDestination };

export interface AgentTelemetryRouteDecision {
  route: AgentTelemetryRoute;
  /** One line explaining why direct mode was not used although it might be expected. */
  hint?: string;
}

/** First otel-hook release that reads `OTEL_EXPORTER_OTLP_*_HEADERS` and the standard endpoint variables. */
export const OTEL_HOOK_DIRECT_MIN_VERSION = '0.7.0';

/** File in the hooks home holding the direct-export environment (mode 0600). */
export const DIRECT_ENV_FILE = 'direct.env';

/** Set in `direct.env` when the wrapper must drop `factory.local.*` from `OTEL_RESOURCE_ATTRIBUTES`. */
export const DIRECT_STRIP_LOCAL_ENV = 'HAR_OTEL_DIRECT_STRIP_LOCAL';

const METADATA_PREFIX = '# har-direct:';

export interface AgentTelemetryRouteInput {
  telemetryEnabled: boolean;
  /** Mission Control is enabled (`HAR_CONTROL_DISABLED` unset) and set up (a container, or a custom URL). */
  controlAvailable: boolean;
  destinations: readonly TelemetryDestination[];
  /** The installed otel-hook reads the standard OTLP endpoint and header variables. */
  otelHookSupportsDirect: boolean;
}

/** Pure mode selection — see `AgentTelemetryRoute`. */
export function selectAgentTelemetryRoute(input: AgentTelemetryRouteInput): AgentTelemetryRouteDecision {
  if (!input.telemetryEnabled) return { route: { mode: 'off' } };
  if (input.controlAvailable) return { route: { mode: 'control' } };
  const traces = destinationsForSignal({ version: 1, destinations: [...input.destinations] }, 'traces');
  if (traces.length === 0) return { route: { mode: 'control' } };
  if (traces.length > 1) {
    return {
      route: { mode: 'control' },
      hint:
        `Agent traces are not sent directly: direct mode (without Mission Control) supports a single destination, and ${traces.length} subscribe to traces. ` +
        'Run Mission Control (har control up) to fan out to several.',
    };
  }
  if (!input.otelHookSupportsDirect) {
    return {
      route: { mode: 'control' },
      hint:
        `Agent traces are not sent directly to "${traces[0].name}": that needs @osfactory/otel-hook ${OTEL_HOOK_DIRECT_MIN_VERSION} or later. ` +
        'Run har telemetry on after upgrading HAR, or run Mission Control (har control up).',
    };
  }
  return { route: { mode: 'direct', destination: traces[0] } };
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
 * Whether the otel-hook installed in the hooks home reads the standard OTLP
 * endpoint and header variables: its version is at least
 * `OTEL_HOOK_DIRECT_MIN_VERSION`, or (for an unreleased build installed through
 * `HAR_OTEL_HOOKS_PACKAGE`) its CLI bundle names `OTEL_EXPORTER_OTLP_TRACES_HEADERS`.
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
    return fs.readFileSync(path.join(pkgDir, bin), 'utf8').includes('OTEL_EXPORTER_OTLP_TRACES_HEADERS');
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
export function directRouteSendsLogs(destination: TelemetryDestination): boolean {
  return destination.signals.includes('logs');
}

/** One `OTEL_EXPORTER_OTLP_*_HEADERS` value: `key=value` pairs, percent-encoded (the space in `Basic x` is `%20`). */
export function encodeOtlpHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join(',');
}

function singleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Content of `direct.env` for one destination. */
export function buildDirectExportEnv(destination: TelemetryDestination): string {
  const logs = directRouteSendsLogs(destination);
  const stripLocal = !destinationIncludesLocalPaths(destination);
  const headers = encodeOtlpHeaders(destination.headers);
  const lines = [
    '# Managed by har telemetry: agent hook traces go directly to one destination',
    '# because Mission Control is off. Holds secrets: keep it mode 0600.',
    `${METADATA_PREFIX} destination=${destination.name} logs=${logs} include-local-paths=${!stripLocal}`,
    // otel-hook's own endpoint variables outrank the standard ones.
    'unset OTEL_HOOK_EXPORTER_ENDPOINT OTEL_HOOK_LOGS_ENDPOINT',
    `export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${singleQuote(otlpSignalUrl(destination.endpoint, 'traces'))}`,
    ...(headers ? [`export OTEL_EXPORTER_OTLP_TRACES_HEADERS=${singleQuote(headers)}`] : []),
    `export OTEL_HOOK_LOGS_ENABLED=${logs ? 'true' : 'false'}`,
    ...(logs
      ? [
          `export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=${singleQuote(otlpSignalUrl(destination.endpoint, 'logs'))}`,
          ...(headers ? [`export OTEL_EXPORTER_OTLP_LOGS_HEADERS=${singleQuote(headers)}`] : []),
        ]
      : []),
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
  fs.writeFileSync(tmpPath, buildDirectExportEnv(route.destination), { mode: 0o600 });
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, filePath);
  return filePath;
}

export interface AppliedDirectRoute {
  destination: string;
  logs: boolean;
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
    destination: fields.destination,
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
  if (route.mode === 'direct') return `direct → ${route.destination.name}`;
  return 'via Mission Control';
}

