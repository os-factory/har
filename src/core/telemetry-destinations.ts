import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DESTINATIONS_FILE,
  DESTINATIONS_FILE_VERSION,
  DESTINATION_PRESET_DEFAULTS,
  HAR_DESTINATIONS_DIR_ENV,
  MISSION_CONTROL_DESTINATION_NAME,
  OTLP_SIGNALS,
  TELEMETRY_DESTINATIONS_FILE,
  harDestinationSchema,
  harDestinationsFileSchema,
  ingestUrl,
  maskHeaderValue,
  migrateTelemetryDestination,
  otlpSignalUrl,
  telemetryDestinationSchema,
  telemetryDestinationsFileSchema,
  type HarDestination,
  type HarDestinationsFile,
  type OtlpDestinationProtocol,
  type OtlpSignal,
  type TelemetryDestination,
  type TelemetryDestinationsFile,
} from '../harness/schema';
import { getControlApiUrl, isControlEnabled } from './control-config';
import { buildOtelHookScopes } from './destination-scopes';
import { kernoApiUrlFor } from './portal-hosts';
import { getActivePortalConnection } from './portal-targets';

/**
 * The one destination list (ADR 0005 section 6): every place HAR sends
 * telemetry, records, proofs and evidence, in `~/.har/destinations/destinations.json`
 * (mode 0600). Each entry says what it accepts (OTLP signals, records, proofs,
 * evidence); `har telemetry destination …` edits it.
 *
 * The file lives in its own directory so Mission Control's container can mount
 * the directory read-only: a single-file bind mount would pin the old inode and
 * miss every atomic rewrite below.
 *
 * #522's OTLP-only `telemetry.json` (version 1) is migrated on first read: its
 * entries keep their signals and take no records, and Mission Control is added
 * when it is enabled on this machine. With no file at all, the list is Mission
 * Control alone (when enabled), without writing anything.
 */

export const DEFAULT_LANGFUSE_HOST = 'https://cloud.langfuse.com';

/** Overrides the ingest base URL of an `hq` destination added without `--base-url`. */
export const HQ_INGEST_URL_ENV = 'HAR_HQ_INGEST_URL';

export function getDestinationsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[HAR_DESTINATIONS_DIR_ENV];
  if (override && override.trim()) return path.resolve(override);
  return path.join(os.homedir(), '.har', 'destinations');
}

/** `destinations.json`: the destination list (version 2). */
export function getDestinationsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getDestinationsDir(env), DESTINATIONS_FILE);
}

/** #522's `telemetry.json` (version 1), read only to migrate it. */
export function getLegacyTelemetryDestinationsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getDestinationsDir(env), TELEMETRY_DESTINATIONS_FILE);
}

/** @deprecated The list is `destinations.json` now; kept for callers that print the config path. */
export function getTelemetryDestinationsPath(env: NodeJS.ProcessEnv = process.env): string {
  return getDestinationsPath(env);
}

/** Create the destinations directory (0700) — also before Mission Control mounts it. */
export function ensureDestinationsDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = getDestinationsDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function formatIssues(filePath: string, issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return `Invalid ${filePath}: ${issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`).join('; ')}`;
}

/** Mission Control's entry: everything, at `HAR_CONTROL_API_URL` + `/api`. */
export function buildMissionControlDestination(options: { name?: string; enabled?: boolean } = {}): HarDestination {
  const defaults = DESTINATION_PRESET_DEFAULTS['mission-control'];
  return harDestinationSchema.parse({
    name: options.name ?? MISSION_CONTROL_DESTINATION_NAME,
    preset: 'mission-control',
    enabled: options.enabled ?? true,
    signals: [...defaults.signals],
    records: defaults.records,
    proofs: defaults.proofs,
    evidence: defaults.evidence,
    createdAt: new Date().toISOString(),
  });
}

/** The list a machine starts with: Mission Control, unless it is disabled (`HAR_CONTROL_DISABLED=true`). */
export function defaultDestinations(): HarDestination[] {
  return isControlEnabled() ? [buildMissionControlDestination()] : [];
}

/** Migrate #522's `telemetry.json` into a version 2 list. Throws on an invalid file. */
export function migrateLegacyDestinationsFile(raw: unknown, filePath: string): HarDestinationsFile {
  const parsed = telemetryDestinationsFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(formatIssues(filePath, parsed.error.issues));
  const migrated = parsed.data.destinations.map(migrateTelemetryDestination);
  const taken = new Set(migrated.map((destination) => destination.name));
  const seeded = defaultDestinations().filter((destination) => !taken.has(destination.name));
  return { version: DESTINATIONS_FILE_VERSION, destinations: [...seeded, ...migrated] };
}

/**
 * Mission Control is in the list unless the user decided otherwise: a list
 * with no `mission-control` entry gets the default one (not written) while
 * Mission Control is enabled on this machine. Removing it stores it disabled.
 */
function withImplicitMissionControl(file: HarDestinationsFile): HarDestinationsFile {
  if (file.destinations.some((destination) => destination.preset === 'mission-control')) return file;
  const seeded = defaultDestinations().filter(
    (destination) => !file.destinations.some((entry) => entry.name === destination.name),
  );
  return seeded.length > 0 ? { ...file, destinations: [...seeded, ...file.destinations] } : file;
}

/**
 * Read the destination list. Missing → migrate `telemetry.json` (written back
 * once, the old file renamed `telemetry.json.migrated`), else the default list
 * (not written). Invalid → throws (never silently drops a user's config).
 */
export function readDestinations(env: NodeJS.ProcessEnv = process.env): HarDestinationsFile {
  const filePath = getDestinationsPath(env);
  if (fs.existsSync(filePath)) {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    const parsed = harDestinationsFileSchema.safeParse(raw);
    if (!parsed.success) throw new Error(formatIssues(filePath, parsed.error.issues));
    return withImplicitMissionControl(parsed.data);
  }
  const legacyPath = getLegacyTelemetryDestinationsPath(env);
  if (fs.existsSync(legacyPath)) {
    const migrated = migrateLegacyDestinationsFile(JSON.parse(fs.readFileSync(legacyPath, 'utf8')) as unknown, legacyPath);
    try {
      writeDestinations(migrated, env);
      fs.renameSync(legacyPath, `${legacyPath}.migrated`);
    } catch {
      // Read-only home: use the migrated list in memory, migrate again next time.
    }
    return migrated;
  }
  return { version: DESTINATIONS_FILE_VERSION, destinations: defaultDestinations() };
}

/** Atomic write with mode 0600 (header values are secrets). */
export function writeDestinations(file: HarDestinationsFile, env: NodeJS.ProcessEnv = process.env): string {
  const validated = harDestinationsFileSchema.parse(file);
  ensureDestinationsDir(env);
  const filePath = getDestinationsPath(env);
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, filePath);
  return filePath;
}

export function addDestination(
  destination: HarDestination,
  options: { replace?: boolean; env?: NodeJS.ProcessEnv } = {},
): { path: string; replaced: boolean } {
  const env = options.env ?? process.env;
  const validated = harDestinationSchema.parse(destination);
  const file = readDestinations(env);
  const index = file.destinations.findIndex((entry) => entry.name === validated.name);
  if (index >= 0 && !options.replace) {
    throw new Error(`Destination "${validated.name}" already exists — pass --overwrite to replace it`);
  }
  const destinations = [...file.destinations];
  if (index >= 0) destinations[index] = validated;
  else destinations.push(validated);
  return { path: writeDestinations({ ...file, destinations }, env), replaced: index >= 0 };
}

/**
 * Remove a destination. Mission Control's entry is kept, disabled: without an
 * entry it would come back as the default.
 */
export function removeDestination(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const file = readDestinations(env);
  const target = file.destinations.find((entry) => entry.name === name);
  if (!target) return false;
  const destinations =
    target.preset === 'mission-control'
      ? file.destinations.map((entry) => (entry === target ? { ...entry, enabled: false } : entry))
      : file.destinations.filter((entry) => entry !== target);
  writeDestinations({ ...file, destinations }, env);
  return true;
}

export function findDestination(name: string, env: NodeJS.ProcessEnv = process.env): HarDestination | undefined {
  return readDestinations(env).destinations.find((entry) => entry.name === name);
}

/** Enabled destinations, or none when the list cannot be read. */
export function enabledDestinations(env: NodeJS.ProcessEnv = process.env): HarDestination[] {
  try {
    return readDestinations(env).destinations.filter((destination) => destination.enabled);
  } catch {
    return [];
  }
}

/** The enabled Mission Control entry, when Mission Control is not disabled on this machine. */
export function missionControlDestination(env: NodeJS.ProcessEnv = process.env): HarDestination | undefined {
  if (!isControlEnabled()) return undefined;
  return enabledDestinations(env).find((destination) => destination.preset === 'mission-control');
}

/** Whether the Mission Control entry receives an OTLP signal. */
export function missionControlReceives(signal: OtlpSignal, env: NodeJS.ProcessEnv = process.env): boolean {
  return missionControlDestination(env)?.signals.includes(signal) === true;
}

/** Ingest base URL of a receiver entry: its `baseUrl`, Mission Control's from `HAR_CONTROL_API_URL`. */
export function destinationIngestBaseUrl(destination: HarDestination): string | undefined {
  if (destination.baseUrl) return destination.baseUrl.replace(/\/+$/, '');
  if (destination.preset === 'mission-control') return `${getControlApiUrl().replace(/\/+$/, '')}/api`;
  return undefined;
}

/**
 * The HAR HQ ingest key: `HAR_PORTAL_TOKEN`, else the saved connection's token
 * (`har hq connect`). Read at send time, never stored in the destination list.
 */
export function resolveHqToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env.HAR_PORTAL_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    return getActivePortalConnection()?.token || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Request headers for a destination, secrets resolved: its literal headers,
 * plus `Authorization: Bearer <token>` for `auth.kind: hq-token`. Undefined
 * when a credential it needs is missing.
 */
export function resolveDestinationHeaders(
  destination: HarDestination,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  const headers = { ...destination.headers };
  if (destination.auth?.kind === 'hq-token') {
    const token = resolveHqToken(env);
    if (!token) return undefined;
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Default ingest base URL of an `hq` destination: `HAR_HQ_INGEST_URL`, else
 * derived from the HAR HQ URL (`HAR_PORTAL_URL` or the saved connection): the
 * API host's `/api/har/ingest` when HAR knows it, else `<portal>/ingest`.
 */
export function defaultHqIngestBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env[HQ_INGEST_URL_ENV]?.trim();
  if (override) return override.replace(/\/+$/, '');
  let portalUrl = env.HAR_PORTAL_URL?.trim();
  if (!portalUrl) {
    try {
      portalUrl = getActivePortalConnection()?.portalUrl;
    } catch {
      portalUrl = undefined;
    }
  }
  if (!portalUrl) return undefined;
  const api = kernoApiUrlFor(portalUrl);
  return api ? `${api}/api/har/ingest` : `${portalUrl.replace(/\/+$/, '')}/ingest`;
}

/**
 * The OTLP destinations producers send to themselves (the agent hook, the CLI's
 * verification traces), in the #522 shape: `otlp`, `langfuse`, and the OTLP side
 * of `hq` (`<baseUrl>/otel`, its key resolved). Mission Control is not listed
 * here: producers send to it as before (its URL follows `HAR_CONTROL_API_URL`).
 * An `hq` entry without a key is left out, and so is a scoped entry (every
 * `hq`) that lists no repository with a URL and a scope above `off`.
 */
export function materializeOtlpDestinations(
  file: HarDestinationsFile,
  env: NodeJS.ProcessEnv = process.env,
): TelemetryDestination[] {
  const out: TelemetryDestination[] = [];
  for (const destination of file.destinations) {
    if (destination.signals.length === 0) continue;
    let endpoint: string | undefined;
    let preset: TelemetryDestination['preset'];
    if (destination.preset === 'otlp' || destination.preset === 'langfuse') {
      endpoint = destination.endpoint;
      preset = destination.preset;
    } else if (destination.preset === 'hq') {
      const base = destinationIngestBaseUrl(destination);
      endpoint = base ? ingestUrl(base, 'otel') : undefined;
      preset = 'hq';
    }
    if (!endpoint) continue;
    const headers = resolveDestinationHeaders(destination, env);
    if (!headers) continue;
    // A scoped destination (every `hq`) gets only the repositories it lists; none → nothing to send.
    const scopes = buildOtelHookScopes(destination);
    if (scopes !== undefined && scopes.length === 0) continue;
    out.push(
      telemetryDestinationSchema.parse({
        name: destination.name,
        preset,
        endpoint,
        protocol: destination.protocol,
        headers,
        signals: destination.signals,
        enabled: destination.enabled,
        ...(destination.includeLocalPaths !== undefined ? { includeLocalPaths: destination.includeLocalPaths } : {}),
        ...(destination.includeAccountIdentity !== undefined
          ? { includeAccountIdentity: destination.includeAccountIdentity }
          : {}),
        ...(destination.includeSessionId !== undefined ? { includeSessionId: destination.includeSessionId } : {}),
        ...(scopes ? { scopes } : {}),
        ...(destination.createdAt ? { createdAt: destination.createdAt } : {}),
      }),
    );
  }
  return out;
}

/**
 * OTLP destinations other than Mission Control, header values resolved (see
 * `materializeOtlpDestinations`). Invalid list → throws.
 */
export function readTelemetryDestinations(env: NodeJS.ProcessEnv = process.env): TelemetryDestinationsFile {
  return { version: 1, destinations: materializeOtlpDestinations(readDestinations(env), env) };
}

/** Parse repeated `--header K=V` flags. */
export function parseHeaderPairs(pairs: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of pairs) {
    const equals = pair.indexOf('=');
    if (equals <= 0) throw new Error('--header expects Name=value');
    headers[pair.slice(0, equals).trim()] = pair.slice(equals + 1);
  }
  return headers;
}

/** Parse `--signals traces,logs` (also accepts repeated flags). */
export function parseSignals(values: readonly string[] | undefined): OtlpSignal[] | undefined {
  if (!values || values.length === 0) return undefined;
  const signals = values.flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
  for (const signal of signals) {
    if (!(OTLP_SIGNALS as readonly string[]).includes(signal)) {
      throw new Error(`Unknown signal "${signal}" (expected ${OTLP_SIGNALS.join(', ')})`);
    }
  }
  return [...new Set(signals)] as OtlpSignal[];
}

/**
 * Signals `--preset otlp` subscribes to when `--signals` is not given. Logs are
 * opt-in: at the `full` telemetry level they carry prompts, replies and tool
 * input/output verbatim.
 */
export const OTLP_PRESET_DEFAULT_SIGNALS: readonly OtlpSignal[] = ['traces', 'metrics'];

/** One-line warning printed when a destination subscribes to logs. */
export const DESTINATION_LOGS_WARNING =
  'Logs are subscribed: at the full telemetry level they carry prompts, replies and tool input/output verbatim.';

export function buildOtlpDestination(options: {
  name: string;
  endpoint: string;
  headers?: Record<string, string>;
  signals?: OtlpSignal[];
  protocol?: OtlpDestinationProtocol;
  enabled?: boolean;
  includeLocalPaths?: boolean;
  includeAccountIdentity?: boolean;
}): TelemetryDestination {
  return telemetryDestinationSchema.parse({
    name: options.name,
    preset: 'otlp',
    endpoint: options.endpoint,
    protocol: options.protocol ?? 'http/protobuf',
    headers: options.headers ?? {},
    signals: options.signals ?? [...OTLP_PRESET_DEFAULT_SIGNALS],
    enabled: options.enabled ?? true,
    ...(options.includeLocalPaths ? { includeLocalPaths: true } : {}),
    ...(options.includeAccountIdentity ? { includeAccountIdentity: true } : {}),
    createdAt: new Date().toISOString(),
  });
}

/**
 * Langfuse's OTLP endpoint: `<host>/api/public/otel`, HTTP only, Basic auth
 * with `public:secret`, and traces only (it ingests no OTLP logs or metrics).
 */
export function buildLangfuseDestination(options: {
  name: string;
  host?: string;
  publicKey: string;
  secretKey: string;
  protocol?: OtlpDestinationProtocol;
  enabled?: boolean;
  includeLocalPaths?: boolean;
  includeAccountIdentity?: boolean;
}): TelemetryDestination {
  if (!options.publicKey || !options.secretKey) {
    throw new Error('Langfuse needs --public-key and --secret-key (or LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY)');
  }
  const host = (options.host ?? DEFAULT_LANGFUSE_HOST).replace(/\/+$/, '');
  const token = Buffer.from(`${options.publicKey}:${options.secretKey}`).toString('base64');
  return telemetryDestinationSchema.parse({
    name: options.name,
    preset: 'langfuse',
    endpoint: `${host}/api/public/otel`,
    protocol: options.protocol ?? 'http/protobuf',
    headers: { Authorization: `Basic ${token}` },
    signals: ['traces'],
    enabled: options.enabled ?? true,
    ...(options.includeLocalPaths ? { includeLocalPaths: true } : {}),
    ...(options.includeAccountIdentity ? { includeAccountIdentity: true } : {}),
    createdAt: new Date().toISOString(),
  });
}

/** An `hq` destination: HAR HQ's ingest v2 receiver, keyed by the HAR HQ token (never stored here). */
export function buildHqDestination(options: {
  name?: string;
  baseUrl: string;
  signals?: OtlpSignal[];
  records?: boolean;
  proofs?: boolean;
  evidence?: boolean;
  enabled?: boolean;
  includeLocalPaths?: boolean;
  includeAccountIdentity?: boolean;
  includeSessionId?: boolean;
}): HarDestination {
  const defaults = DESTINATION_PRESET_DEFAULTS.hq;
  return harDestinationSchema.parse({
    name: options.name ?? 'hq',
    preset: 'hq',
    enabled: options.enabled ?? true,
    baseUrl: options.baseUrl,
    auth: { kind: 'hq-token' },
    signals: options.signals ?? [...defaults.signals],
    records: options.records ?? defaults.records,
    proofs: options.proofs ?? defaults.proofs,
    evidence: options.evidence ?? defaults.evidence,
    ...(options.includeLocalPaths ? { includeLocalPaths: true } : {}),
    ...(options.includeAccountIdentity ? { includeAccountIdentity: true } : {}),
    ...(options.includeSessionId === false ? { includeSessionId: false } : {}),
    createdAt: new Date().toISOString(),
  });
}

/** A `git-notes` destination (opt-in): each passing proof is written as a factory note on the commit. */
export function buildGitNotesDestination(options: { name?: string; enabled?: boolean } = {}): HarDestination {
  return harDestinationSchema.parse({
    name: options.name ?? 'git-notes',
    preset: 'git-notes',
    enabled: options.enabled ?? true,
    signals: [],
    proofs: true,
    createdAt: new Date().toISOString(),
  });
}

/** Whether an enabled `git-notes` destination is in the list (factory notes are opt-in). */
export function gitNotesDestinationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return enabledDestinations(env).some((destination) => destination.preset === 'git-notes' && destination.proofs);
}

/** Write a #522-shaped list (tests, old callers): migrated into `destinations.json`, Mission Control seeded. */
export function writeTelemetryDestinations(file: TelemetryDestinationsFile, env: NodeJS.ProcessEnv = process.env): string {
  return writeDestinations(migrateLegacyDestinationsFile(file, getDestinationsPath(env)), env);
}

/** Add an OTLP destination built by `buildOtlpDestination` / `buildLangfuseDestination`. */
export function addTelemetryDestination(
  destination: TelemetryDestination,
  options: { replace?: boolean; env?: NodeJS.ProcessEnv } = {},
): { path: string; replaced: boolean } {
  return addDestination(migrateTelemetryDestination(telemetryDestinationSchema.parse(destination)), options);
}

export function removeTelemetryDestination(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return removeDestination(name, env);
}

/** The OTLP view of a destination (header values resolved), or undefined. */
export function findTelemetryDestination(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): TelemetryDestination | undefined {
  return readTelemetryDestinations(env).destinations.find((entry) => entry.name === name);
}

/** A list entry safe to print: header values masked. */
export function maskDestination(destination: HarDestination): HarDestination {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(destination.headers)) headers[name] = maskHeaderValue(value);
  return { ...destination, headers };
}

/** A destination safe to print: header values masked. */
export function maskTelemetryDestination(destination: TelemetryDestination): TelemetryDestination {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(destination.headers)) headers[name] = maskHeaderValue(value);
  return { ...destination, headers };
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** One small OTLP/JSON payload for the destination's first subscribed signal. */
export function buildTestPayload(signal: OtlpSignal, now = Date.now()): Record<string, unknown> {
  const nanos = (ms: number) => `${BigInt(ms) * 1_000_000n}`;
  const resource = {
    attributes: [{ key: 'service.name', value: { stringValue: 'har' } }],
  };
  const scope = { name: '@osfactory/har' };
  const attributes = [{ key: 'factory.telemetry.destination_test', value: { boolValue: true } }];
  if (signal === 'traces') {
    return {
      resourceSpans: [
        {
          resource,
          scopeSpans: [
            {
              scope,
              spans: [
                {
                  traceId: hex(16),
                  spanId: hex(8),
                  name: 'har telemetry destination test',
                  kind: 1,
                  startTimeUnixNano: nanos(now - 1),
                  endTimeUnixNano: nanos(now),
                  attributes,
                },
              ],
            },
          ],
        },
      ],
    };
  }
  if (signal === 'logs') {
    return {
      resourceLogs: [
        {
          resource,
          scopeLogs: [
            {
              scope,
              logRecords: [
                {
                  timeUnixNano: nanos(now),
                  severityNumber: 9,
                  severityText: 'INFO',
                  body: { stringValue: 'har telemetry destination test' },
                  attributes,
                },
              ],
            },
          ],
        },
      ],
    };
  }
  return {
    resourceMetrics: [
      {
        resource,
        scopeMetrics: [
          {
            scope,
            metrics: [
              {
                name: 'factory.telemetry.destination_test',
                gauge: { dataPoints: [{ timeUnixNano: nanos(now), asInt: '1', attributes }] },
              },
            ],
          },
        ],
      },
    ],
  };
}

export interface DestinationTestResult {
  name: string;
  signal: OtlpSignal;
  url: string;
  ok: boolean;
  status: number | null;
  /** Never contains header values. */
  detail?: string;
}

/** Send one OTLP/JSON test record and report the HTTP status. */
export async function testTelemetryDestination(
  destination: TelemetryDestination,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<DestinationTestResult> {
  const signal = destination.signals.includes('traces') ? 'traces' : destination.signals[0];
  const url = otlpSignalUrl(destination.endpoint, signal);
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { ...destination.headers, 'content-type': 'application/json' },
      body: JSON.stringify(buildTestPayload(signal)),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    let detail: string | undefined;
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).trim();
      detail = text ? text.slice(0, 300) : response.statusText || undefined;
    }
    return { name: destination.name, signal, url, ok: response.ok, status: response.status, detail };
  } catch (err) {
    let message = err instanceof Error ? err.message : String(err);
    // undici reports "fetch failed" and keeps the reason (ECONNREFUSED, DNS, TLS) in `cause`.
    const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
    if (cause instanceof Error && cause.message) message = `${message}: ${cause.message}`;
    return { name: destination.name, signal, url, ok: false, status: null, detail: message };
  }
}
