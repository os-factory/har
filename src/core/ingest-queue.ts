import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  INGEST_V2_EVIDENCE_DIGEST_MISMATCH_STATUSES,
  INGEST_V2_PATHS,
  IngestV2CapabilitiesSchema,
  IngestV2EvidenceMissingResponseSchema,
  ingestUrl,
  ingestV2EvidencePath,
  type HarDestination,
  type IngestV2Capabilities,
  type IngestV2ProofsBody,
  type IngestV2RecordsBody,
} from '../harness/schema';
import {
  destinationIngestBaseUrl,
  readDestinations,
  resolveDestinationHeaders,
} from './telemetry-destinations';

/**
 * One durable retry queue per destination for what the CLI sends to ingest v2
 * receivers (ADR 0005 sections 2, 4 and 6): record batches (`POST v2/records`),
 * proofs (`POST v2/proofs`) and evidence (`POST v2/evidence/missing`, then
 * `PUT v2/evidence/<sha256>` for each file the receiver lacks).
 *
 * Layout: `~/.har/queue/<destination>/` (mode 0700), override `HAR_INGEST_QUEUE_DIR`:
 *
 * - `<ms>-<seq>-<key>.json` — one entry per send, in send order (FIFO per
 *   destination: a FactoryRun goes before its StageResults);
 * - `blobs/<sha256>` — the evidence bytes, copied in when the entry is queued,
 *   so a slot work dir deleted by teardown loses nothing;
 * - `dead/` — entries a receiver rejected (HTTP 400/413/422) or that expired,
 *   kept for inspection;
 * - `state.json` — last success, last error, last capability check.
 *
 * An entry is deleted once the receiver answered 2xx, so a drain sends it
 * exactly once more at most; receivers upsert by natural key, so a resend
 * after a lost reply is a no-op. A failure never throws: queueing and draining
 * are fail-open and bounded by a time budget, so verify, commit and teardown
 * never wait on a receiver.
 */

export const INGEST_QUEUE_DIR_ENV = 'HAR_INGEST_QUEUE_DIR';
/** Entries older than this are moved to `dead/` without another attempt. */
export const INGEST_QUEUE_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
/** Evidence bytes kept per destination; new evidence is refused beyond it. */
export const INGEST_QUEUE_MAX_BLOB_BYTES = 512 * 1024 * 1024;
const MAX_BACKOFF_MS = 15 * 60_000;
const LOCK_STALE_MS = 2 * 60_000;
const DEFAULT_SEND_TIMEOUT_MS = 5_000;
const ENTRY_SUFFIX = '.json';
const STATE_FILE = 'state.json';
const BLOBS_DIR = 'blobs';
const DEAD_DIR = 'dead';
const LOCK_DIR = '.lock';

export const INGEST_QUEUE_KINDS = ['records', 'proofs', 'evidence'] as const;
export type IngestQueueKind = (typeof INGEST_QUEUE_KINDS)[number];

export interface EvidenceFileRef {
  sha256: string;
  size: number;
  mediaType: string;
}

export interface EvidenceQueueBody {
  files: EvidenceFileRef[];
}

export type IngestQueueBody = IngestV2RecordsBody | IngestV2ProofsBody | EvidenceQueueBody;

export interface IngestQueueEntry {
  version: 1;
  kind: IngestQueueKind;
  /** sha256 of the kind and body: the same send queued twice is one entry. */
  key: string;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastFailureAt?: number;
  /** `HTTP 503`, `ECONNREFUSED`, … — never a URL, header or response body. */
  lastError?: string;
  body: IngestQueueBody;
}

export interface IngestQueueState {
  lastSuccessAt?: number;
  lastAttemptAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  /** Last `GET v2/capabilities` (doctor). */
  capabilities?: { checkedAt: number; ok: boolean; detail: string };
}

/**
 * The queue root, or undefined when there is none: under a test runner only an
 * explicit `HAR_INGEST_QUEUE_DIR` counts, so unit tests never queue into (or
 * drain) a developer's real queue.
 */
export function getIngestQueueRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env[INGEST_QUEUE_DIR_ENV];
  if (override && override.trim()) return path.resolve(override);
  if ((env.NODE_ENV ?? process.env.NODE_ENV) === 'test') return undefined;
  return path.join(os.homedir(), '.har', 'queue');
}

function destinationDir(root: string, name: string): string {
  return path.join(root, name);
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function entryKey(kind: IngestQueueKind, body: IngestQueueBody): string {
  return sha256Hex(`${kind}\n${JSON.stringify(body)}`);
}

function listEntryNames(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(ENTRY_SUFFIX) && name !== STATE_FILE)
      .sort();
  } catch {
    return [];
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function readIngestQueueState(root: string, name: string): IngestQueueState {
  return readJson<IngestQueueState>(path.join(destinationDir(root, name), STATE_FILE)) ?? {};
}

function updateState(root: string, name: string, patch: Partial<IngestQueueState>): void {
  try {
    const dir = destinationDir(root, name);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeJsonAtomic(path.join(dir, STATE_FILE), { ...readIngestQueueState(root, name), ...patch });
  } catch {
    // status only
  }
}

function blobBytes(dir: string): number {
  try {
    return fs
      .readdirSync(path.join(dir, BLOBS_DIR))
      .reduce((sum, name) => sum + fs.statSync(path.join(dir, BLOBS_DIR, name)).size, 0);
  } catch {
    return 0;
  }
}

let sequence = 0;

export interface EnqueueOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** For `evidence`: where each file's bytes are now. Copied into the queue. */
  sources?: ReadonlyMap<string, string>;
  maxBlobBytes?: number;
}

/**
 * Queue one send for a destination. Evidence bytes are copied into the queue
 * (and checked against their digest) before the entry is written; a file that
 * is gone or changed is left out. Returns false when nothing was queued.
 */
export function enqueueIngest(
  destination: string,
  kind: IngestQueueKind,
  body: IngestQueueBody,
  options: EnqueueOptions = {},
): boolean {
  try {
    const root = getIngestQueueRoot(options.env);
    if (!root) return false;
    const dir = destinationDir(root, destination);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let queuedBody = body;
    if (kind === 'evidence') {
      const files = copyEvidenceIntoQueue(dir, (body as EvidenceQueueBody).files, options);
      if (files.length === 0) return false;
      queuedBody = { files };
    }
    const key = entryKey(kind, queuedBody);
    // The same send already waiting: one entry is enough.
    if (listEntryNames(dir).some((name) => name.endsWith(`-${key.slice(0, 16)}${ENTRY_SUFFIX}`))) return true;
    const now = (options.now ?? Date.now)();
    const entry: IngestQueueEntry = { version: 1, kind, key, createdAt: now, attempts: 0, nextAttemptAt: now, body: queuedBody };
    sequence = (sequence + 1) % 10_000;
    const name = `${String(now).padStart(15, '0')}-${String(process.pid % 100_000).padStart(5, '0')}${String(sequence).padStart(4, '0')}-${key.slice(0, 16)}${ENTRY_SUFFIX}`;
    writeJsonAtomic(path.join(dir, name), entry);
    return true;
  } catch {
    return false;
  }
}

function copyEvidenceIntoQueue(
  dir: string,
  files: readonly EvidenceFileRef[],
  options: EnqueueOptions,
): EvidenceFileRef[] {
  const blobs = path.join(dir, BLOBS_DIR);
  fs.mkdirSync(blobs, { recursive: true, mode: 0o700 });
  const cap = options.maxBlobBytes ?? INGEST_QUEUE_MAX_BLOB_BYTES;
  let used = blobBytes(dir);
  const kept: EvidenceFileRef[] = [];
  for (const file of files) {
    const target = path.join(blobs, file.sha256);
    if (fs.existsSync(target)) {
      kept.push(file);
      continue;
    }
    const source = options.sources?.get(file.sha256);
    if (!source) continue;
    if (used + file.size > cap) continue;
    try {
      const bytes = fs.readFileSync(source);
      // The file changed since it was hashed: its digest is in the proof, these bytes are not.
      if (sha256Hex(bytes) !== file.sha256) continue;
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, bytes, { mode: 0o600 });
      fs.renameSync(tmp, target);
      used += bytes.length;
      kept.push(file);
    } catch {
      // unreadable: left out
    }
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** A receiver resolved for one send: where, and with which headers (secrets included). */
export interface IngestReceiver {
  name: string;
  baseUrl: string;
  headers: Record<string, string>;
}

type SendOutcome = { result: 'ok' } | { result: 'retry'; error: string } | { result: 'reject'; error: string };

function fetchErrorCode(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout';
    const cause = (err as Error & { cause?: { code?: unknown; errors?: Array<{ code?: unknown }> } }).cause;
    if (cause && typeof cause.code === 'string') return cause.code;
    const nested = cause?.errors?.find((inner) => typeof inner?.code === 'string')?.code;
    if (typeof nested === 'string') return nested;
    const named = /\bE[A-Z]{3,}\b/.exec(err.message);
    return named ? named[0] : err.name;
  }
  return 'error';
}

/** What an HTTP status means for a queued send. */
export function classifyIngestStatus(status: number): SendOutcome {
  if (status >= 200 && status < 300) return { result: 'ok' };
  if (status === 404 || status === 405 || status === 501) {
    return { result: 'retry', error: `receiver has no ingest v2 (HTTP ${status})` };
  }
  if (status === 401 || status === 403) return { result: 'retry', error: `ingest key rejected (HTTP ${status})` };
  if (status === 408 || status === 429 || status >= 500) return { result: 'retry', error: `HTTP ${status}` };
  return { result: 'reject', error: `rejected (HTTP ${status})` };
}

async function request(
  fetchImpl: typeof fetch,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string | Buffer },
  timeoutMs: number,
): Promise<{ status?: number; text?: string; error?: string }> {
  try {
    const response = await fetchImpl(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body as unknown as string } : {}),
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
    const text = await response.text().catch(() => '');
    return { status: response.status, text };
  } catch (err) {
    return { error: fetchErrorCode(err) };
  }
}

async function postJson(
  fetchImpl: typeof fetch,
  receiver: IngestReceiver,
  relativePath: string,
  body: unknown,
  timeoutMs: number,
): Promise<SendOutcome & { text?: string }> {
  const reply = await request(
    fetchImpl,
    ingestUrl(receiver.baseUrl, relativePath),
    { method: 'POST', headers: { ...receiver.headers, 'content-type': 'application/json' }, body: JSON.stringify(body) },
    timeoutMs,
  );
  if (reply.status === undefined) return { result: 'retry', error: reply.error ?? 'error' };
  return { ...classifyIngestStatus(reply.status), text: reply.text };
}

function resolveUploadUrl(baseUrl: string, uploadUrl: string): string {
  return /^https?:\/\//i.test(uploadUrl) ? uploadUrl : ingestUrl(baseUrl, uploadUrl);
}

async function sendEvidence(
  fetchImpl: typeof fetch,
  receiver: IngestReceiver,
  dir: string,
  body: EvidenceQueueBody,
  deadline: number,
): Promise<SendOutcome> {
  const timeout = () => Math.min(DEFAULT_SEND_TIMEOUT_MS, Math.max(1, deadline - Date.now()));
  const asked = await postJson(
    fetchImpl,
    receiver,
    INGEST_V2_PATHS.evidenceMissing,
    { digests: body.files.map((file) => file.sha256) },
    timeout(),
  );
  if (asked.result !== 'ok') return asked;
  let parsed;
  try {
    parsed = IngestV2EvidenceMissingResponseSchema.parse(JSON.parse(asked.text ?? ''));
  } catch {
    return { result: 'retry', error: 'invalid evidence/missing reply' };
  }
  const byDigest = new Map(body.files.map((file) => [file.sha256, file]));
  for (const missing of parsed.missing) {
    const file = byDigest.get(missing.sha256);
    if (!file) continue;
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(path.join(dir, BLOBS_DIR, file.sha256));
    } catch {
      continue; // nothing left to send for this digest
    }
    const reply = await request(
      fetchImpl,
      resolveUploadUrl(receiver.baseUrl, missing.uploadUrl || ingestV2EvidencePath(file.sha256)),
      { method: 'PUT', headers: { ...receiver.headers, 'content-type': file.mediaType }, body: bytes },
      timeout(),
    );
    if (reply.status === undefined) return { result: 'retry', error: reply.error ?? 'error' };
    if ((INGEST_V2_EVIDENCE_DIGEST_MISMATCH_STATUSES as readonly number[]).includes(reply.status)) {
      return { result: 'reject', error: `evidence rejected (HTTP ${reply.status})` };
    }
    const outcome = classifyIngestStatus(reply.status);
    if (outcome.result !== 'ok') return outcome;
  }
  return { result: 'ok' };
}

async function sendEntry(
  fetchImpl: typeof fetch,
  receiver: IngestReceiver,
  dir: string,
  entry: IngestQueueEntry,
  deadline: number,
): Promise<SendOutcome> {
  const timeoutMs = Math.min(DEFAULT_SEND_TIMEOUT_MS, Math.max(1, deadline - Date.now()));
  if (entry.kind === 'records') return postJson(fetchImpl, receiver, INGEST_V2_PATHS.records, entry.body, timeoutMs);
  if (entry.kind === 'proofs') return postJson(fetchImpl, receiver, INGEST_V2_PATHS.proofs, entry.body, timeoutMs);
  return sendEvidence(fetchImpl, receiver, dir, entry.body as EvidenceQueueBody, deadline);
}

export function ingestBackoffMs(attempts: number): number {
  return Math.min(2000 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

function acquireLock(dir: string, now: number): (() => void) | undefined {
  const lock = path.join(dir, LOCK_DIR);
  try {
    fs.mkdirSync(lock);
  } catch {
    try {
      if (now - fs.statSync(lock).mtimeMs < LOCK_STALE_MS) return undefined;
      fs.rmSync(lock, { recursive: true, force: true });
      fs.mkdirSync(lock);
    } catch {
      return undefined;
    }
  }
  return () => {
    try {
      fs.rmSync(lock, { recursive: true, force: true });
    } catch {
      // released by staleness
    }
  };
}

function moveToDead(dir: string, name: string, entry: IngestQueueEntry, reason: string): void {
  try {
    const dead = path.join(dir, DEAD_DIR);
    fs.mkdirSync(dead, { recursive: true, mode: 0o700 });
    writeJsonAtomic(path.join(dead, name), { ...entry, lastError: reason });
    fs.rmSync(path.join(dir, name), { force: true });
  } catch {
    // stays queued
  }
}

/** Remove blobs no queued evidence entry refers to any more. */
function collectBlobs(dir: string): void {
  let blobs: string[];
  try {
    blobs = fs.readdirSync(path.join(dir, BLOBS_DIR)).filter((name) => /^[0-9a-f]{64}$/.test(name));
  } catch {
    return;
  }
  if (blobs.length === 0) return;
  const referenced = new Set<string>();
  for (const name of listEntryNames(dir)) {
    const entry = readJson<IngestQueueEntry>(path.join(dir, name));
    if (entry?.kind === 'evidence') for (const file of (entry.body as EvidenceQueueBody).files) referenced.add(file.sha256);
  }
  for (const blob of blobs) {
    if (!referenced.has(blob)) fs.rmSync(path.join(dir, BLOBS_DIR, blob), { force: true });
  }
}

export interface DrainResult {
  sent: number;
  retried: number;
  dead: number;
  /** Entries still queued after the drain. */
  pending: number;
}

export interface DrainOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Total wall-clock budget across destinations. */
  budgetMs?: number;
  /** Only these destinations (default: every queue on disk). */
  destinations?: readonly string[];
  maxAgeMs?: number;
  /** Resolve a queue's receiver (tests). Default: from the destination list. */
  resolveReceiver?: (name: string) => IngestReceiver | 'withdrawn' | { error: string };
}

/**
 * The receiver a queue sends to now, from the destination list: withdrawn
 * when the entry was removed, disabled, or is not an ingest receiver; an error
 * when it cannot be sent to yet (no key, Mission Control disabled).
 */
export function resolveQueueReceiver(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  destinations?: readonly HarDestination[],
): IngestReceiver | 'withdrawn' | { error: string } {
  let list: readonly HarDestination[];
  try {
    list = destinations ?? readDestinations(env).destinations;
  } catch {
    return { error: 'destination list unreadable' };
  }
  const destination = list.find((entry) => entry.name === name);
  if (!destination || !destination.enabled || !(destination.records || destination.proofs || destination.evidence)) {
    return 'withdrawn';
  }
  if (destination.preset === 'mission-control' && env.HAR_CONTROL_DISABLED === 'true') return 'withdrawn';
  const baseUrl = destinationIngestBaseUrl(destination);
  if (!baseUrl) return 'withdrawn';
  const headers = resolveDestinationHeaders(destination, env);
  if (!headers) return { error: 'no ingest key (set HAR_PORTAL_TOKEN or run har hq connect)' };
  return { name, baseUrl, headers };
}

/** Destination names with a queue directory. */
export function listIngestQueues(env: NodeJS.ProcessEnv = process.env): string[] {
  const root = getIngestQueueRoot(env);
  if (!root) return [];
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Send what is due, oldest first, destination by destination, within a time
 * budget. A destination stops at its first failed send (later entries depend
 * on earlier ones) and waits for its backoff. Never throws.
 */
export async function drainIngestQueues(options: DrainOptions = {}): Promise<DrainResult> {
  const result: DrainResult = { sent: 0, retried: 0, dead: 0, pending: 0 };
  try {
    const root = getIngestQueueRoot(options.env);
    if (!root) return result;
    const env = options.env ?? process.env;
    const now = options.now ?? Date.now;
    const deadline = now() + (options.budgetMs ?? 3_000);
    const fetchImpl = options.fetchImpl ?? fetch;
    const maxAge = options.maxAgeMs ?? INGEST_QUEUE_MAX_AGE_MS;
    const names = options.destinations ?? listIngestQueues(env);
    let destinations: HarDestination[] | undefined;
    const resolve =
      options.resolveReceiver ??
      ((name: string) => {
        if (!destinations) {
          try {
            destinations = readDestinations(env).destinations;
          } catch {
            return { error: 'destination list unreadable' };
          }
        }
        return resolveQueueReceiver(name, env, destinations);
      });

    for (const name of names) {
      const dir = destinationDir(root, name);
      const entries = listEntryNames(dir);
      if (entries.length === 0) continue;
      const receiver = resolve(name);
      if (receiver === 'withdrawn') {
        // The user removed or disabled it: nothing more goes there.
        for (const entryName of entries) {
          const entry = readJson<IngestQueueEntry>(path.join(dir, entryName));
          if (entry) moveToDead(dir, entryName, entry, 'destination withdrawn');
          result.dead += 1;
        }
        collectBlobs(dir);
        continue;
      }
      if ('error' in receiver) {
        updateState(root, name, { lastErrorAt: now(), lastError: receiver.error });
        result.pending += entries.length;
        continue;
      }
      const release = acquireLock(dir, now());
      if (!release) {
        result.pending += entries.length;
        continue;
      }
      try {
        let stopped = false;
        for (const entryName of listEntryNames(dir)) {
          if (stopped || now() >= deadline) {
            result.pending += 1;
            continue;
          }
          const file = path.join(dir, entryName);
          const entry = readJson<IngestQueueEntry>(file);
          if (!entry || entry.version !== 1) {
            fs.rmSync(file, { force: true });
            result.dead += 1;
            continue;
          }
          if (now() - entry.createdAt > maxAge) {
            moveToDead(dir, entryName, entry, 'expired');
            result.dead += 1;
            continue;
          }
          if (entry.nextAttemptAt > now()) {
            stopped = true;
            result.pending += 1;
            continue;
          }
          const outcome = await sendEntry(fetchImpl, receiver, dir, entry, deadline);
          updateState(root, name, { lastAttemptAt: now() });
          if (outcome.result === 'ok') {
            fs.rmSync(file, { force: true });
            updateState(root, name, { lastSuccessAt: now() });
            result.sent += 1;
            continue;
          }
          updateState(root, name, { lastErrorAt: now(), lastError: outcome.error });
          if (outcome.result === 'reject') {
            moveToDead(dir, entryName, entry, outcome.error);
            result.dead += 1;
            continue;
          }
          const attempts = entry.attempts + 1;
          writeJsonAtomic(file, {
            ...entry,
            attempts,
            nextAttemptAt: now() + ingestBackoffMs(attempts),
            lastFailureAt: now(),
            lastError: outcome.error,
          });
          result.retried += 1;
          stopped = true;
        }
        collectBlobs(dir);
      } finally {
        release();
      }
    }
  } catch {
    // fail-open
  }
  return result;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface IngestQueueSummary {
  destination: string;
  /** Entries queued, by kind. */
  queued: Record<IngestQueueKind, number>;
  depth: number;
  bytes: number;
  dead: number;
  oldestCreatedAt?: number;
  nextAttemptAt?: number;
  lastSuccessAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  capabilities?: IngestQueueState['capabilities'];
}

/** Per-destination queue depth and last outcome, for `har telemetry status` and `har env doctor`. Never sends. */
export function summarizeIngestQueues(env: NodeJS.ProcessEnv = process.env): IngestQueueSummary[] {
  const root = getIngestQueueRoot(env);
  if (!root) return [];
  return listIngestQueues(env).map((name) => summarizeIngestQueue(root, name));
}

export function summarizeIngestQueue(root: string, name: string): IngestQueueSummary {
  const dir = destinationDir(root, name);
  const state = readIngestQueueState(root, name);
  const summary: IngestQueueSummary = {
    destination: name,
    queued: { records: 0, proofs: 0, evidence: 0 },
    depth: 0,
    bytes: blobBytes(dir),
    dead: listEntryNames(path.join(dir, DEAD_DIR)).length,
    ...(state.lastSuccessAt ? { lastSuccessAt: state.lastSuccessAt } : {}),
    ...(state.lastErrorAt ? { lastErrorAt: state.lastErrorAt } : {}),
    ...(state.lastError ? { lastError: state.lastError } : {}),
    ...(state.capabilities ? { capabilities: state.capabilities } : {}),
  };
  for (const entryName of listEntryNames(dir)) {
    const file = path.join(dir, entryName);
    const entry = readJson<IngestQueueEntry>(file);
    summary.depth += 1;
    try {
      summary.bytes += fs.statSync(file).size;
    } catch {
      // gone meanwhile
    }
    if (!entry) continue;
    if ((INGEST_QUEUE_KINDS as readonly string[]).includes(entry.kind)) summary.queued[entry.kind] += 1;
    summary.oldestCreatedAt = Math.min(summary.oldestCreatedAt ?? entry.createdAt, entry.createdAt);
    if (summary.nextAttemptAt === undefined) summary.nextAttemptAt = entry.nextAttemptAt;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Capabilities (doctor)
// ---------------------------------------------------------------------------

export interface CapabilitiesCheck {
  destination: string;
  ok: boolean;
  /** The receiver answered with an ingest v2 capabilities document. */
  v2: boolean;
  status: number | null;
  capabilities?: IngestV2Capabilities;
  /** One line, never a header value. */
  detail: string;
}

/** `GET v2/capabilities` of a receiver, remembered in its queue state. Never throws. */
export async function checkReceiverCapabilities(
  receiver: IngestReceiver,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; env?: NodeJS.ProcessEnv; now?: () => number } = {},
): Promise<CapabilitiesCheck> {
  const reply = await request(
    options.fetchImpl ?? fetch,
    ingestUrl(receiver.baseUrl, INGEST_V2_PATHS.capabilities),
    { method: 'GET', headers: { ...receiver.headers, accept: 'application/json' } },
    options.timeoutMs ?? 3_000,
  );
  let check: CapabilitiesCheck;
  if (reply.status === undefined) {
    check = { destination: receiver.name, ok: false, v2: false, status: null, detail: `not reachable (${reply.error})` };
  } else if (reply.status === 404 || reply.status === 405 || reply.status === 501) {
    check = {
      destination: receiver.name,
      ok: false,
      v2: false,
      status: reply.status,
      detail: `does not support ingest v2 (GET v2/capabilities: HTTP ${reply.status}) — upgrade the receiver`,
    };
  } else if (reply.status < 200 || reply.status >= 300) {
    const outcome = classifyIngestStatus(reply.status);
    check = {
      destination: receiver.name,
      ok: false,
      v2: false,
      status: reply.status,
      detail: 'error' in outcome ? outcome.error : `HTTP ${reply.status}`,
    };
  } else {
    let parsed: IngestV2Capabilities | undefined;
    try {
      parsed = IngestV2CapabilitiesSchema.parse(JSON.parse(reply.text ?? ''));
    } catch {
      parsed = undefined;
    }
    check = parsed
      ? {
          destination: receiver.name,
          ok: true,
          v2: true,
          status: reply.status,
          capabilities: parsed,
          detail: `ingest v2 (records: ${parsed.recordTypes.length}, proofs: ${parsed.proofs ? 'yes' : 'no'}, evidence: ${parsed.evidence ? 'yes' : 'no'}, signals: ${parsed.signals.join(', ') || 'none'})`,
        }
      : {
          destination: receiver.name,
          ok: false,
          v2: false,
          status: reply.status,
          detail: 'answered GET v2/capabilities without an ingest v2 capabilities document — upgrade the receiver',
        };
  }
  const root = getIngestQueueRoot(options.env);
  if (root) {
    updateState(root, receiver.name, {
      capabilities: { checkedAt: (options.now ?? Date.now)(), ok: check.ok, detail: check.detail },
    });
  }
  return check;
}

/** Budget of the drain every `har` command runs before it exits. */
export const OPPORTUNISTIC_DRAIN_BUDGET_MS = 1_500;

/**
 * The drain each `har` command runs on its way out: whatever is due, within a
 * short budget; entries waiting for their backoff cost nothing. Never throws.
 */
export async function drainDueIngestQueues(options: DrainOptions = {}): Promise<DrainResult | undefined> {
  try {
    const env = options.env ?? process.env;
    if (!getIngestQueueRoot(env)) return undefined;
    const now = (options.now ?? Date.now)();
    const due = listIngestQueues(env).filter((name) => {
      const summary = summarizeIngestQueue(getIngestQueueRoot(env) as string, name);
      return summary.depth > 0 && (summary.nextAttemptAt ?? 0) <= now;
    });
    if (due.length === 0) return undefined;
    return await drainIngestQueues({ budgetMs: OPPORTUNISTIC_DRAIN_BUDGET_MS, ...options, destinations: due });
  } catch {
    return undefined;
  }
}
