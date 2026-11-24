import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  LOCAL_ATTR_PREFIX,
  TELEMETRY_LOCAL_PATH_ATTRIBUTES,
  destinationsForSignal,
  forwardDeniedAttributes,
  otlpSignalUrl,
  removeDeniedOtlpAttributes,
  type TelemetryDestination,
} from '../harness/schema';
import { readTelemetryDestinations } from './telemetry-destinations';

/**
 * A small durable spool for the OTLP payloads the CLI sends itself (today:
 * verification traces, when Mission Control is not running).
 *
 * One JSON file per payload and target under `~/.har/spool/traces`, mode 0600.
 * A file holds the target's name, never its URL or header values: those are
 * read from `~/.har/destinations/telemetry.json` when the entry is sent, so a
 * destination removed, disabled or re-keyed in the meantime is honoured.
 * Payloads are stripped before they are written, with the same denylist and
 * the same walk Mission Control's forwarder uses (`forwardDeniedAttributes`,
 * `removeDeniedOtlpAttributes`), and `factory.local.*` is always removed.
 *
 * The spool is bounded like Mission Control's: 64 MB, 24 h, 8 attempts.
 * Flushing is opportunistic (start of `har env verify` / `launch`, and
 * `har telemetry destination flush`), single-file-claimed so two processes never
 * send the same entry, and bounded by a time budget. Every failure is contained.
 */

export const TELEMETRY_SPOOL_DIR_ENV = 'HAR_TELEMETRY_SPOOL_DIR';
export const TELEMETRY_SPOOL_MAX_BYTES = 64 * 1024 * 1024;
export const TELEMETRY_SPOOL_MAX_AGE_MS = 24 * 60 * 60_000;
export const TELEMETRY_SPOOL_MAX_ATTEMPTS = 8;
const MAX_BACKOFF_MS = 5 * 60_000;
const CLAIM_STALE_MS = 10 * 60_000;
const DEFAULT_SEND_TIMEOUT_MS = 3_000;
/** Mission Control route path for OTLP/HTTP traces. */
export const CONTROL_TRACES_PATH = '/api/otel/v1/traces';
/**
 * Request header telling Mission Control to store a payload without forwarding
 * it: the CLI already delivered (or spooled) the destination copies itself.
 */
export const CONTROL_SKIP_FORWARD_HEADER = 'x-har-otlp-forward';
export const CONTROL_SKIP_FORWARD_VALUE = 'skip';

const ENTRY_SUFFIX = '.json';
const CLAIM_MARK = '.claim-';

export type SpoolTarget = { kind: 'destination'; name: string } | { kind: 'control' };

interface SpoolEntry {
  version: 1;
  signal: 'traces';
  target: SpoolTarget;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  /** OTLP/JSON request body, already stripped. */
  payload: unknown;
}

/**
 * The spool directory, or undefined when there is none: under a test runner
 * only an explicit `HAR_TELEMETRY_SPOOL_DIR` counts, so unit tests never queue
 * into (or flush) a developer's real spool.
 */
export function getTelemetrySpoolDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env[TELEMETRY_SPOOL_DIR_ENV];
  if (override && override.trim()) return path.resolve(override);
  if ((env.NODE_ENV ?? process.env.NODE_ENV) === 'test') return undefined;
  return path.join(os.homedir(), '.har', 'spool', 'traces');
}

/** `factory.local.*` plus what this destination does not receive. */
export function deniedForDestination(destination: TelemetryDestination): string[] {
  return [...new Set([...forwardDeniedAttributes(destination), `${LOCAL_ATTR_PREFIX}*`])];
}

/** Denylist of a copy for Mission Control: no local paths on disk. */
export const CONTROL_SPOOL_DENIED: readonly string[] = TELEMETRY_LOCAL_PATH_ATTRIBUTES;

/** Deep copy of an OTLP/JSON payload with the denied attribute keys removed. */
export function strippedOtlpPayload<T>(payload: T, denied: readonly string[]): T {
  const copy = JSON.parse(JSON.stringify(payload)) as T;
  removeDeniedOtlpAttributes(copy, denied);
  return copy;
}

function listEntries(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(ENTRY_SUFFIX))
      .sort();
  } catch {
    return [];
  }
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function removeQuietly(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // already gone
  }
}

function writeAtomic(filePath: string, entry: SpoolEntry): void {
  const tmp = `${filePath}.${randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

/** Drop the oldest entries until the spool fits under the byte cap. */
function enforceCap(dir: string, maxBytes: number): void {
  const entries = listEntries(dir).map((name) => ({ name, size: fileSize(path.join(dir, name)) }));
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of entries) {
    if (total <= maxBytes) break;
    removeQuietly(path.join(dir, entry.name));
    total -= entry.size;
  }
}

export interface SpoolOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  maxBytes?: number;
}

/**
 * Queue one payload for a later attempt. The payload is stripped here (the
 * caller's copy is not modified). Returns false when nothing was written.
 */
export function spoolOtlpPayload(
  target: SpoolTarget,
  payload: unknown,
  denied: readonly string[],
  options: SpoolOptions = {},
): boolean {
  try {
    const dir = getTelemetrySpoolDir(options.env);
    if (!dir) return false;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const now = (options.now ?? Date.now)();
    const entry: SpoolEntry = {
      version: 1,
      signal: 'traces',
      target,
      createdAt: now,
      attempts: 0,
      nextAttemptAt: now,
      payload: strippedOtlpPayload(payload, [...denied, `${LOCAL_ATTR_PREFIX}*`]),
    };
    // Sortable by time, unique per copy.
    const id = `${String(now).padStart(15, '0')}-${randomBytes(6).toString('hex')}`;
    writeAtomic(path.join(dir, `${id}${ENTRY_SUFFIX}`), entry);
    enforceCap(dir, options.maxBytes ?? TELEMETRY_SPOOL_MAX_BYTES);
    return true;
  } catch {
    return false;
  }
}

export interface SpoolFlushResult {
  sent: number;
  retried: number;
  dropped: number;
  /** Entries left for a later flush (not due, budget spent, or Mission Control down). */
  pending: number;
}

export interface SpoolFlushOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Total wall-clock budget; entries left when it runs out stay queued. */
  budgetMs?: number;
  /** At most this many sends in one flush. */
  maxSends?: number;
  maxAgeMs?: number;
  maxAttempts?: number;
  /** Mission Control base URL for `control` entries; none → they stay queued. */
  controlApiUrl?: string;
  /** Health check for Mission Control, run once and only when a `control` entry is due. */
  controlReachable?: () => Promise<boolean>;
}

export function spoolBackoffMs(attempts: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Put claims a crashed process left behind back in the queue. */
function releaseStaleClaims(dir: string, now: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.includes(`${ENTRY_SUFFIX}${CLAIM_MARK}`));
  } catch {
    return;
  }
  for (const name of names) {
    const claimed = path.join(dir, name);
    try {
      if (now - fs.statSync(claimed).mtimeMs < CLAIM_STALE_MS) continue;
      fs.renameSync(claimed, path.join(dir, name.slice(0, name.indexOf(CLAIM_MARK))));
    } catch {
      // raced with another flush
    }
  }
}

async function post(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<number | null> {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
    await response.text().catch(() => '');
    return response.status;
  } catch {
    return null;
  }
}

/**
 * Send due spool entries, oldest first, within a time budget. Never throws.
 * Destination entries go to `<endpoint>/v1/traces` with the destination's
 * current headers; `control` entries go to Mission Control, marked so it
 * stores them without forwarding.
 */
export async function flushTelemetrySpool(options: SpoolFlushOptions = {}): Promise<SpoolFlushResult> {
  const result: SpoolFlushResult = { sent: 0, retried: 0, dropped: 0, pending: 0 };
  try {
    const dir = getTelemetrySpoolDir(options.env);
    if (!dir) return result;
    const now = options.now ?? Date.now;
    const started = now();
    const deadline = started + (options.budgetMs ?? 3_000);
    const maxSends = options.maxSends ?? Number.POSITIVE_INFINITY;
    const maxAge = options.maxAgeMs ?? TELEMETRY_SPOOL_MAX_AGE_MS;
    const maxAttempts = options.maxAttempts ?? TELEMETRY_SPOOL_MAX_ATTEMPTS;
    const fetchImpl = options.fetchImpl ?? fetch;
    releaseStaleClaims(dir, started);
    const names = listEntries(dir);
    if (names.length === 0) return result;

    let destinations: Map<string, TelemetryDestination> | null = null;
    const destinationNamed = (name: string): TelemetryDestination | undefined => {
      if (!destinations) {
        let enabled: TelemetryDestination[] = [];
        try {
          enabled = destinationsForSignal(readTelemetryDestinations(options.env), 'traces');
        } catch {
          // Unreadable config: keep the entries, a later flush may read it.
          return undefined;
        }
        destinations = new Map(enabled.map((destination) => [destination.name, destination]));
      }
      return destinations.get(name);
    };
    let controlUp: boolean | null = null;
    let sends = 0;

    for (const name of names) {
      const filePath = path.join(dir, name);
      if (sends >= maxSends || now() >= deadline) {
        result.pending += 1;
        continue;
      }
      // Claim the entry so a concurrent flush skips it.
      const claim = `${filePath}${CLAIM_MARK}${process.pid}-${randomBytes(3).toString('hex')}`;
      try {
        fs.renameSync(filePath, claim);
      } catch {
        continue;
      }
      const requeue = (entry: SpoolEntry) => {
        try {
          writeAtomic(filePath, entry);
        } finally {
          removeQuietly(claim);
        }
      };

      let entry: SpoolEntry;
      try {
        entry = JSON.parse(fs.readFileSync(claim, 'utf8')) as SpoolEntry;
        if (!entry || entry.version !== 1 || !entry.target) throw new Error('bad entry');
      } catch {
        removeQuietly(claim);
        result.dropped += 1;
        continue;
      }
      if (now() - entry.createdAt > maxAge) {
        removeQuietly(claim);
        result.dropped += 1;
        continue;
      }

      let url: string;
      let headers: Record<string, string>;
      if (entry.target.kind === 'destination') {
        const destination = destinationNamed(entry.target.name);
        if (!destination) {
          if (destinations === null) {
            requeue(entry);
            result.pending += 1;
          } else {
            // Removed, disabled or no longer subscribed to traces: the user withdrew it.
            removeQuietly(claim);
            result.dropped += 1;
          }
          continue;
        }
        url = otlpSignalUrl(destination.endpoint, 'traces');
        headers = { ...destination.headers };
      } else {
        if (!options.controlApiUrl) {
          requeue(entry);
          result.pending += 1;
          continue;
        }
        if (controlUp === null) controlUp = options.controlReachable ? await options.controlReachable() : true;
        if (!controlUp) {
          // Mission Control is not running: not an attempt, wait for it (age cap applies).
          requeue(entry);
          result.pending += 1;
          continue;
        }
        url = `${options.controlApiUrl.replace(/\/+$/, '')}${CONTROL_TRACES_PATH}`;
        headers = { [CONTROL_SKIP_FORWARD_HEADER]: CONTROL_SKIP_FORWARD_VALUE };
      }

      if (entry.nextAttemptAt > now()) {
        requeue(entry);
        result.pending += 1;
        continue;
      }

      sends += 1;
      const timeoutMs = Math.min(DEFAULT_SEND_TIMEOUT_MS, Math.max(1, deadline - now()));
      const status = await post(fetchImpl, url, headers, JSON.stringify(entry.payload), timeoutMs);
      if (status !== null && status >= 200 && status < 300) {
        removeQuietly(claim);
        result.sent += 1;
        continue;
      }
      const attempts = entry.attempts + 1;
      if ((status !== null && !isRetryableStatus(status)) || attempts >= maxAttempts) {
        removeQuietly(claim);
        result.dropped += 1;
        continue;
      }
      try {
        requeue({ ...entry, attempts, nextAttemptAt: now() + spoolBackoffMs(attempts) });
        result.retried += 1;
      } catch {
        result.dropped += 1;
      }
    }
  } catch {
    // fail-open
  }
  return result;
}

/** Entries currently queued (for `har telemetry destination flush`). */
export function countSpooledPayloads(env: NodeJS.ProcessEnv = process.env): number {
  const dir = getTelemetrySpoolDir(env);
  return dir ? listEntries(dir).length : 0;
}
