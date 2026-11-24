import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  HAR_DESTINATIONS_DIR_ENV,
  TELEMETRY_DESTINATIONS_FILE,
  destinationIncludesAccountIdentity,
  destinationIncludesLocalPaths,
  destinationsForSignal,
  forwardDeniedAttributes,
  otlpSignalUrl,
  telemetryDestinationsFileSchema,
  type OtlpSignal,
  type TelemetryDestination,
} from '@har/schemas';
import { stripDeniedAttributes, type StrippedOtlpBody } from '@/server/otlp-privacy';

/**
 * Forward what the OTLP receivers accepted to the destinations configured with
 * `har telemetry destination add` (Langfuse, an OpenTelemetry Collector, …).
 *
 * The request body is forwarded with its content type and encoding to
 * `<endpoint>/v1/<signal>`. Attributes holding absolute local paths
 * (`TELEMETRY_LOCAL_PATH_ATTRIBUTES`) and account identity
 * (`TELEMETRY_ACCOUNT_IDENTITY_ATTRIBUTES`) are stripped before the copy is
 * written to the spool, unless the destination opted in with `includeLocalPaths`
 * / `includeAccountIdentity`; a body with none of them is forwarded byte for byte. Forwarding never touches the receiver
 * response: the route schedules it and returns. Each copy goes through a small
 * file spool so a destination that is down gets bounded retries with backoff,
 * and the spool is capped by size and age so a dead destination cannot grow the
 * disk forever. Header values (secrets) are never written to the spool — they
 * are read from the destination config at send time.
 *
 * With no destinations file, or no enabled destination for the signal, nothing
 * is written and nothing is sent.
 */

export const OTLP_FORWARD_MAX_ATTEMPTS = 8;
export const OTLP_FORWARD_MAX_BACKOFF_MS = 5 * 60_000;
export const OTLP_FORWARD_MAX_AGE_MS = 24 * 60 * 60_000;
export const OTLP_FORWARD_MAX_SPOOL_BYTES = 64 * 1024 * 1024;
const RETRY_INTERVAL_MS = 15_000;
const SEND_TIMEOUT_MS = 10_000;

export interface OtlpForwardOptions {
  destinationsDir?: string;
  spoolDir?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxSpoolBytes?: number;
  maxAgeMs?: number;
  maxAttempts?: number;
}

interface SpoolEntry {
  destination: string;
  signal: OtlpSignal;
  contentType: string;
  contentEncoding?: string;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  /** Set when the body still carries local path attributes (destination opted in). */
  includesLocalPaths?: true;
  /** Set when the body still carries account identity attributes (destination opted in). */
  includesAccountIdentity?: true;
}

// Each copy is two files: `<id>.json` (small metadata, rewritten on retry) and
// `<id>.body` (the raw request body, written once), so a drain that only checks
// due times never reads the bodies.
const META = '.json';
const BODY = '.body';

function bodyPathFor(spoolDir: string, metaName: string): string {
  return path.join(spoolDir, `${metaName.slice(0, -META.length)}${BODY}`);
}

export function resolveDestinationsDir(env: Record<string, string | undefined> = process.env): string {
  const override = env[HAR_DESTINATIONS_DIR_ENV];
  if (override && override.trim()) return override;
  return path.join(os.homedir(), '.har', 'destinations');
}

/** Next to the SQLite file when it has an absolute path (the container's /data volume), else tmp. */
export function resolveSpoolDir(env: Record<string, string | undefined> = process.env): string {
  if (env.HAR_OTLP_SPOOL_DIR && env.HAR_OTLP_SPOOL_DIR.trim()) return env.HAR_OTLP_SPOOL_DIR;
  const databaseUrl = env.DATABASE_URL ?? '';
  const match = /^file:(\/[^?]+)/.exec(databaseUrl);
  if (match) return path.join(path.dirname(match[1]), 'otlp-spool');
  return path.join(os.tmpdir(), 'har-control-otlp-spool');
}

let cachedConfig: { path: string; mtimeMs: number; size: number; destinations: TelemetryDestination[] } | null = null;
let warnedInvalidConfig = false;

/** Destinations from the config file, re-read only when it changes. Missing or invalid → none. */
export function loadForwardDestinations(destinationsDir = resolveDestinationsDir()): TelemetryDestination[] {
  const filePath = path.join(destinationsDir, TELEMETRY_DESTINATIONS_FILE);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    cachedConfig = null;
    return [];
  }
  if (cachedConfig && cachedConfig.path === filePath && cachedConfig.mtimeMs === stat.mtimeMs && cachedConfig.size === stat.size) {
    return cachedConfig.destinations;
  }
  let destinations: TelemetryDestination[] = [];
  try {
    const parsed = telemetryDestinationsFileSchema.safeParse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    if (parsed.success) {
      destinations = parsed.data.destinations;
      warnedInvalidConfig = false;
    } else if (!warnedInvalidConfig) {
      warnedInvalidConfig = true;
      console.warn(`[otlp-forward] ignoring invalid ${filePath}`);
    }
  } catch (err) {
    if (!warnedInvalidConfig) {
      warnedInvalidConfig = true;
      console.warn(`[otlp-forward] cannot read ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  cachedConfig = { path: filePath, mtimeMs: stat.mtimeMs, size: stat.size, destinations };
  return destinations;
}

function spoolFiles(spoolDir: string): string[] {
  try {
    return fs
      .readdirSync(spoolDir)
      .filter((name) => name.endsWith(META))
      .sort();
  } catch {
    return [];
  }
}

function removeQuietly(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // already gone
  }
}

function removeEntry(spoolDir: string, metaName: string): void {
  removeQuietly(path.join(spoolDir, metaName));
  removeQuietly(bodyPathFor(spoolDir, metaName));
}

function writeEntry(spoolDir: string, fileName: string, entry: SpoolEntry): void {
  const target = path.join(spoolDir, fileName);
  const tmp = `${target}.${randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/** Drop the oldest entries until the spool fits under the byte cap. */
function enforceSpoolCap(spoolDir: string, maxBytes: number): void {
  const entries = spoolFiles(spoolDir).map((name) => ({
    name,
    size: fileSize(path.join(spoolDir, name)) + fileSize(bodyPathFor(spoolDir, name)),
  }));
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of entries) {
    if (total <= maxBytes) break;
    removeEntry(spoolDir, entry.name);
    total -= entry.size;
  }
}

/** Bodies whose metadata never landed (a crash between the two writes). */
function removeOrphanBodies(spoolDir: string, now: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(spoolDir).filter((name) => name.endsWith(BODY));
  } catch {
    return;
  }
  for (const name of names) {
    const meta = path.join(spoolDir, `${name.slice(0, -BODY.length)}${META}`);
    const bodyPath = path.join(spoolDir, name);
    try {
      if (!fs.existsSync(meta) && now - fs.statSync(bodyPath).mtimeMs > 60_000) removeQuietly(bodyPath);
    } catch {
      // raced with a removal
    }
  }
}

/**
 * Spool one copy of the body per destination subscribed to the signal.
 * Returns how many copies were queued (0 when nothing is configured).
 */
export function enqueueOtlpForward(
  signal: OtlpSignal,
  body: Buffer,
  headers: { contentType: string | null; contentEncoding?: string | null },
  options: OtlpForwardOptions = {},
): number {
  const destinations = destinationsForSignal(
    { version: 1, destinations: loadForwardDestinations(options.destinationsDir) },
    signal,
  );
  if (destinations.length === 0 || body.length === 0) return 0;
  const spoolDir = options.spoolDir ?? resolveSpoolDir();
  const now = (options.now ?? Date.now)();
  fs.mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
  const original: StrippedOtlpBody = {
    body,
    contentType: headers.contentType || 'application/x-protobuf',
    ...(headers.contentEncoding ? { contentEncoding: headers.contentEncoding } : {}),
    removed: 0,
  };
  // One stripped copy per distinct denylist (at most four: paths and identity opt-ins).
  const copies = new Map<string, StrippedOtlpBody | null>();
  let queued = 0;
  for (const destination of destinations) {
    const includesLocalPaths = destinationIncludesLocalPaths(destination);
    const includesAccountIdentity = destinationIncludesAccountIdentity(destination);
    const denied = forwardDeniedAttributes(destination);
    const cacheKey = denied.join('\n');
    if (!copies.has(cacheKey)) {
      const stripped = stripDeniedAttributes(signal, body, original, denied);
      if (stripped === null) {
        console.warn(`[otlp-forward] not forwarding a ${signal} batch: its attributes could not be checked`);
      }
      copies.set(cacheKey, stripped);
    }
    const copy = copies.get(cacheKey);
    if (!copy) continue;
    const entry: SpoolEntry = {
      destination: destination.name,
      signal,
      contentType: copy.contentType,
      ...(copy.contentEncoding ? { contentEncoding: copy.contentEncoding } : {}),
      ...(includesLocalPaths ? { includesLocalPaths: true as const } : {}),
      ...(includesAccountIdentity ? { includesAccountIdentity: true as const } : {}),
      createdAt: now,
      attempts: 0,
      nextAttemptAt: now,
    };
    // Sortable by time, unique per copy. Body first, so metadata never points at nothing.
    const id = `${String(now).padStart(15, '0')}-${randomBytes(6).toString('hex')}`;
    fs.writeFileSync(path.join(spoolDir, `${id}${BODY}`), copy.body, { mode: 0o600 });
    writeEntry(spoolDir, `${id}${META}`, entry);
    queued += 1;
  }
  enforceSpoolCap(spoolDir, options.maxSpoolBytes ?? OTLP_FORWARD_MAX_SPOOL_BYTES);
  return queued;
}

export function backoffMs(attempts: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempts - 1), OTLP_FORWARD_MAX_BACKOFF_MS);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export interface DrainResult {
  sent: number;
  retried: number;
  dropped: number;
  pending: number;
}

/** Send every due spool entry once. Safe to call concurrently (single flight per process). */
export async function drainOtlpSpool(options: OtlpForwardOptions = {}): Promise<DrainResult> {
  const spoolDir = options.spoolDir ?? resolveSpoolDir();
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const maxAge = options.maxAgeMs ?? OTLP_FORWARD_MAX_AGE_MS;
  const maxAttempts = options.maxAttempts ?? OTLP_FORWARD_MAX_ATTEMPTS;
  const destinations = new Map(
    loadForwardDestinations(options.destinationsDir).map((destination) => [destination.name, destination]),
  );
  const result: DrainResult = { sent: 0, retried: 0, dropped: 0, pending: 0 };
  removeOrphanBodies(spoolDir, now());

  for (const name of spoolFiles(spoolDir)) {
    const filePath = path.join(spoolDir, name);
    let entry: SpoolEntry;
    try {
      entry = JSON.parse(fs.readFileSync(filePath, 'utf8')) as SpoolEntry;
    } catch {
      removeEntry(spoolDir, name);
      result.dropped += 1;
      continue;
    }
    const destination = destinations.get(entry.destination);
    // Removed, disabled, no longer subscribed or no longer opted in: the user withdrew it.
    if (
      !destination ||
      !destination.enabled ||
      !destination.signals.includes(entry.signal) ||
      (entry.includesLocalPaths && !destinationIncludesLocalPaths(destination)) ||
      (entry.includesAccountIdentity && !destinationIncludesAccountIdentity(destination)) ||
      now() - entry.createdAt > maxAge
    ) {
      removeEntry(spoolDir, name);
      result.dropped += 1;
      continue;
    }
    if (entry.nextAttemptAt > now()) {
      result.pending += 1;
      continue;
    }
    let body: Buffer;
    try {
      body = fs.readFileSync(bodyPathFor(spoolDir, name));
    } catch {
      removeEntry(spoolDir, name);
      result.dropped += 1;
      continue;
    }

    let status: number | null = null;
    try {
      const response = await fetchImpl(otlpSignalUrl(destination.endpoint, entry.signal), {
        method: 'POST',
        headers: {
          ...destination.headers,
          'content-type': entry.contentType,
          ...(entry.contentEncoding ? { 'content-encoding': entry.contentEncoding } : {}),
        },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      status = response.status;
      await response.arrayBuffer().catch(() => undefined);
    } catch {
      status = null;
    }

    if (status !== null && status >= 200 && status < 300) {
      removeEntry(spoolDir, name);
      result.sent += 1;
      continue;
    }
    const attempts = entry.attempts + 1;
    if ((status !== null && !isRetryableStatus(status)) || attempts >= maxAttempts) {
      console.warn(
        `[otlp-forward] dropped a ${entry.signal} batch for "${destination.name}" after ${attempts} attempt(s) (${status === null ? 'no response' : `HTTP ${status}`})`,
      );
      removeEntry(spoolDir, name);
      result.dropped += 1;
      continue;
    }
    try {
      writeEntry(spoolDir, name, { ...entry, attempts, nextAttemptAt: now() + backoffMs(attempts) });
      result.retried += 1;
    } catch {
      removeEntry(spoolDir, name);
      result.dropped += 1;
    }
  }
  return result;
}

interface ForwarderState {
  draining: Promise<DrainResult> | null;
  timer: ReturnType<typeof setInterval> | null;
}

// One forwarder per server process, surviving dev hot reloads.
const globalForForwarder = globalThis as unknown as { __harOtlpForwarder?: ForwarderState };
const state: ForwarderState = (globalForForwarder.__harOtlpForwarder ??= { draining: null, timer: null });

function drainSoon(): void {
  if (state.draining) return;
  state.draining = drainOtlpSpool()
    .catch((err: unknown) => {
      console.warn(`[otlp-forward] ${err instanceof Error ? err.message : String(err)}`);
      return { sent: 0, retried: 0, dropped: 0, pending: 0 };
    })
    .finally(() => {
      state.draining = null;
    });
  if (!state.timer) {
    state.timer = setInterval(() => {
      if (spoolFiles(resolveSpoolDir()).length > 0) drainSoon();
    }, RETRY_INTERVAL_MS);
    state.timer.unref?.();
  }
}

/**
 * Called by the OTLP receivers after their own handling succeeded. Returns at
 * once; spooling and sending run after the response, and every failure is
 * contained here.
 */
export function scheduleOtlpForward(signal: OtlpSignal, body: Buffer, request: Request): void {
  scheduleOtlpForwardBody(signal, body, {
    contentType: request.headers.get('content-type'),
    contentEncoding: request.headers.get('content-encoding'),
  });
}

/**
 * `scheduleOtlpForward` for a body that did not arrive as an HTTP request (the
 * OTLP/gRPC receiver passes the decoded Export request as OTLP/HTTP protobuf).
 */
export function scheduleOtlpForwardBody(
  signal: OtlpSignal,
  body: Buffer,
  headers: { contentType: string | null; contentEncoding?: string | null },
): void {
  setImmediate(() => {
    try {
      if (enqueueOtlpForward(signal, body, headers) > 0) drainSoon();
    } catch (err) {
      console.warn(`[otlp-forward] ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}
