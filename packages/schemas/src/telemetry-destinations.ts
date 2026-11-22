import { z } from 'zod';

/**
 * Machine-level OTLP destinations: third-party backends (an OpenTelemetry
 * Collector, Langfuse, Datadog, …) that receive a copy of HAR's telemetry.
 *
 * Written by `har telemetry destination add` to
 * `~/.har/destinations/telemetry.json` (mode 0600 — header values are secrets)
 * and read by Mission Control, which forwards what its OTLP receivers accept.
 * No file, or no enabled destination, means nothing leaves the machine.
 */

export const OTLP_SIGNALS = ['traces', 'logs', 'metrics'] as const;
export type OtlpSignal = (typeof OTLP_SIGNALS)[number];

/** OTLP over HTTP only — Mission Control forwards the raw HTTP body it received. */
export const OTLP_DESTINATION_PROTOCOLS = ['http/protobuf', 'http/json'] as const;
export type OtlpDestinationProtocol = (typeof OTLP_DESTINATION_PROTOCOLS)[number];

export const TELEMETRY_DESTINATION_PRESETS = ['otlp', 'langfuse'] as const;
export type TelemetryDestinationPreset = (typeof TELEMETRY_DESTINATION_PRESETS)[number];

/** File name inside the destinations directory. */
export const TELEMETRY_DESTINATIONS_FILE = 'telemetry.json';

/** Environment variable naming the destinations directory (set inside the Mission Control container). */
export const HAR_DESTINATIONS_DIR_ENV = 'HAR_DESTINATIONS_DIR';

/**
 * Attribute keys whose values are absolute paths on the user's machine (repo
 * checkout, slot worktree, agent workspace, process cwd, source file). Mission
 * Control keeps them locally for attribution and strips them — at resource,
 * scope, span, span event/link, log record and metric data point (and exemplar)
 * level — from every copy forwarded to a destination unless that destination
 * sets `includeLocalPaths: true`.
 */
export const TELEMETRY_LOCAL_PATH_ATTRIBUTES = [
  // HAR session resource attributes (src/core/telemetry-env.ts).
  'har.repo_path',
  'har.work_dir',
  // Agent workspace attributes Mission Control reads for attribution.
  'gen_ai.client.workspace',
  'gen_ai.client.repository_root',
  'cwd',
  // OpenTelemetry semantic conventions that carry local paths.
  'process.cwd',
  'process.executable.path',
  'process.command',
  'process.command_line',
  'process.command_args',
  'code.filepath',
  'code.file.path',
] as const;

/** Whether a destination receives local path attributes (opt-in, default false). */
export function destinationIncludesLocalPaths(destination: Pick<TelemetryDestination, 'includeLocalPaths'>): boolean {
  return destination.includeLocalPaths === true;
}

export const telemetryDestinationNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'use letters, digits, ".", "_" or "-" (max 64)');

const endpointSchema = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'endpoint must be an http(s) URL')
  .refine((value) => {
    try {
      const url = new URL(value);
      return !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'put credentials in a header, not in the endpoint URL');

const headerNameSchema = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, 'invalid HTTP header name');

export const telemetryDestinationSchema = z.object({
  name: telemetryDestinationNameSchema,
  preset: z.enum(TELEMETRY_DESTINATION_PRESETS).optional(),
  /** Base OTLP/HTTP URL; each signal is sent to `<endpoint>/v1/<signal>`. */
  endpoint: endpointSchema,
  protocol: z.enum(OTLP_DESTINATION_PROTOCOLS).default('http/protobuf'),
  /** Header values are secrets: never print them unmasked. */
  headers: z.record(headerNameSchema, z.string().max(8192)).default({}),
  signals: z.array(z.enum(OTLP_SIGNALS)).min(1),
  enabled: z.boolean().default(true),
  /**
   * Forward attributes that hold absolute local paths
   * (`TELEMETRY_LOCAL_PATH_ATTRIBUTES`). Absent or false (the default): Mission
   * Control strips them before the copy is spooled or sent.
   */
  includeLocalPaths: z.boolean().optional(),
  createdAt: z.string().optional(),
});
export type TelemetryDestination = z.infer<typeof telemetryDestinationSchema>;

export const telemetryDestinationsFileSchema = z.object({
  version: z.literal(1),
  destinations: z.array(telemetryDestinationSchema).default([]),
});
export type TelemetryDestinationsFile = z.infer<typeof telemetryDestinationsFileSchema>;

export function emptyTelemetryDestinationsFile(): TelemetryDestinationsFile {
  return { version: 1, destinations: [] };
}

/** `<endpoint>/v1/<signal>` — the OTLP/HTTP per-signal path. */
export function otlpSignalUrl(endpoint: string, signal: OtlpSignal): string {
  return `${endpoint.replace(/\/+$/, '')}/v1/${signal}`;
}

/** Enabled destinations subscribed to a signal. */
export function destinationsForSignal(
  file: TelemetryDestinationsFile,
  signal: OtlpSignal,
): TelemetryDestination[] {
  return file.destinations.filter((destination) => destination.enabled && destination.signals.includes(signal));
}

/** Mask a header value for display: keeps a short prefix scheme like `Basic`, never the secret. */
export function maskHeaderValue(value: string): string {
  const scheme = /^(Basic|Bearer|Token|ApiKey|Api-Key)\s+/i.exec(value);
  return scheme ? `${scheme[1]} ****` : '****';
}
