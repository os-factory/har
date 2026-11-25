import { z } from 'zod';
import { LOCAL_ATTR_PREFIX } from './session-attribution';

/**
 * Machine-level OTLP destinations: third-party backends (an OpenTelemetry
 * Collector, Langfuse, Datadog, …) that receive a copy of HAR's telemetry.
 *
 * Written by `har telemetry destination add` to
 * `~/.har/destinations/telemetry.json` (mode 0600 — header values are secrets)
 * and read by the producers, which send to each destination themselves: the
 * agent hook (otel-hook's `exporter.destinations[]`) and the CLI (verification
 * traces). Mission Control is one more receiver and forwards nothing.
 * No file, or no enabled destination, means nothing leaves the machine.
 */

export const OTLP_SIGNALS = ['traces', 'logs', 'metrics'] as const;
export type OtlpSignal = (typeof OTLP_SIGNALS)[number];

/** OTLP over HTTP only. */
export const OTLP_DESTINATION_PROTOCOLS = ['http/protobuf', 'http/json'] as const;
export type OtlpDestinationProtocol = (typeof OTLP_DESTINATION_PROTOCOLS)[number];

export const TELEMETRY_DESTINATION_PRESETS = ['otlp', 'langfuse'] as const;
export type TelemetryDestinationPreset = (typeof TELEMETRY_DESTINATION_PRESETS)[number];

/** File name inside the destinations directory. */
export const TELEMETRY_DESTINATIONS_FILE = 'telemetry.json';

/** Environment variable overriding the destinations directory (default `~/.har/destinations`). */
export const HAR_DESTINATIONS_DIR_ENV = 'HAR_DESTINATIONS_DIR';

/**
 * Attribute keys whose values are absolute paths on the user's machine (repo
 * checkout, slot worktree, agent workspace, process cwd, source file). Mission
 * Control keeps them for attribution; the CLI strips them — at resource,
 * scope, span, span event/link, log record and metric data point (and exemplar)
 * level — from every copy it sends a destination unless that destination sets
 * `includeLocalPaths: true`. Agent hook traces are one Resource for every
 * receiver: they keep `factory.local.*` while Mission Control is one of them
 * (os-factory/har#519).
 *
 * An entry ending in `*` is a prefix rule: `factory.local.*` strips every key in
 * the local-only namespace (`attributeKeyDenied`).
 */
export const TELEMETRY_LOCAL_PATH_ATTRIBUTES = [
  // The local-only namespace HAR's session attributes use (src/core/telemetry-env.ts).
  `${LOCAL_ATTR_PREFIX}*`,
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

/**
 * Attribute keys that identify the person or account behind the telemetry.
 * Claude Code attaches `user.email`, `user.account_uuid`, `user.account_id`,
 * `user.id` and `organization.id` to its own metrics and events (and
 * `user.groups` through a sign-in gateway); `enduser.*` and the other `user.*`
 * keys are their OpenTelemetry semantic-convention counterparts. Claude Code's
 * own telemetry goes to Mission Control only; any copy the CLI sends a
 * destination has them stripped unless it sets `includeAccountIdentity: true`.
 */
export const TELEMETRY_ACCOUNT_IDENTITY_ATTRIBUTES = [
  // Claude Code standard attributes (metrics and events).
  'user.email',
  'user.account_uuid',
  'user.account_id',
  'user.id',
  'user.groups',
  'organization.id',
  // OpenTelemetry semantic conventions for the end user.
  'user.name',
  'user.full_name',
  'user.hash',
  'user.roles',
  'enduser.id',
  'enduser.pseudo.id',
  'enduser.role',
  'enduser.scope',
] as const;

/**
 * Every key stripped from a copy forwarded with default settings: local paths
 * and account identity. `forwardDeniedAttributes` gives the set for one destination.
 */
export const TELEMETRY_FORWARD_DENIED_ATTRIBUTES = [
  ...TELEMETRY_LOCAL_PATH_ATTRIBUTES,
  ...TELEMETRY_ACCOUNT_IDENTITY_ATTRIBUTES,
] as const;

/** Whether `key` matches a denied entry: an exact key, or a `prefix.*` rule. */
export function attributeKeyDenied(key: string, denied: readonly string[]): boolean {
  for (const entry of denied) {
    if (entry.endsWith('*') ? key.startsWith(entry.slice(0, -1)) : key === entry) return true;
  }
  return false;
}

const OTLP_ATTRIBUTE_FIELDS = new Set(['attributes', 'filteredAttributes']);

/**
 * Remove denied keys from every `attributes` / `filteredAttributes` list of a
 * decoded OTLP payload, in place: resource, scope, span, span event and link,
 * log record, metric data point and exemplar. Returns how many entries were
 * removed. The CLI's verification trace delivery and spool strip with it.
 */
export function removeDeniedOtlpAttributes(node: unknown, denied: readonly string[]): number {
  if (node === null || typeof node !== 'object' || ArrayBuffer.isView(node)) return 0;
  if (Array.isArray(node)) {
    return node.reduce((sum: number, item) => sum + removeDeniedOtlpAttributes(item, denied), 0);
  }
  const record = node as Record<string, unknown>;
  let removed = 0;
  for (const field of Object.keys(record)) {
    const value = record[field];
    if (OTLP_ATTRIBUTE_FIELDS.has(field) && Array.isArray(value)) {
      const kept = value.filter((kv) => {
        const key = kv && typeof kv === 'object' ? (kv as { key?: unknown }).key : undefined;
        return !(typeof key === 'string' && attributeKeyDenied(key, denied));
      });
      removed += value.length - kept.length;
      if (kept.length !== value.length) record[field] = kept;
      continue;
    }
    removed += removeDeniedOtlpAttributes(value, denied);
  }
  return removed;
}

/** Whether a destination receives local path attributes (opt-in, default false). */
export function destinationIncludesLocalPaths(destination: Pick<TelemetryDestination, 'includeLocalPaths'>): boolean {
  return destination.includeLocalPaths === true;
}

/** Whether a destination receives account identity attributes (opt-in, default false). */
export function destinationIncludesAccountIdentity(
  destination: Pick<TelemetryDestination, 'includeAccountIdentity'>,
): boolean {
  return destination.includeAccountIdentity === true;
}

/** Attribute keys stripped from every copy sent to this destination (empty: send as produced). */
export function forwardDeniedAttributes(
  destination: Pick<TelemetryDestination, 'includeLocalPaths' | 'includeAccountIdentity'>,
): readonly string[] {
  return [
    ...(destinationIncludesLocalPaths(destination) ? [] : TELEMETRY_LOCAL_PATH_ATTRIBUTES),
    ...(destinationIncludesAccountIdentity(destination) ? [] : TELEMETRY_ACCOUNT_IDENTITY_ATTRIBUTES),
  ];
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
   * Send attributes that hold absolute local paths
   * (`TELEMETRY_LOCAL_PATH_ATTRIBUTES`). Absent or false (the default): they are
   * stripped before the copy is spooled or sent, except `factory.local.*` in
   * agent hook traces while Mission Control is a destination (#519).
   */
  includeLocalPaths: z.boolean().optional(),
  /**
   * Send attributes that identify the account (`TELEMETRY_ACCOUNT_IDENTITY_ATTRIBUTES`:
   * email, account and user ids, organization id). Absent or false (the default):
   * they are stripped before the copy is spooled or sent.
   */
  includeAccountIdentity: z.boolean().optional(),
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
