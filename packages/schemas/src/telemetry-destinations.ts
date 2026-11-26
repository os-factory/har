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

/** Presets of an OTLP destination as the producers see it (`hq` is the hosted receiver's OTLP side). */
export const TELEMETRY_DESTINATION_PRESETS = ['otlp', 'langfuse', 'hq'] as const;
export type TelemetryDestinationPreset = (typeof TELEMETRY_DESTINATION_PRESETS)[number];

/** File name of the #522 OTLP-only list (version 1), migrated into `destinations.json`. */
export const TELEMETRY_DESTINATIONS_FILE = 'telemetry.json';

/** Environment variable overriding the destinations directory (default `~/.har/destinations`). */
export const HAR_DESTINATIONS_DIR_ENV = 'HAR_DESTINATIONS_DIR';

/**
 * Attribute keys whose values are absolute paths on the user's machine (repo
 * checkout, slot worktree, agent workspace, process cwd, source file). Mission
 * Control no longer needs them for attribution (ADR 0004 section 6: telemetry
 * is stamped from the session context); the CLI strips them — at resource,
 * scope, span, span event/link, log record and metric data point (and exemplar)
 * level — from every copy it sends a destination, Mission Control included,
 * unless that destination sets `includeLocalPaths: true`.
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
   * stripped before the copy is spooled or sent.
   */
  includeLocalPaths: z.boolean().optional(),
  /**
   * Send attributes that identify the account (`TELEMETRY_ACCOUNT_IDENTITY_ATTRIBUTES`:
   * email, account and user ids, organization id). Absent or false (the default):
   * they are stripped before the copy is spooled or sent.
   */
  includeAccountIdentity: z.boolean().optional(),
  /** `session.id` on every hook metric point (default true). */
  includeSessionId: z.boolean().optional(),
  /**
   * Per-repository filter, written as otel-hook's destination `scopes`: present,
   * a record goes here only when its repository matches a scope (first match
   * wins), and a record without a repository never does.
   */
  scopes: z.array(z.lazy(() => otelHookScopeSchema)).min(1).optional(),
  createdAt: z.string().optional(),
});
export type TelemetryDestination = z.infer<typeof telemetryDestinationSchema>;

// ---------------------------------------------------------------------------
// Per-repository scopes (what a receiver gets, repository by repository)
// ---------------------------------------------------------------------------

/**
 * How much of a repository's activity a destination receives, in onboarding's
 * vocabulary: `off` nothing; `usage` records, proofs, evidence and the agent's
 * usage (spans and metrics, no event records); `outline` plus the event records
 * without text; `full` plus the text, as `content` says.
 */
export const DESTINATION_REPOSITORY_SCOPES = ['off', 'usage', 'outline', 'full'] as const;
export type DestinationRepositoryScope = (typeof DESTINATION_REPOSITORY_SCOPES)[number];

/** What happens to prompts, replies and tool text at the `full` scope. */
export const DESTINATION_REPOSITORY_CONTENT = ['none', 'redacted', 'masked', 'raw'] as const;
export type DestinationRepositoryContent = (typeof DESTINATION_REPOSITORY_CONTENT)[number];

/** otel-hook's `privacy.contentMode` values. */
export const OTEL_HOOK_CONTENT_MODES = ['omit', 'mask', 'redact', 'raw'] as const;
export type OtelHookContentMode = (typeof OTEL_HOOK_CONTENT_MODES)[number];

/** One repository a scoped destination receives, and at which scope. */
export const destinationRepositorySchema = z
  .object({
    /** Canonical local path of the main checkout (matches records sent from it and its worktrees). */
    path: z.string().min(1).optional(),
    /** Credential-free repository URL (`origin`); agent telemetry is matched by it. */
    url: z.string().min(1).max(2048).optional(),
    scope: z.enum(DESTINATION_REPOSITORY_SCOPES),
    /** Text at the `full` scope (default `none`). */
    content: z.enum(DESTINATION_REPOSITORY_CONTENT).optional(),
  })
  .refine((entry) => entry.path !== undefined || entry.url !== undefined, 'a repository needs a path or a url');
export type DestinationRepository = z.infer<typeof destinationRepositorySchema>;

/** One otel-hook destination scope (`exporter.destinations[].scopes[]`). */
export const otelHookScopeSchema = z.object({
  /** Repository URLs (any spelling of the remote), or `*` for every record that names one. */
  repositories: z.union([z.literal('*'), z.array(z.string().min(1).max(2048)).min(1)]),
  signals: z.array(z.enum(OTLP_SIGNALS)).min(1).optional(),
  contentMode: z.enum(OTEL_HOOK_CONTENT_MODES).optional(),
  includeSessionId: z.boolean().optional(),
});
export type OtelHookScope = z.infer<typeof otelHookScopeSchema>;

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

// ---------------------------------------------------------------------------
// One destination list (ADR 0005 section 6)
// ---------------------------------------------------------------------------

/**
 * Presets of the one destination list HAR keeps for everything it sends
 * (`~/.har/destinations/destinations.json`):
 *
 * | Preset            | OTLP signals                    | Records, proofs, evidence |
 * |-------------------|---------------------------------|---------------------------|
 * | `mission-control` | traces, logs, metrics           | yes                       |
 * | `hq`              | traces, logs, metrics           | yes                       |
 * | `git-notes`       | none                            | proofs only (opt-in)      |
 * | `otlp`            | any (default traces, metrics)   | no                        |
 * | `langfuse`        | traces                          | no                        |
 *
 * Mission Control books Claude Code usage from Claude Code's own telemetry and
 * takes otel-hook metrics only for the other providers (ADR 0005 section 5):
 * that filter is the receiver's, by `otelhook.provider.id`.
 */
export const DESTINATION_PRESETS = ['mission-control', 'hq', 'git-notes', 'otlp', 'langfuse'] as const;
export type DestinationPreset = (typeof DESTINATION_PRESETS)[number];

/** Presets that implement the ingest v2 contract (records, proofs, evidence over HTTP). */
export const INGEST_RECEIVER_PRESETS = ['mission-control', 'hq'] as const satisfies readonly DestinationPreset[];

/** File name of the destination list inside the destinations directory. */
export const DESTINATIONS_FILE = 'destinations.json';
export const DESTINATIONS_FILE_VERSION = 2;

/** Default name of the Mission Control entry. */
export const MISSION_CONTROL_DESTINATION_NAME = 'mission-control';

/** What a preset sends when the user does not narrow it. */
export interface DestinationPresetDefaults {
  signals: readonly OtlpSignal[];
  records: boolean;
  proofs: boolean;
  evidence: boolean;
}

export const DESTINATION_PRESET_DEFAULTS: Readonly<Record<DestinationPreset, DestinationPresetDefaults>> = {
  'mission-control': { signals: ['traces', 'logs', 'metrics'], records: true, proofs: true, evidence: true },
  hq: { signals: ['traces', 'logs', 'metrics'], records: true, proofs: true, evidence: true },
  'git-notes': { signals: [], records: false, proofs: true, evidence: false },
  otlp: { signals: ['traces', 'metrics'], records: false, proofs: false, evidence: false },
  langfuse: { signals: ['traces'], records: false, proofs: false, evidence: false },
};

/**
 * How HAR authenticates to a receiver without storing the secret in the
 * destination file. `hq-token`: `Authorization: Bearer <token>`, the token from
 * `HAR_PORTAL_TOKEN` or the saved HAR HQ connection (`har hq connect`).
 */
export const DESTINATION_AUTH_KINDS = ['hq-token'] as const;
export const destinationAuthSchema = z.object({ kind: z.enum(DESTINATION_AUTH_KINDS) });
export type DestinationAuth = z.infer<typeof destinationAuthSchema>;

export const harDestinationSchema = z
  .object({
    name: telemetryDestinationNameSchema,
    preset: z.enum(DESTINATION_PRESETS),
    enabled: z.boolean().default(true),
    /**
     * Ingest base URL of a receiver (`mission-control`, `hq`): `v2/records`,
     * `otel/v1/<signal>`, … are resolved against it. Mission Control's defaults
     * to `HAR_CONTROL_API_URL` + `/api`.
     */
    baseUrl: endpointSchema.optional(),
    /** Base OTLP/HTTP URL of an `otlp` / `langfuse` destination (`<endpoint>/v1/<signal>`). */
    endpoint: endpointSchema.optional(),
    protocol: z.enum(OTLP_DESTINATION_PROTOCOLS).default('http/protobuf'),
    /** Header values are secrets: never printed unmasked, never written to the hook config. */
    headers: z.record(headerNameSchema, z.string().max(8192)).default({}),
    auth: destinationAuthSchema.optional(),
    /** OTLP signals this destination receives (empty: none). */
    signals: z.array(z.enum(OTLP_SIGNALS)).default([]),
    /** Ingest v2 records (`POST v2/records`). */
    records: z.boolean().default(false),
    /** Factory Commits proofs (`POST v2/proofs`; for `git-notes`, the factory note). */
    proofs: z.boolean().default(false),
    /** Stage logs and artifacts (`v2/evidence/missing` + `PUT v2/evidence/<sha256>`). */
    evidence: z.boolean().default(false),
    /** Opt-in: keep `factory.local.*` and other local path attributes. */
    includeLocalPaths: z.boolean().optional(),
    /** Opt-in: keep account identity attributes. */
    includeAccountIdentity: z.boolean().optional(),
    /** `session.id` on every metric point (default true); off where per-session series are too many. */
    includeSessionId: z.boolean().optional(),
    /**
     * Per-repository opt-in. Present, the destination receives only these
     * repositories, each at its scope (records, proofs, evidence and agent
     * telemetry alike). An `hq` destination is always scoped: without this
     * field it receives nothing (`har hq repos add`).
     */
    repositories: z.array(destinationRepositorySchema).optional(),
    createdAt: z.string().optional(),
  })
  .superRefine((destination, ctx) => {
    const issue = (message: string, path: string) => ctx.addIssue({ code: 'custom', message, path: [path] });
    const receiver = (INGEST_RECEIVER_PRESETS as readonly string[]).includes(destination.preset);
    if (destination.preset === 'otlp' || destination.preset === 'langfuse') {
      if (!destination.endpoint) issue(`a ${destination.preset} destination needs an endpoint`, 'endpoint');
      if (destination.signals.length === 0) issue('subscribe at least one signal', 'signals');
    } else if (destination.endpoint) {
      issue(`a ${destination.preset} destination has no OTLP endpoint (use baseUrl)`, 'endpoint');
    }
    if (!receiver) {
      for (const key of ['records', 'evidence'] as const) {
        if (destination[key]) issue(`a ${destination.preset} destination does not take ${key}`, key);
      }
      if (destination.baseUrl) issue(`a ${destination.preset} destination has no ingest base URL`, 'baseUrl');
    }
    if (destination.preset !== 'git-notes' && !receiver && destination.proofs) {
      issue(`a ${destination.preset} destination does not take proofs`, 'proofs');
    }
    if (destination.preset === 'hq' && !destination.baseUrl) issue('an hq destination needs a baseUrl', 'baseUrl');
    if (destination.preset === 'git-notes' && destination.signals.length > 0) {
      issue('a git-notes destination takes no OTLP signals', 'signals');
    }
    if (destination.preset === 'mission-control' && (destination.auth || Object.keys(destination.headers).length > 0)) {
      issue('Mission Control takes no credentials', 'headers');
    }
  });
export type HarDestination = z.infer<typeof harDestinationSchema>;

export const harDestinationsFileSchema = z.object({
  version: z.literal(DESTINATIONS_FILE_VERSION),
  destinations: z.array(harDestinationSchema).default([]),
});
export type HarDestinationsFile = z.infer<typeof harDestinationsFileSchema>;

/** Whether a destination is an ingest v2 receiver (`mission-control`, `hq`). */
export function isIngestReceiver(destination: Pick<HarDestination, 'preset'>): boolean {
  return (INGEST_RECEIVER_PRESETS as readonly string[]).includes(destination.preset);
}

/** A #522 (`telemetry.json`, version 1) OTLP destination as a v2 list entry: signals only. */
export function migrateTelemetryDestination(destination: TelemetryDestination): HarDestination {
  return harDestinationSchema.parse({
    name: destination.name,
    preset: destination.preset ?? 'otlp',
    enabled: destination.enabled,
    endpoint: destination.endpoint,
    protocol: destination.protocol,
    headers: destination.headers,
    signals: destination.signals,
    records: false,
    proofs: false,
    evidence: false,
    ...(destination.includeLocalPaths !== undefined ? { includeLocalPaths: destination.includeLocalPaths } : {}),
    ...(destination.includeAccountIdentity !== undefined
      ? { includeAccountIdentity: destination.includeAccountIdentity }
      : {}),
    ...(destination.createdAt ? { createdAt: destination.createdAt } : {}),
  });
}

/** Join an ingest v2 path (`v2/records`, `otel/v1/traces`) onto a base URL. */
export function ingestUrl(baseUrl: string, relativePath: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${relativePath.replace(/^\/+/, '')}`;
}
