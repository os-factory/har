import * as path from 'path';
import { readManifest, resolveHarnessRoot } from '../harness/manifest';
import { readStageRegistry } from '../harness/stages';
import {
  AgentSlotStatus,
  EnvironmentStatus,
  RegisterRepoInput,
  RunRecord,
  SyncRunsInputSchema,
  SyncSlotsInputSchema,
  SyncWorkUnitsInputSchema,
  SyncValidationBindingsInputSchema,
  SyncValidationCommitBindingsInputSchema,
  SyncSessionEventsInputSchema,
  SyncSessionBindingsInputSchema,
  SyncUsageInputSchema,
  SyncUsageObservationsInputSchema,
  SyncValidationsInputSchema,
} from '../harness/schema';
import {
  getControlApiUrl,
  isControlEnabled,
  PortalTarget,
} from './control-config';
import { isPortalApiKey, KERNO_INGEST_PREFIX, kernoApiUrlFor } from './portal-hosts';
import {
  isRepoPortalSyncEnabled,
  listRegisteredRepos,
  recordRepoForControlSync,
  removeRegisteredRepo,
} from './control-registry';
import { readPortalCredentials } from './portal-credentials';
import {
  isPortalTargetActive,
  isPortalTrajectoryEnabledForTarget,
  resolvePortalTarget,
  updatePortalTargetTokens,
} from './portal-targets';
import { canonicalizeControlRepoPath } from './control-repo-path';
import {
  collectRunsBySource,
  collectRunsForSync,
  mergeRunsBySource,
  RunsBySource,
  collectCommitBindingsForSync,
  collectValidationBindingsForSync,
  collectValidationsForSync,
  collectWorkUnitsForSync,
  mergeSlotStatuses,
  resolveSyncSourcePaths,
  selectRunsForSync,
  collectLineGateRunsForSync,
  collectLinesForSync,
  hasLineLedger,
} from './sync-sources';
import { collectEnvironmentStatus } from './slot-status';
import { listValidations } from './validations';
import {
  listValidationBindings,
} from './work-units';
import { createRemoteExecutor } from './cloud-executor';
import { getTelemetryLevel, getTelemetrySignals, isTelemetryEnabled } from './telemetry-config';
import { getHarPackageVersion } from './package-version';
import { warn } from '../utils/logging';
import { harvestEventsForSlot, harvestUsageForSlot, omitHarvestEventsWhenOtelPresent, omitHarvestWhenOtelPresent } from './usage-harvest';
import {
  collectSessionAttribution,
  parseRemoteSessionBindings,
  type AttributionSlot,
} from './session-attribution-sync';
import { buildSessionKey } from './telemetry-env';
import { fetchPersistedPortalTelemetry } from './control-persisted-usage';
import {
  chunkBySerializedSize,
  maxSyncBatchBytes,
  maxSyncBatchRows,
  packSyncBodies,
  type SyncUnit,
} from './sync-batches';
import type { ChannelReadFailure } from './control-api-read';
import { fetchPersistedTrajectory } from './control-persisted-trajectory';
import { dedupePortalEvents, mergePortalUsage } from './portal-usage-merge';
import { enrichUsageWithPricing } from '../harness/schema';
import {
  readPortalWatermark,
  writePortalWatermark,
  coveredSources,
  readRunsWatermarkEntry,
  writeRunsWatermark,
  selectSince,
} from './portal-watermark';
import type { AgentSessionEvent, AgentSessionUsage } from '../harness/schema';
import {
  isRetryableStatus,
  retryDelayMs,
  runWithDeadline,
  SyncDeadlineError,
  syncFetch,
  throwIfSyncAborted,
} from './sync-request';
import { readSyncSelection, resolveSyncSelection } from './control-sync-selection';
import {
  describeHeldUsage,
  fetchUsageInvariantReport,
  heldUnitsForRepo,
  partitionHeldUsage,
  type HeldUsageUnits,
} from './usage-invariants-check';
import { recordSentObservations, unsentObservations } from './observation-ledger';
import { snapshotMemo, withStatusSnapshot } from './status-snapshot';

export { chunkBySerializedSize };

export interface ControlSyncOptions {
  repoPath: string;
  apiUrl?: string;
  dryRun?: boolean;
  cloud?: boolean;
  /** Re-register even if the path was previously unregistered. */
  force?: boolean;
  /** Ignore the portal watermark and resend the complete persisted payload. */
  full?: boolean;
}

export interface SyncRepoResult {
  repoPath: string;
  ok: boolean;
  error?: string;
  warnings?: string[];
}

export interface ControlRegisterOptions extends ControlSyncOptions {
  gitRemote?: string;
}

function runTimestamp(run: RunRecord): string {
  return run.finishedAt ?? run.startedAt;
}

// Re-send a small window past the watermark so a same-ms sibling or a backward
// clock step isn't dropped (the resend is an idempotent upsert).
const DEFAULT_SYNC_OVERLAP_MS = 60_000;

function rewindSince(since: string | null): string | null {
  if (!since) return null;
  const raw = Number(process.env.HAR_SYNC_OVERLAP_MS);
  const overlap = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_SYNC_OVERLAP_MS;
  return new Date(new Date(since).getTime() - overlap).toISOString();
}

function watermarkKeyForTarget(target: PortalTarget): string {
  const apiUrl = kernoApiUrlFor(target.url);
  return apiUrl ? `${apiUrl}|${target.identityKey}` : target.identityKey;
}

function legacyWatermarkKeysForTarget(target: PortalTarget): string[] {
  return target.url === target.identityKey ? [] : [target.url];
}

function readScopedPortalWatermark(
  repoPath: string,
  scopedKey: string,
  legacyScopedKeys: string[] = [],
): string | null {
  const direct = readPortalWatermark(repoPath, scopedKey);
  if (direct) return direct;
  for (const legacyKey of legacyScopedKeys) {
    const legacy = readPortalWatermark(repoPath, legacyKey);
    if (legacy) return legacy;
  }
  return null;
}

function legacyScopedWatermarkKeys(portal: PortalTarget, prefix: string): string[] {
  if (portal.url === portal.identityKey) return [];
  return [`${prefix}:${portal.url}`];
}

function runsWatermarkTargetForPortal(target: PortalTarget): string {
  return runsWatermarkTarget(watermarkKeyForTarget(target));
}

function readPortalWatermarkForTarget(repoPath: string, target: PortalTarget): string | null {
  return readScopedPortalWatermark(
    repoPath,
    watermarkKeyForTarget(target),
    legacyWatermarkKeysForTarget(target),
  );
}

function trajectoryWatermarkTarget(target: PortalTarget): string {
  return `trajectory:${watermarkKeyForTarget(target)}`;
}

function spansWatermarkTarget(target: PortalTarget): string {
  return `spans:${watermarkKeyForTarget(target)}`;
}

function runsWatermarkTarget(target: string): string {
  return `runs:${target}`;
}

/** Send run batches oldest-first, advancing the watermark (with the server repo
 * id) after each lands — so a sync killed mid-flight resumes, and a wiped repo
 * invalidates it. */
async function syncRunBatches(
  newRuns: RunRecord[],
  repoPath: string,
  runsTarget: string,
  getRepoId: () => string | undefined,
  dryRun: boolean | undefined,
  send: (batch: RunRecord[], index: number) => Promise<void>,
  sources?: string[],
): Promise<void> {
  const ordered = [...newRuns].sort((a, b) => runTimestamp(a).localeCompare(runTimestamp(b)));
  const batches = chunkBySerializedSize(ordered, maxSyncBatchBytes());
  const toSend = batches.length > 0 ? batches : [[]];
  for (let i = 0; i < toSend.length; i++) {
    const batch = toSend[i];
    await send(batch, i);
    if (!dryRun && batch.length > 0) {
      writeRunsWatermark(
        repoPath,
        runsTarget,
        getRepoId(),
        runTimestamp(batch[batch.length - 1]),
        sources,
      );
    }
  }
}

function describeFetchFailure(url: string, bodyBytes: number, err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code ? ` [${cause.code}]` : '';
  const detail = cause?.message && cause.message !== base ? `: ${cause.message}` : '';
  const size = bodyBytes > 0 ? ` (request body ${(bodyBytes / 1024 / 1024).toFixed(2)} MB)` : '';
  return `${base}${code}${detail}${size} — POST ${url}`;
}

const MAX_FETCH_ATTEMPTS = 3;

async function postForResponse(
  url: string,
  headers: Record<string, string>,
  payload: string,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    // Every sync POST is an idempotent upsert, so a fresh attempt is safe.
    let response: Response | undefined;
    try {
      response = await syncFetch(url, { method: 'POST', headers, body: payload });
    } catch (err) {
      // The sync's deadline passed: stop here, retrying cannot help.
      if (err instanceof SyncDeadlineError) throw err;
      // Network throws (e.g. a keep-alive socket dropped after a big batch).
      lastErr = err;
    }
    if (response) {
      // Rate limits and gateway errors are transient; anything else is the answer.
      if (!isRetryableStatus(response.status) || attempt === MAX_FETCH_ATTEMPTS) return response;
      await response.body?.cancel().catch(() => undefined);
    }
    if (attempt < MAX_FETCH_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt, response)));
      throwIfSyncAborted();
    }
  }
  throw new Error(describeFetchFailure(url, Buffer.byteLength(payload, 'utf8'), lastErr));
}

async function postJson<T>(url: string, body: unknown, dryRun?: boolean): Promise<T | null> {
  if (dryRun) return null;

  const response = await postForResponse(
    url,
    { 'Content-Type': 'application/json' },
    JSON.stringify(body),
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Control API ${response.status}: ${text || response.statusText}`);
  }

  return (await response.json()) as T;
}

/** POST that tolerates an older Mission Control without the route: false on 404. */
async function postJsonIfSupported(url: string, body: unknown, dryRun?: boolean): Promise<boolean> {
  if (dryRun) return true;
  const response = await postForResponse(
    url,
    { 'Content-Type': 'application/json' },
    JSON.stringify(body),
  );
  if (response.status === 404) return false;
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Control API ${response.status}: ${text || response.statusText}`);
  }
  return true;
}

const PORTAL_API_PREFIX = '/api';

function portalEndpointUrl(target: PortalTarget, endpoint: string): string {
  const apiUrl = kernoApiUrlFor(target.url);
  if (!apiUrl) return `${target.url}${endpoint}`;
  return `${apiUrl}${KERNO_INGEST_PREFIX}${endpoint.slice(PORTAL_API_PREFIX.length)}`;
}

/**
 * The CLI sends to one org at a time. A target resolved before the user
 * switched org (or disconnected) must not send anything — not data, and not a
 * token refresh — to the previous org.
 */
function assertPortalTargetActive(target: PortalTarget): void {
  if (!isPortalTargetActive(target)) {
    throw new Error(
      'HAR HQ connection changed during sync — nothing more is sent to the previous org.',
    );
  }
}

function postPortalOnce(
  target: PortalTarget,
  endpoint: string,
  body: unknown,
): Promise<Response> {
  assertPortalTargetActive(target);
  return postForResponse(
    portalEndpointUrl(target, endpoint),
    {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${target.token}`,
    },
    JSON.stringify(body),
  );
}

// Rotate an expired ingest token via the stored refresh token: on success
// mutates target.token and persists the rotated credential, else returns false
// so the caller surfaces the original 401.
async function refreshPortalToken(target: PortalTarget): Promise<boolean> {
  if (!target.refreshToken) return false;
  if (isPortalApiKey(target.token)) return false;
  if (!isPortalTargetActive(target)) return false;

  let response: Response;
  try {
    response = await syncFetch(portalEndpointUrl(target, '/api/cli/refresh'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${target.refreshToken}` },
    });
  } catch (err) {
    // Out of time is not an auth problem — don't let it read as a rejected token.
    if (err instanceof SyncDeadlineError) throw err;
    return false;
  }
  if (!response.ok) return false;

  const data = (await response.json().catch(() => null)) as {
    token?: string;
    expiresAt?: string;
  } | null;
  if (!data?.token) return false;

  target.token = data.token;
  if (target.alias) {
    updatePortalTargetTokens(target.identityKey, {
      token: data.token,
      expiresAt: data.expiresAt,
    });
  }
  return true;
}

async function postPortalWithRefresh(
  target: PortalTarget,
  endpoint: string,
  body: unknown,
): Promise<Response> {
  const response = await postPortalOnce(target, endpoint, body);

  if (
    (response.status === 401 || response.status === 403) &&
    (await refreshPortalToken(target))
  ) {
    return postPortalOnce(target, endpoint, body);
  }

  return response;
}

/** har-portal refused a request as too large (HTTP 413). */
class PortalPayloadTooLargeError extends Error {}

async function throwPortalFailure(response: Response, target: PortalTarget): Promise<never> {
  if ((response.status === 401 || response.status === 403) && isPortalApiKey(target.token)) {
    throw new Error(
      `har-portal rejected the API key (HTTP ${response.status}) — it was revoked, has expired, or belongs to another environment. Create a new key on the portal (or check HAR_PORTAL_TOKEN).`,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `har-portal rejected the ingest token (HTTP ${response.status}) — run \`har hq connect\` (or check HAR_PORTAL_TOKEN).`,
    );
  }
  const text = await response.text().catch(() => '');
  const message = `har-portal sync failed: HTTP ${response.status}${text ? ` — ${text}` : ''}`;
  if (response.status === 413) throw new PortalPayloadTooLargeError(message);
  throw new Error(message);
}

async function postPortal(
  target: PortalTarget,
  endpoint: string,
  body: unknown,
  dryRun?: boolean,
): Promise<Record<string, unknown> | null> {
  if (dryRun) return null;

  const response = await postPortalWithRefresh(target, endpoint, body);
  if (!response.ok) await throwPortalFailure(response, target);

  return (await response.json().catch(() => null)) as Record<string, unknown> | null;
}

async function postPortalIfSupported(
  target: PortalTarget,
  endpoint: string,
  body: unknown,
  dryRun?: boolean,
): Promise<boolean> {
  if (dryRun) return true;

  const response = await postPortalWithRefresh(target, endpoint, body);
  if (response.status === 404) return false;
  if (!response.ok) await throwPortalFailure(response, target);

  return true;
}

function maxRowsInBody(body: Record<string, unknown>): number {
  return Math.max(0, ...Object.values(body).map((value) => (Array.isArray(value) ? value.length : 0)));
}

/**
 * POST `units` to the portal in as many requests as the per-request budget
 * needs; the first carries `head` (when given), the rest `{ path }`. A request the portal
 * still refuses as too large (its limit is below ours) is packed again at half
 * its size and sent in parts. `onLanded` runs after each request lands, in order.
 */
async function postPortalPacked(
  portal: PortalTarget,
  endpoint: string,
  path: string,
  head: Record<string, unknown> | null,
  units: SyncUnit[],
  dryRun: boolean | undefined,
  onLanded: (landed: SyncUnit[], response: Record<string, unknown> | null) => void,
  maxBytes = maxSyncBatchBytes(),
  maxRows = maxSyncBatchRows(),
): Promise<void> {
  const continuation = { path };
  const bodies = packSyncBodies(head, continuation, units, maxBytes, maxRows);
  for (let i = 0; i < bodies.length; i++) {
    const { body, units: bodyUnits } = bodies[i];
    let response: Record<string, unknown> | null;
    try {
      response = await postPortal(portal, endpoint, body, dryRun);
    } catch (err) {
      if (!(err instanceof PortalPayloadTooLargeError)) throw err;
      const bodyHead = i === 0 ? head : null;
      const halfBytes = Math.floor(Buffer.byteLength(JSON.stringify(body), 'utf8') / 2);
      const halfRows = Math.max(1, Math.floor(maxRowsInBody(body) / 2));
      if (packSyncBodies(bodyHead, continuation, bodyUnits, halfBytes, halfRows).length < 2) {
        throw new PortalPayloadTooLargeError(
          `${err.message} (a single record is larger than the portal accepts; it cannot be split further)`,
        );
      }
      await postPortalPacked(portal, endpoint, path, bodyHead, bodyUnits, dryRun, onLanded, halfBytes, halfRows);
      continue;
    }
    onLanded(bodyUnits, response);
  }
}

function runUnits(runs: RunRecord[]): SyncUnit[] {
  return [...runs]
    .sort((a, b) => runTimestamp(a).localeCompare(runTimestamp(b)))
    .map((run) => ({ key: 'runs', rows: [run] }));
}

function lastRunIn(units: SyncUnit[]): RunRecord | undefined {
  for (let i = units.length - 1; i >= 0; i--) {
    if (units[i].key === 'runs') return units[i].rows[units[i].rows.length - 1] as RunRecord;
  }
  return undefined;
}

function resolvePortalUserEmail(target?: PortalTarget): string | undefined {
  if (target?.email) return target.email;
  return readPortalCredentials()?.email || undefined;
}

function dropNullFields(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== null));
}

function modelsFromBreakdown(
  breakdown: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  if (!breakdown) return [];
  return Object.entries(breakdown).map(([model, totals]) => ({
    model,
    ...(totals && typeof totals === 'object' ? totals : {}),
  }));
}

interface TelemetryCollection {
  /** One array per provider session: a session's rows always travel in one request. */
  usage: Array<Array<Record<string, unknown>>>;
  events: Record<string, unknown>[];
  maxSyncedAt: string | null;
  failures: ChannelReadFailure[];
  truncated: string[];
}

function describeReadFailures(repoPath: string, failures: ChannelReadFailure[]): string {
  const detail = [...new Set(failures.map((f) => `${f.channel} (${f.reason})`))].join(', ');
  return (
    `${path.basename(repoPath)}: could not read ${detail} from Mission Control — ` +
    'that telemetry is missing from this sync and its watermark is held, so the next sync retries it.'
  );
}

function describeTruncatedReads(repoPath: string, channels: string[]): string {
  return (
    `${path.basename(repoPath)}: ${channels.join(', ')} hit the read page cap — ` +
    'the remainder syncs on the next run.'
  );
}

/**
 * Usage and events for the portal sync.
 *
 * Usage is Mission Control's: the rows it attributed (slot, main checkout,
 * non-slot worktree) and priced, sent unchanged (`portal-attributed-usage`).
 * Only a Mission Control that predates attribution gets the legacy path —
 * session totals harvested per slot (the lowest slot taking main-checkout
 * sessions), max-merged with its stored totals and repriced.
 */
async function collectPortalTelemetry(
  repoPath: string,
  slots: EnvironmentStatus['slots'],
  controlApiUrl: string,
  since: string | null,
  portal?: PortalTarget,
): Promise<TelemetryCollection> {
  if (!isTelemetryEnabled()) {
    return { usage: [], events: [], maxSyncedAt: null, failures: [], truncated: [] };
  }
  try {
    const userEmail = resolvePortalUserEmail(portal);
    const persisted = await fetchPersistedPortalTelemetry(repoPath, controlApiUrl, { since, userEmail });
    const legacyUsage = persisted.attributedUsage == null;
    // Legacy only: no unassigned bucket there, so main-checkout sessions land
    // on the lowest slot, as they always have.
    const fallbackAgentId =
      slots.length > 0 ? Math.min(...slots.map((slot) => slot.agentId)) : null;
    const liveUsage: AgentSessionUsage[] = !legacyUsage ? [] : slots.flatMap((slot) =>
      harvestUsageForSlot({
        agentId: slot.agentId,
        workDir: slot.workDir,
        worktreePath: slot.worktreePath,
        branch: slot.branch,
        suffix: slot.suffix,
        sessionCreatedAt: slot.sessionCreatedAt,
        repoPath,
        includeRepoPathFallback: slot.agentId === fallbackAgentId,
      }).map((row) => ({
        ...row,
        workUnitId: slot.workUnitId ?? row.workUnitId,
        attemptId: slot.attemptId ?? row.attemptId,
        sessionKey:
          row.sessionKey ||
          buildSessionKey({
            branch: slot.branch,
            agentId: slot.agentId,
            suffix: slot.suffix,
            createdAt: slot.sessionCreatedAt,
          }),
      })),
    );

    const liveEvents: AgentSessionEvent[] = slots.flatMap((slot) =>
      harvestEventsForSlot({
        agentId: slot.agentId,
        workDir: slot.workDir,
        worktreePath: slot.worktreePath,
        branch: slot.branch,
        suffix: slot.suffix,
        sessionCreatedAt: slot.sessionCreatedAt,
        repoPath,
        includeRepoPathFallback: slot.agentId === fallbackAgentId,
      }).map((event) => ({
        ...event,
        workUnitId: slot.workUnitId ?? event.workUnitId,
        attemptId: slot.attemptId ?? event.attemptId,
      })),
    );

    const harvestedEvents = omitHarvestEventsWhenOtelPresent(liveEvents, persisted.events);

    const usage: Array<Array<Record<string, unknown>>> =
      persisted.attributedUsage ??
      mergePortalUsage(omitHarvestWhenOtelPresent(liveUsage, persisted.usage), persisted.usage).map((row) => {
        const priced = enrichUsageWithPricing(row);
        const models = modelsFromBreakdown(
          priced.modelBreakdown as Record<string, unknown> | undefined,
        );
        return [
          {
            ...priced,
            ...(userEmail ? { userEmail } : {}),
            ...(models.length > 0 ? { models } : {}),
          },
        ];
      });

    const events = dedupePortalEvents(harvestedEvents, persisted.events).map((event) =>
      dropNullFields({ ...event }),
    );

    return {
      usage,
      events,
      maxSyncedAt: persisted.maxSyncedAt,
      failures: persisted.failures,
      truncated: persisted.truncated,
    };
  } catch (err: unknown) {
    return {
      usage: [],
      events: [],
      maxSyncedAt: null,
      failures: [
        { channel: 'telemetry', reason: err instanceof Error ? err.message : String(err) },
      ],
      truncated: [],
    };
  }
}

/**
 * Identity stays canonical (#255); slot occupancy is the union of every source
 * that actually stores a session (#256). Prefer an active occupancy over idle
 * so a main-checkout sync cannot blank a live external worktree.
 */
function collectEnvironmentStatusForSync(
  canonicalPath: string,
  sourcePaths: string[],
): EnvironmentStatus {
  // Both legs of one sync (Mission Control, then HQ) report the same status.
  return snapshotMemo(
    ['sync-status', path.resolve(canonicalPath), ...sourcePaths.map((p) => path.resolve(p))].join('\0'),
    () => readEnvironmentStatusForSync(canonicalPath, sourcePaths),
  );
}

function readEnvironmentStatusForSync(
  canonicalPath: string,
  sourcePaths: string[],
): EnvironmentStatus {
  const collected = new Map<string, EnvironmentStatus>();
  const groups: AgentSlotStatus[][] = [];
  const canonicalKey = path.resolve(canonicalPath);
  for (const source of sourcePaths) {
    const key = path.resolve(source);
    let status = collected.get(key);
    if (!status) {
      try {
        status = collectEnvironmentStatus(source);
      } catch (err) {
        // Only the canonical checkout may fail the sync. A secondary source
        // (a linked worktree with its own `.har/`) can lack the slot config
        // the canonical one has; skipping its slots must not cost the repo its
        // runs, slots, usage and validations.
        if (key === canonicalKey) throw err;
        const message = err instanceof Error ? err.message : String(err);
        warn(`Skipping slot status from ${source}: ${message}`);
        continue;
      }
      collected.set(key, status);
    }
    groups.push(status.slots);
  }
  const canonical = collected.get(canonicalKey) ?? collectEnvironmentStatus(canonicalPath);
  return { ...canonical, slots: mergeSlotStatuses(groups) };
}

async function buildPortalPayload(
  repoPath: string,
  sourcePaths: string[],
  controlApiUrl: string,
  since: string | null,
  full = false,
  portal?: PortalTarget,
  loadHeldUnits: () => Promise<HeldUsageUnits> = async () => new Map(),
): Promise<{
  syncBody: Record<string, unknown>;
  /** Usage left out of this sync: sessions breaking a blocking invariant. */
  held: Array<Array<Record<string, unknown>>>;
  /** The blocking units the held usage breaks (empty when no usage was checked). */
  heldUnits: HeldUsageUnits;
  /** Records and usage after the head, in the order the portal needs them. */
  units: SyncUnit[];
  runs: RunRecord[];
  runsBySource: RunsBySource[];
  events: Record<string, unknown>[];
  maxSyncedAt: string | null;
  failures: ChannelReadFailure[];
  truncated: string[];
}> {
  // Same canonical-identity / workspace-evidence split as the local path (#255).
  const rawRunsBySource = collectRunsBySource(sourcePaths);
  const runs = mergeRunsBySource(rawRunsBySource);
  const status = collectEnvironmentStatusForSync(repoPath, sourcePaths);
  const manifest = readManifest(repoPath);
  const stagesRegistry = readStageRegistry(repoPath);
  const validations = collectValidationsForSync(sourcePaths);
  const { workUnits, attempts } = collectWorkUnitsForSync(sourcePaths);
  const validationBindings = collectValidationBindingsForSync(sourcePaths);
  const commitBindings = collectCommitBindingsForSync(sourcePaths);
  // Attribute runs/validations to the syncing member so the portal can resolve
  // a real user FK instead of the lossy (repo, agentId) derivation.
  const userEmail = resolvePortalUserEmail(portal);
  const { usage: collected, events, maxSyncedAt, failures, truncated } = await collectPortalTelemetry(
    repoPath,
    status.slots,
    controlApiUrl,
    since,
    portal,
  );
  // A session breaking I1/I2 is left out whole: the portal replaces only the
  // sessions a sync carries, so its stored rows stay as they are.
  // The check reads every repository's usage in Mission Control: ask for it
  // only when this sync has usage to send.
  const heldUnits: HeldUsageUnits = collected.length > 0 ? await loadHeldUnits() : new Map();
  const { sent: usage, held } = partitionHeldUsage(collected, heldUnits);

  if (
    full &&
    isTelemetryEnabled() &&
    failures.length === 0 &&
    usage.length === 0 &&
    runs.some((r) => r.agentId != null)
  ) {
    warn(
      `${path.basename(repoPath)}: agent runs found but no usage harvested — attribution will be missing. ` +
        'This happens when agent sessions ran outside the har worktree slot (e.g. in the main checkout). ' +
        'Run agents inside `har env launch`.',
    );
  }

  if (full && isTelemetryEnabled() && !getTelemetrySignals().prompts) {
    warn(
      `${path.basename(repoPath)}: telemetry level is ${getTelemetryLevel()}, so no agent prompt or response text is ` +
        'recorded — surfaces that show session content stay empty. Record it with `har telemetry on --level full`.',
    );
  }

  const syncBody: Record<string, unknown> = {
    path: repoPath,
    cliVersion: getHarPackageVersion(),
    ...(status.gitRemote ? { gitRemote: status.gitRemote } : {}),
    ...(manifest ? { manifest } : {}),
    ...(stagesRegistry ? { stagesRegistry } : {}),
    slots: status.slots,
    generatedAt: status.generatedAt,
  };

  // The portal upserts each record by id, so they may span requests, but it
  // resolves an attempt's work unit (and a binding's attempt) from rows already
  // stored: work units go first, then attempts, then bindings. A provider
  // session's usage rows stay in one request: the portal replaces a session's
  // rows with what one request carries.
  const each = (key: string, rows: unknown[]): SyncUnit[] => rows.map((row) => ({ key, rows: [row] }));
  const units: SyncUnit[] = [
    ...each('workUnits', workUnits),
    ...each('attempts', attempts),
    ...each('validations', userEmail ? validations.map((v) => ({ ...v, userEmail })) : validations),
    ...each('validationBindings', validationBindings),
    ...each('commitBindings', commitBindings),
    ...usage.map((session) => ({ key: 'usage', rows: session })),
  ];

  const runsBySource = userEmail
    ? rawRunsBySource.map(({ source, runs: sourceRuns }) => ({
        source,
        runs: sourceRuns.map((run) => ({ ...run, userEmail })),
      }))
    : rawRunsBySource;

  return {
    syncBody,
    held,
    heldUnits,
    units,
    runs: mergeRunsBySource(runsBySource),
    runsBySource,
    events,
    maxSyncedAt,
    failures,
    truncated,
  };
}

export async function isControlApiReachable(apiUrl = getControlApiUrl()): Promise<boolean> {
  try {
    const response = await fetch(`${apiUrl}/api/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForControlApi(
  apiUrl = getControlApiUrl(),
  timeoutMs = 60_000,
  intervalMs = 1000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isControlApiReachable(apiUrl)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/**
 * Every har repo known locally: the control registry (`~/.har/repos.json`) plus
 * an optional cwd — both manifest-gated and canonicalized. Detection is registry
 * only; it neither scans the filesystem nor depends on portal/control API state.
 * Shared by the all-repos auto-sync and the interactive `har control sync`
 * selection.
 */
export async function discoverHarRepos(options?: {
  apiUrl?: string;
  cwd?: string;
}): Promise<string[]> {
  const repoPaths = new Set<string>(listRegisteredRepos());

  if (options?.cwd) {
    const cwd = canonicalizeControlRepoPath(options.cwd);
    if (readManifest(cwd)) repoPaths.add(cwd);
  }

  return [...repoPaths];
}

/**
 * Push a specific set of repos, one per timeout-guarded call. Returns the
 * summary counts plus a per-repo result so callers can print outcomes.
 */
export async function syncReposWithControl(options: {
  repoPaths: string[];
  apiUrl?: string;
  dryRun?: boolean;
  cloud?: boolean;
  full?: boolean;
}): Promise<{
  synced: number;
  failed: number;
  incomplete: number;
  results: SyncRepoResult[];
}> {
  const apiUrl = options.apiUrl ?? getControlApiUrl();
  const results: SyncRepoResult[] = [];
  let synced = 0;
  let failed = 0;
  let incomplete = 0;

  for (const repoPath of options.repoPaths) {
    try {
      const outcome = await runWithDeadline(
        () =>
          syncRepoWithControl({
            repoPath,
            apiUrl,
            dryRun: options.dryRun,
            cloud: options.cloud,
            full: options.full,
          }),
        EXPLICIT_SYNC_TIMEOUT_MS,
        'control sync',
      );
      synced++;
      if (outcome.warnings.length > 0) incomplete++;
      results.push({
        repoPath,
        ok: true,
        ...(outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
      });
    } catch (err: unknown) {
      failed++;
      results.push({ repoPath, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { synced, failed, incomplete, results };
}

/**
 * The repos an unattended all-repos sync may touch: the selection saved by
 * `har control sync` when there is one (the same set that command syncs when it
 * does not prompt), else every discovered repo.
 */
function selectedRepos(discovered: string[]): string[] {
  return resolveSyncSelection({
    discovered,
    stored: readSyncSelection(),
    forceSelect: false,
    isTTY: false,
  }).toSync;
}

export async function syncAllKnownReposWithControl(options?: {
  apiUrl?: string;
  cwd?: string;
}): Promise<{ synced: number; failed: number }> {
  if (!isControlEnabled()) return { synced: 0, failed: 0 };

  const apiUrl = options?.apiUrl ?? getControlApiUrl();
  if (!(await isControlApiReachable(apiUrl))) {
    return { synced: 0, failed: 0 };
  }

  const repoPaths = selectedRepos(await discoverHarRepos({ apiUrl, cwd: options?.cwd }));
  const { synced, failed } = await syncReposWithControl({ repoPaths, apiUrl });
  return { synced, failed };
}

export async function registerRepoWithControl(
  options: ControlRegisterOptions,
): Promise<{ id: string } | null> {
  const repoPath = canonicalizeControlRepoPath(options.repoPath);
  const apiUrl = options.apiUrl ?? getControlApiUrl();
  const manifest = readManifest(repoPath);
  const stagesRegistry = readStageRegistry(repoPath);

  const body: RegisterRepoInput = {
    path: repoPath,
    gitRemote: options.gitRemote,
    manifest: manifest ?? undefined,
    stagesRegistry: stagesRegistry ?? undefined,
    force: options.force,
  };

  if (options.dryRun) return null;

  const response = await syncFetch(`${apiUrl}/api/repos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (response.status === 409) {
    // Previously unregistered — drop from local registry so auto-sync stops retrying.
    removeRegisteredRepo(repoPath);
    return null;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Control API ${response.status}: ${text || response.statusText}`);
  }

  return (await response.json()) as { id: string };
}

/**
 * Best-effort: record the repo in the local registry and register it with
 * Mission Control immediately, so OTLP ingest (otel-hook) can resolve
 * workspace → repo/slot without waiting for the next `har control sync` or
 * `har env launch`. Never throws — callers run this alongside telemetry
 * enablement, which must not fail just because registration did.
 */
export async function ensureRepoRegisteredWithControl(
  repoPath: string,
  apiUrl?: string,
): Promise<void> {
  const canonical = canonicalizeControlRepoPath(repoPath);
  recordRepoForControlSync(canonical);
  try {
    await registerRepoWithControl({ repoPath: canonical, apiUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[har control] repo registration skipped: ${message}\n`);
  }
}

async function syncRepoWithLocalControl(
  options: ControlSyncOptions & { repoPath: string; workspacePath?: string },
): Promise<void> {
  const apiUrl = options.apiUrl ?? getControlApiUrl();
  const { repoPath, workspacePath, dryRun, full } = options;

  const registerResult = await registerRepoWithControl({ ...options, repoPath });
  const repoId = registerResult?.id;

  if (!repoId && !dryRun) {
    const listResponse = await syncFetch(`${apiUrl}/api/repos`);
    if (!listResponse.ok) throw new Error('Failed to list repos from Control API');
    const repos = (await listResponse.json()) as { id: string; path: string }[];
    const existing = repos.find((r) => path.resolve(r.path) === repoPath);
    if (!existing) {
      // Unregistered / blocked — nothing to sync locally.
      return;
    }
    await syncRepoRunsAndSlots(apiUrl, existing.id, repoPath, workspacePath, dryRun, full);
    return;
  }

  if (repoId) {
    await syncRepoRunsAndSlots(apiUrl, repoId, repoPath, workspacePath, dryRun, full);
  }
}

async function syncRepoWithPortal(
  options: ControlSyncOptions & { repoPath: string; workspacePath?: string },
  controlApiUrl: string,
  portal: PortalTarget,
): Promise<string[]> {
  if (!isRepoPortalSyncEnabled(options.repoPath)) return [];

  const { repoPath, workspacePath, dryRun, full } = options;
  const sourcePaths = resolveSyncSourcePaths(repoPath, workspacePath);
  const watermarkKey = watermarkKeyForTarget(portal);
  const since = full ? null : readPortalWatermarkForTarget(repoPath, portal);

  const runsTarget = runsWatermarkTargetForPortal(portal);
  let stored = full ? null : readRunsWatermarkEntry(repoPath, runsTarget);
  if (!stored && !full) {
    for (const legacyKey of legacyScopedWatermarkKeys(portal, 'runs')) {
      stored = readRunsWatermarkEntry(repoPath, legacyKey);
      if (stored) break;
    }
  }
  const runsSince = rewindSince(stored?.lastSyncedAt ?? null);
  const loadHeldUnits = async (): Promise<HeldUsageUnits> =>
    dryRun ? new Map() : heldUsageUnits(controlApiUrl, repoPath);
  const { syncBody, held, heldUnits, units, runsBySource, events, maxSyncedAt, failures, truncated } =
    await buildPortalPayload(repoPath, sourcePaths, controlApiUrl, since, full, portal, loadHeldUnits);
  const newRuns = selectRunsForSync(
    runsBySource,
    runsSince,
    coveredSources(repoPath, stored),
    (rows, rowsSince) => selectSince(rows, rowsSince, runTimestamp).selected,
  );

  let repoId: string | undefined;
  let firstLanded = true;
  // Runs go last, oldest first; the runs watermark advances (with the portal's
  // repo id) after each request lands, so a sync cut short resumes.
  const advanceRunsWatermark = (getRepoId: () => string | undefined) =>
    (landed: SyncUnit[]): void => {
      const last = lastRunIn(landed);
      if (!dryRun && last) {
        writeRunsWatermark(repoPath, runsTarget, getRepoId(), runTimestamp(last), sourcePaths);
      }
    };
  const advanceDelta = advanceRunsWatermark(() => stored?.repoId ?? repoId);
  await postPortalPacked(
    portal,
    '/api/sync',
    repoPath,
    // An empty sync still says it has no runs, as it always has.
    newRuns.length > 0 ? syncBody : { ...syncBody, runs: [] },
    [...units, ...runUnits(newRuns)],
    dryRun,
    (landed, response) => {
      if (firstLanded && typeof response?.repositoryId === 'string') repoId = response.repositoryId;
      firstLanded = false;
      advanceDelta(landed);
    },
  );

  if (!full && !dryRun && stored?.repoId && repoId && stored.repoId !== repoId) {
    await postPortalPacked(
      portal,
      '/api/sync',
      repoPath,
      null,
      runUnits(mergeRunsBySource(runsBySource)),
      dryRun,
      advanceRunsWatermark(() => repoId),
    );
  }
  for (const batch of chunkBySerializedSize(events, maxSyncBatchBytes())) {
    await postPortal(portal, '/api/otel', { path: repoPath, events: batch }, dryRun);
  }
  // Usage and events share one watermark: advancing it on one channel's rows
  // strands the other's for good when its read failed.
  // A held-back session must be offered again once it is fixed, even if its
  // own facts do not change (the copy may be removed from another repository).
  if (!dryRun && maxSyncedAt && failures.length === 0 && held.length === 0) {
    writePortalWatermark(repoPath, watermarkKey, maxSyncedAt);
  }

  const warnings: string[] = [];
  if (held.length > 0) warnings.push(describeHeldUsage(repoPath, held, heldUnits));
  if (failures.length > 0) warnings.push(describeReadFailures(repoPath, failures));
  if (truncated.length > 0) warnings.push(describeTruncatedReads(repoPath, truncated));

  await syncLinesWithPortal(portal, repoPath, sourcePaths, dryRun);
  warnings.push(
    ...(await syncTrajectoryWithPortal(portal, repoPath, controlApiUrl, dryRun, full)),
  );
  for (const message of warnings) warn(message);
  return warnings;
}

/**
 * Factory lines → `/api/lines` (Kerno: `/api/har/ingest/lines`).
 *
 * Sent like validations: the full set every sync, upserted by id on the
 * backend. The first request carries the complete installed-line list so a line
 * missing from it can be marked removed. A backend without the endpoint (404)
 * is skipped quietly; any other failure fails the sync, like trajectory.
 */
async function syncLinesWithPortal(
  portal: PortalTarget,
  repoPath: string,
  sourcePaths: string[],
  dryRun?: boolean,
): Promise<void> {
  const lines = collectLinesForSync(repoPath);
  const gates = collectLineGateRunsForSync(sourcePaths);
  if (lines.length === 0 && gates.length === 0 && !hasLineLedger(repoPath)) return;

  const userEmail = resolvePortalUserEmail(portal);
  const stamped = userEmail ? gates.map((gate) => ({ ...gate, userEmail })) : gates;
  const [first = [], ...rest] = chunkBySerializedSize(stamped, maxSyncBatchBytes());

  const body = { path: repoPath, lines, gates: first };
  if (!(await postPortalIfSupported(portal, '/api/lines', body, dryRun))) return;
  for (const batch of rest) {
    await postPortalIfSupported(portal, '/api/lines', { path: repoPath, gates: batch }, dryRun);
  }
}

async function syncTrajectoryWithPortal(
  portal: PortalTarget,
  repoPath: string,
  controlApiUrl: string,
  dryRun: boolean | undefined,
  full: boolean | undefined,
): Promise<string[]> {
  const wantRecords = isPortalTrajectoryEnabledForTarget(portal);
  const wantSpans = isTelemetryEnabled() && getTelemetrySignals().traces;
  if (!wantRecords && !wantSpans) return [];

  const recordsTarget = trajectoryWatermarkTarget(portal);
  const spansTarget = spansWatermarkTarget(portal);
  const { records, spans, recordsMaxSyncedAt, spansMaxSyncedAt, failures, truncated } =
    await fetchPersistedTrajectory(repoPath, controlApiUrl, {
      records: wantRecords
        ? {
            since: full
              ? null
              : readScopedPortalWatermark(
                  repoPath,
                  recordsTarget,
                  legacyScopedWatermarkKeys(portal, 'trajectory'),
                ),
          }
        : false,
      spans: wantSpans
        ? {
            since: full
              ? null
              : readScopedPortalWatermark(
                  repoPath,
                  spansTarget,
                  legacyScopedWatermarkKeys(portal, 'spans'),
                ),
          }
        : false,
    });

  const failedChannel = (channel: string) =>
    failures.some((failure) => failure.channel === channel || failure.channel === 'repos');

  for (const batch of chunkBySerializedSize(spans, maxSyncBatchBytes())) {
    await postPortal(portal, '/api/otel', { path: repoPath, spans: batch }, dryRun);
  }
  if (!dryRun && spansMaxSyncedAt && !failedChannel('spans')) {
    writePortalWatermark(repoPath, spansTarget, spansMaxSyncedAt);
  }

  let recordsLanded = true;
  for (const batch of chunkBySerializedSize(records, maxSyncBatchBytes())) {
    const supported = await postPortalIfSupported(
      portal,
      '/api/trajectory',
      { path: repoPath, records: batch },
      dryRun,
    );
    if (!supported) {
      recordsLanded = false;
      warn(
        `${path.basename(repoPath)}: this har-portal has no /api/trajectory endpoint — ` +
          'trajectory forwarding skipped (upgrade the portal; records are kept for the next sync).',
      );
      break;
    }
  }
  if (!dryRun && recordsLanded && recordsMaxSyncedAt && !failedChannel('trajectory')) {
    writePortalWatermark(repoPath, recordsTarget, recordsMaxSyncedAt);
  }

  return [
    ...(failures.length > 0 ? [describeReadFailures(repoPath, failures)] : []),
    ...(truncated.length > 0 ? [describeTruncatedReads(repoPath, truncated)] : []),
  ];
}

export async function syncRepoWithControl(
  options: ControlSyncOptions,
): Promise<{ warnings: string[] }> {
  // One read of slots, pm2 and git for the whole sync (both legs).
  return withStatusSnapshot(() => syncRepoWithControlOnce(options));
}

async function syncRepoWithControlOnce(
  options: ControlSyncOptions,
): Promise<{ warnings: string[] }> {
  // Identity is canonical; evidence may live in the workspace this ran in (#255).
  const workspacePath = path.resolve(options.repoPath);
  const repoPath = canonicalizeControlRepoPath(options.repoPath);
  const apiUrl = options.apiUrl ?? getControlApiUrl();

  if (options.cloud) {
    const remote = createRemoteExecutor();
    if (!remote) {
      throw new Error('HAR Cloud not configured (set HAR_CLOUD_API_URL and HAR_CLOUD_API_KEY)');
    }
    const sourcePaths = resolveSyncSourcePaths(repoPath, workspacePath);
    const runs = collectRunsForSync(sourcePaths);
    const status = collectEnvironmentStatusForSync(repoPath, sourcePaths);
    const cloudWork = collectWorkUnitsForSync(sourcePaths);
    const harnessRoot = resolveHarnessRoot(repoPath);
    const response = await syncFetch(`${process.env.HAR_CLOUD_API_URL}/api/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.HAR_CLOUD_API_KEY}`,
      },
      body: JSON.stringify({
        path: repoPath,
        runs,
        slots: status.slots,
        workUnits: cloudWork.workUnits,
        attempts: cloudWork.attempts,
        validations: listValidations(harnessRoot),
        validationBindings: listValidationBindings(harnessRoot),
        commitBindings: collectCommitBindingsForSync(sourcePaths),
      }),
    });
    if (!response.ok) {
      throw new Error(`Cloud sync failed: ${response.status}`);
    }
    return { warnings: [] };
  }

  // A Mission Control failure (one bad endpoint, e.g. a 400 on commit
  // bindings) must not also cost the repo its HQ sync: HQ still gets its runs
  // and slots, and the error is reported once both legs ran.
  let localError: unknown;
  try {
    await syncRepoWithLocalControl({ ...options, repoPath, workspacePath, apiUrl });
  } catch (err) {
    if (err instanceof SyncDeadlineError) throw err;
    localError = err;
  }

  const portalSyncEnabled = isRepoPortalSyncEnabled(repoPath);
  const portal = portalSyncEnabled ? resolvePortalTarget(repoPath) : null;
  let warnings: string[] = [];
  // Attached to HQ yet opted out: HQ stays empty with no sign of why, so say it.
  if (!portalSyncEnabled && resolvePortalTarget(repoPath)) {
    warnings.push(
      `${path.basename(repoPath)}: attached to HAR HQ but kept local-only, so nothing is sent to HQ — ` +
        `send it with \`har control register --repo ${repoPath} --portal\`.`,
    );
  }
  let portalError: unknown;
  if (portal) {
    try {
      warnings = await syncRepoWithPortal({ ...options, repoPath, workspacePath }, apiUrl, portal);
    } catch (err) {
      if (err instanceof SyncDeadlineError) throw err;
      portalError = err;
    }
  }

  const failures = [
    ...(localError !== undefined ? [`Mission Control: ${errorMessage(localError)}`] : []),
    ...(portalError !== undefined ? [`HQ: ${errorMessage(portalError)}`] : []),
  ];
  if (failures.length > 0) {
    const landed =
      portal && portalError === undefined
        ? ' (HQ sync completed)'
        : localError === undefined && portal
          ? ' (Mission Control sync completed)'
          : '';
    throw new Error(`${failures.join('; ')}${landed}`);
  }
  return { warnings };
}

let warnedUsageCheckUnavailable = false;

/**
 * The sync units (provider sessions, legacy rows) of a repository that break
 * a blocking usage invariant (I1, I2): the HQ sync leaves them out and sends
 * the rest. A Mission Control without the check (older version) or a failed
 * check holds nothing back: the sync warns once and goes on.
 * `HAR_SYNC_ALLOW_USAGE_VIOLATIONS=1` sends everything.
 */
async function heldUsageUnits(apiUrl: string, repoPath: string): Promise<HeldUsageUnits> {
  if (process.env.HAR_SYNC_ALLOW_USAGE_VIOLATIONS === '1' || !isTelemetryEnabled()) return new Map();
  try {
    return heldUnitsForRepo(await fetchUsageInvariantReport(apiUrl, repoPath), repoPath);
  } catch (err) {
    if (err instanceof SyncDeadlineError) throw err;
    if (!warnedUsageCheckUnavailable) {
      warnedUsageCheckUnavailable = true;
      warn(`Usage invariants not checked before the HQ sync: ${errorMessage(err)}`);
    }
    return new Map();
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

let warnedSessionBindingsUnsupported = false;

async function fetchRemoteSessionBindings(apiUrl: string, repoId: string) {
  try {
    const response = await syncFetch(`${apiUrl}/api/repos/${repoId}/session-bindings`);
    if (!response.ok) return [];
    return parseRemoteSessionBindings(await response.json());
  } catch {
    return [];
  }
}

/**
 * Session → slot attribution (ADR 0003): post the `launch` / `release` /
 * `workspace` bindings, then, when harvesting, the usage observations of every
 * session this repo has evidence for. Never fails the sync.
 *
 * Returns false only when Mission Control has no `/usage-observations` route
 * (an older version), so the caller can fall back to per-slot session totals.
 */
export async function syncSessionAttributionWithControl(
  apiUrl: string,
  repoId: string,
  sourcePaths: string[],
  slots: AttributionSlot[],
  harvest: boolean,
  dryRun?: boolean,
): Promise<boolean> {
  try {
    const remoteBindings = harvest ? await fetchRemoteSessionBindings(apiUrl, repoId) : [];
    const { bindings, observations } = collectSessionAttribution({
      sourcePaths,
      slots,
      remoteBindings,
      harvest,
    });

    if (bindings.length > 0) {
      const body = SyncSessionBindingsInputSchema.parse({ bindings });
      const accepted = await postJsonIfSupported(
        `${apiUrl}/api/repos/${repoId}/session-bindings`,
        body,
        dryRun,
      );
      if (!accepted && !warnedSessionBindingsUnsupported) {
        warnedSessionBindingsUnsupported = true;
        warn(
          'Mission Control does not accept session bindings yet (no /session-bindings route); ' +
            'usage stays attributed per slot work dir until it is upgraded.',
        );
      }
    }

    if (!harvest) return true;
    // Only what Mission Control has not accepted in this form yet. Posted even
    // when empty: an older Mission Control answers 404, which is how the caller
    // knows to fall back to per-slot totals.
    const unsent = unsentObservations(apiUrl, repoId, observations);
    const batches = chunkBySerializedSize(unsent, maxSyncBatchBytes());
    const accepted: typeof observations = [];
    try {
      for (const batch of batches.length > 0 ? batches : [[]]) {
        const body = SyncUsageObservationsInputSchema.parse({ observations: batch });
        const supported = await postJsonIfSupported(
          `${apiUrl}/api/repos/${repoId}/usage-observations`,
          body,
          dryRun,
        );
        if (!supported) return false;
        accepted.push(...batch);
      }
    } finally {
      if (!dryRun) recordSentObservations(apiUrl, repoId, observations, accepted);
    }
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[har control] session attribution sync skipped: ${message}\n`);
    return true;
  }
}

async function syncRepoRunsAndSlots(
  apiUrl: string,
  repoId: string,
  repoPath: string,
  workspacePath?: string,
  dryRun?: boolean,
  full?: boolean,
): Promise<void> {
  const sourcePaths = resolveSyncSourcePaths(repoPath, workspacePath);
  const runsTarget = runsWatermarkTarget(apiUrl);
  const stored = full ? null : readRunsWatermarkEntry(repoPath, runsTarget);
  const runsSince = rewindSince(stored?.repoId === repoId ? (stored?.lastSyncedAt ?? null) : null);
  const newRuns = selectRunsForSync(
    collectRunsBySource(sourcePaths),
    runsSince,
    coveredSources(repoPath, stored),
    (rows, since) => selectSince(rows, since, runTimestamp).selected,
  );

  await syncRunBatches(
    newRuns,
    repoPath,
    runsTarget,
    () => repoId,
    dryRun,
    async (batch) => {
      await postJson(`${apiUrl}/api/repos/${repoId}/runs`, SyncRunsInputSchema.parse({ runs: batch }), dryRun);
    },
    sourcePaths,
  );

  const status: EnvironmentStatus = collectEnvironmentStatusForSync(repoPath, sourcePaths);
  const slotsBody = SyncSlotsInputSchema.parse({
    slots: status.slots,
    generatedAt: status.generatedAt,
  });
  await postJson(`${apiUrl}/api/repos/${repoId}/slots`, slotsBody, dryRun);

  const workUnitsBody = SyncWorkUnitsInputSchema.parse(collectWorkUnitsForSync(sourcePaths));
  if (workUnitsBody.workUnits.length > 0 || workUnitsBody.attempts.length > 0) {
    await postJson(`${apiUrl}/api/repos/${repoId}/work-units`, workUnitsBody, dryRun);
  }

  const harvest = isTelemetryEnabled() && process.env.NODE_ENV !== 'test';
  const observationsAccepted = await syncSessionAttributionWithControl(
    apiUrl,
    repoId,
    sourcePaths,
    status.slots,
    harvest,
    dryRun,
  );

  if (harvest) {
    try {
      // Mission Control without `/usage-observations` (older than ADR 0003)
      // still takes per-slot session totals: only sessions that ran inside a
      // slot's work dir, which is evidence, never a guessed slot.
      if (!observationsAccepted) {
        const userEmail = resolvePortalUserEmail();
        const usage: AgentSessionUsage[] = status.slots.flatMap((slot) =>
          harvestUsageForSlot({
            agentId: slot.agentId,
            workDir: slot.workDir,
            worktreePath: slot.worktreePath,
            branch: slot.branch,
            suffix: slot.suffix,
            sessionCreatedAt: slot.sessionCreatedAt,
            repoPath,
          }).map((row) => ({
            ...row,
            workUnitId: slot.workUnitId,
            attemptId: slot.attemptId,
            sessionKey:
              row.sessionKey ||
              buildSessionKey({
                branch: slot.branch,
                agentId: slot.agentId,
                suffix: slot.suffix,
                createdAt: slot.sessionCreatedAt,
              }),
            ...(userEmail ? { userEmail } : {}),
          })),
        );
        if (usage.length > 0) {
          const usageBody = SyncUsageInputSchema.parse({ usage });
          await postJson(`${apiUrl}/api/repos/${repoId}/usage`, usageBody, dryRun);
        }
      }

      const events = status.slots.flatMap((slot) =>
        harvestEventsForSlot({
          agentId: slot.agentId,
          workDir: slot.workDir,
          worktreePath: slot.worktreePath,
          branch: slot.branch,
          suffix: slot.suffix,
          sessionCreatedAt: slot.sessionCreatedAt,
          repoPath,
        }).map((event) => ({
          ...event,
          workUnitId: slot.workUnitId,
          attemptId: slot.attemptId,
        })),
      );
      if (events.length > 0) {
        const eventsBody = SyncSessionEventsInputSchema.parse({ events });
        await postJson(`${apiUrl}/api/repos/${repoId}/events`, eventsBody, dryRun);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[har control] usage harvest skipped: ${message}\n`);
    }
  }

  const validations = listValidations(resolveHarnessRoot(repoPath));
  if (validations.length > 0) {
    const validationsBody = SyncValidationsInputSchema.parse({ validations });
    await postJson(`${apiUrl}/api/repos/${repoId}/validations`, validationsBody, dryRun);
  }

  const bindingsBody = SyncValidationBindingsInputSchema.parse({
    bindings: listValidationBindings(resolveHarnessRoot(repoPath)),
  });
  if (bindingsBody.bindings.length > 0) {
    await postJson(
      `${apiUrl}/api/repos/${repoId}/validation-bindings`,
      bindingsBody,
      dryRun,
    );
  }

  const commitBindingsBody = SyncValidationCommitBindingsInputSchema.parse({
    bindings: collectCommitBindingsForSync(sourcePaths),
  });
  if (commitBindingsBody.bindings.length > 0) {
    await postJson(
      `${apiUrl}/api/repos/${repoId}/commit-bindings`,
      commitBindingsBody,
      dryRun,
    );
  }
}

const SYNC_TIMEOUT_MS = 15_000;
const EXPLICIT_SYNC_TIMEOUT_MS = 120_000;

/**
 * Best-effort sync after harness operations. Never rejects.
 *
 * Only a repo in the saved `har control sync` selection is synced (every repo
 * when there is none). A failure is reported on one stderr line — silently
 * dropping it left HQ stale with no sign of why.
 *
 * Callers MUST await this before returning control to the CLI: commands call
 * process.exit() as soon as their work resolves, which kills any still-pending
 * fetch — a fire-and-forget sync is silently dropped.
 */
export async function syncRepoWithControlAsync(repoPath: string): Promise<void> {
  if (process.env.HAR_CONTROL_DISABLED === 'true' || process.env.NODE_ENV === 'test') return;

  const verbose = process.env.HAR_CONTROL_VERBOSE === 'true';
  const canonical = canonicalizeControlRepoPath(repoPath);
  try {
    recordRepoForControlSync(repoPath);
    if (selectedRepos([canonical]).length === 0) {
      // Not verbose-only: Mission Control silently missing a repo's slots is
      // what this line exists to explain.
      process.stderr.write(
        `[har control] sync skipped: ${canonical} is not in the saved sync selection — ` +
          'add it with har control register (or har control sync --select)\n',
      );
      return;
    }

    const apiUrl = getControlApiUrl();
    if (!(await isControlApiReachable(apiUrl))) {
      if (verbose) {
        process.stderr.write(`[har control] sync skipped: not reachable at ${apiUrl}\n`);
      }
      return;
    }
    await runWithDeadline(
      () => syncRepoWithControl({ repoPath: canonical }),
      SYNC_TIMEOUT_MS,
      'control sync',
    );
  } catch (err: unknown) {
    process.stderr.write(
      `[har control] sync of ${path.basename(canonical)} failed: ${errorMessage(err)} — ` +
        'run `har control sync` to retry\n',
    );
  }
}

async function syncRunWithLocalControl(
  repoPath: string,
  run: RunRecord,
  apiUrl: string,
): Promise<void> {
  const registerResult = await registerRepoWithControl({ repoPath, apiUrl });
  let repoId = registerResult?.id;

  if (!repoId) {
    const listResponse = await syncFetch(`${apiUrl}/api/repos`);
    if (!listResponse.ok) return;
    const repos = (await listResponse.json()) as { id: string; path: string }[];
    repoId = repos.find((r) => path.resolve(r.path) === repoPath)?.id;
  }

  if (!repoId) return;

  const runsBody = SyncRunsInputSchema.parse({ runs: [run] });
  await postJson(`${apiUrl}/api/repos/${repoId}/runs`, runsBody);
}

export async function syncRunWithControlAsync(repoPath: string, run: RunRecord): Promise<void> {
  if (process.env.HAR_CONTROL_DISABLED === 'true') return;

  const apiUrl = getControlApiUrl();
  const canonical = canonicalizeControlRepoPath(repoPath);
  if (selectedRepos([canonical]).length === 0) return;

  try {
    if (await isControlApiReachable(apiUrl)) {
      await syncRunWithLocalControl(canonical, run, apiUrl);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[har control] run sync skipped: ${message}\n`);
  }

  const portal = resolvePortalTarget(canonical);
  if (!portal) return;
  if (!isRepoPortalSyncEnabled(canonical)) return;

  try {
    if (!kernoApiUrlFor(portal.url) && !(await isControlApiReachable(portal.url))) return;
    await postPortal(portal, '/api/sync', { path: canonical, runs: [run] });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[har control] run sync skipped: ${message}\n`);
  }
}
