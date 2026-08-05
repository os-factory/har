import * as path from 'path';
import { readManifest, resolveHarnessRoot } from '../harness/manifest';
import { readStageRegistry } from '../harness/stages';
import {
  EnvironmentStatus,
  RegisterRepoInput,
  RunRecord,
  SyncRunsInputSchema,
  SyncSlotsInputSchema,
  SyncWorkUnitsInputSchema,
  SyncValidationBindingsInputSchema,
  SyncSessionEventsInputSchema,
  SyncUsageInputSchema,
  SyncValidationsInputSchema,
} from '../harness/schema';
import {
  getControlApiUrl,
  getPortalTarget,
  isControlEnabled,
  PortalTarget,
} from './control-config';
import {
  listRegisteredRepos,
  recordRepoForControlSync,
  removeRegisteredRepo,
} from './control-registry';
import { readPortalCredentials, writePortalCredentials } from './portal-credentials';
import { canonicalizeControlRepoPath } from './control-repo-path';
import { collectEnvironmentStatus } from './slot-status';
import { listRuns } from './runs';
import { listValidations } from './validations';
import {
  listValidationBindings,
  listWorkAttempts,
  listWorkUnits,
} from './work-units';
import { createRemoteExecutor } from './cloud-executor';
import { isTelemetryEnabled } from './telemetry-config';
import { warn } from '../utils/logging';
import { harvestEventsForSlot, harvestUsageForSlot, omitHarvestEventsWhenOtelPresent, omitHarvestWhenOtelPresent } from './usage-harvest';
import { buildSessionKey } from './telemetry-env';
import { fetchPersistedPortalTelemetry } from './control-persisted-usage';
import { dedupePortalEvents, mergePortalUsage } from './portal-usage-merge';
import { enrichUsageWithPricing } from '../harness/schema';
import {
  readPortalWatermark,
  writePortalWatermark,
  readRunsWatermarkEntry,
  writeRunsWatermark,
  selectSince,
} from './portal-watermark';
import type { AgentSessionEvent, AgentSessionUsage } from '../harness/schema';

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

export interface ControlRegisterOptions extends ControlSyncOptions {
  gitRemote?: string;
}

/** Per-request byte cap: a single POST of a large run history gets the connection
 * dropped (undici UND_ERR_SOCKET), so unbounded collections chunk under this. */
const DEFAULT_MAX_BATCH_BYTES = 4 * 1024 * 1024;

function maxSyncBatchBytes(): number {
  const raw = Number(process.env.HAR_SYNC_MAX_BATCH_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_BATCH_BYTES;
}

export function chunkBySerializedSize<T>(items: T[], maxBytes: number): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;

  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
    if (current.length > 0 && currentBytes + itemBytes > maxBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += itemBytes;
  }
  if (current.length > 0) batches.push(current);

  return batches;
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
): Promise<void> {
  const ordered = [...newRuns].sort((a, b) => runTimestamp(a).localeCompare(runTimestamp(b)));
  const batches = chunkBySerializedSize(ordered, maxSyncBatchBytes());
  const toSend = batches.length > 0 ? batches : [[]];
  for (let i = 0; i < toSend.length; i++) {
    const batch = toSend[i];
    await send(batch, i);
    if (!dryRun && batch.length > 0) {
      writeRunsWatermark(repoPath, runsTarget, getRepoId(), runTimestamp(batch[batch.length - 1]));
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
    try {
      return await fetch(url, { method: 'POST', headers, body: payload });
    } catch (err) {
      // Retry network throws (e.g. a keep-alive socket dropped after a big batch)
      // — every sync POST is an idempotent upsert, so a fresh connection is safe.
      lastErr = err;
      if (attempt < MAX_FETCH_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 100));
      }
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

function postPortalOnce(
  target: PortalTarget,
  endpoint: string,
  body: unknown,
): Promise<Response> {
  return postForResponse(
    `${target.url}${endpoint}`,
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

  let response: Response;
  try {
    response = await fetch(`${target.url}/api/cli/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${target.refreshToken}` },
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;

  const data = (await response.json().catch(() => null)) as {
    token?: string;
    expiresAt?: string;
  } | null;
  if (!data?.token) return false;

  target.token = data.token;
  const stored = readPortalCredentials();
  if (stored) {
    writePortalCredentials({ ...stored, token: data.token, expiresAt: data.expiresAt });
  }
  return true;
}

async function postPortal(
  target: PortalTarget,
  endpoint: string,
  body: unknown,
  dryRun?: boolean,
): Promise<Record<string, unknown> | null> {
  if (dryRun) return null;

  let response = await postPortalOnce(target, endpoint, body);

  if (
    (response.status === 401 || response.status === 403) &&
    (await refreshPortalToken(target))
  ) {
    response = await postPortalOnce(target, endpoint, body);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `har-portal rejected the ingest token (HTTP ${response.status}) — run \`har control login\` (or check HAR_PORTAL_TOKEN).`,
      );
    }
    const text = await response.text().catch(() => '');
    throw new Error(`har-portal sync failed: HTTP ${response.status}${text ? ` — ${text}` : ''}`);
  }

  return (await response.json().catch(() => null)) as Record<string, unknown> | null;
}

function resolvePortalUserEmail(): string | undefined {
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

async function collectPortalTelemetry(
  repoPath: string,
  slots: EnvironmentStatus['slots'],
  controlApiUrl: string,
  since: string | null,
): Promise<{
  usage: Record<string, unknown>[];
  events: Record<string, unknown>[];
  maxSyncedAt: string | null;
}> {
  if (!isTelemetryEnabled()) return { usage: [], events: [], maxSyncedAt: null };
  try {
    const userEmail = resolvePortalUserEmail();
    const fallbackAgentId =
      slots.length > 0 ? Math.min(...slots.map((slot) => slot.agentId)) : null;
    const liveUsage: AgentSessionUsage[] = slots.flatMap((slot) =>
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

    const persisted = await fetchPersistedPortalTelemetry(repoPath, controlApiUrl, { since });

    const harvestedUsage = omitHarvestWhenOtelPresent(liveUsage, persisted.usage);
    const harvestedEvents = omitHarvestEventsWhenOtelPresent(liveEvents, persisted.events);

    const usage = mergePortalUsage(harvestedUsage, persisted.usage).map((row) => {
      const priced = enrichUsageWithPricing(row);
      const models = modelsFromBreakdown(
        priced.modelBreakdown as Record<string, unknown> | undefined,
      );
      return {
        ...priced,
        ...(userEmail ? { userEmail } : {}),
        ...(models.length > 0 ? { models } : {}),
      };
    });

    const events = dedupePortalEvents(harvestedEvents, persisted.events).map((event) =>
      dropNullFields({ ...event }),
    );

    return { usage, events, maxSyncedAt: persisted.maxSyncedAt };
  } catch {
    return { usage: [], events: [], maxSyncedAt: null };
  }
}

async function buildPortalPayload(
  repoPath: string,
  controlApiUrl: string,
  since: string | null,
  full = false,
): Promise<{
  syncBody: Record<string, unknown>;
  runs: RunRecord[];
  events: Record<string, unknown>[];
  maxSyncedAt: string | null;
}> {
  const runs = listRuns(repoPath);
  const status = collectEnvironmentStatus(repoPath);
  const manifest = readManifest(repoPath);
  const stagesRegistry = readStageRegistry(repoPath);
  const harnessRoot = resolveHarnessRoot(repoPath);
  const validations = listValidations(harnessRoot);
  const workUnits = listWorkUnits(harnessRoot);
  const attempts = listWorkAttempts(harnessRoot);
  const validationBindings = listValidationBindings(harnessRoot);
  // Attribute runs/validations to the syncing member so the portal can resolve
  // a real user FK instead of the lossy (repo, agentId) derivation.
  const userEmail = resolvePortalUserEmail();
  const { usage, events, maxSyncedAt } = await collectPortalTelemetry(
    repoPath,
    status.slots,
    controlApiUrl,
    since,
  );

  if (full && isTelemetryEnabled() && usage.length === 0 && runs.some((r) => r.agentId != null)) {
    warn(
      `${path.basename(repoPath)}: agent runs found but no usage harvested — attribution will be missing. ` +
        'This happens when agent sessions ran outside the har worktree slot (e.g. in the main checkout). ' +
        'Run agents inside `har env launch`.',
    );
  }

  const syncBody: Record<string, unknown> = {
    path: repoPath,
    ...(status.gitRemote ? { gitRemote: status.gitRemote } : {}),
    ...(manifest ? { manifest } : {}),
    ...(stagesRegistry ? { stagesRegistry } : {}),
    slots: status.slots,
    generatedAt: status.generatedAt,
    ...(validations.length > 0
      ? {
          validations: userEmail
            ? validations.map((v) => ({ ...v, userEmail }))
            : validations,
        }
      : {}),
    ...(workUnits.length > 0 ? { workUnits } : {}),
    ...(attempts.length > 0 ? { attempts } : {}),
    ...(validationBindings.length > 0 ? { validationBindings } : {}),
    ...(usage.length > 0 ? { usage } : {}),
  };

  const runsPayload = userEmail
    ? runs.map((run) => ({ ...run, userEmail }))
    : runs;

  return { syncBody, runs: runsPayload, events, maxSyncedAt };
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

export interface SyncRepoResult {
  repoPath: string;
  ok: boolean;
  error?: string;
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
}): Promise<{ synced: number; failed: number; results: SyncRepoResult[] }> {
  const apiUrl = options.apiUrl ?? getControlApiUrl();
  const results: SyncRepoResult[] = [];
  let synced = 0;
  let failed = 0;

  for (const repoPath of options.repoPaths) {
    try {
      await withTimeout(
        syncRepoWithControl({ repoPath, apiUrl, dryRun: options.dryRun, cloud: options.cloud, full: options.full }),
        EXPLICIT_SYNC_TIMEOUT_MS,
        'control sync',
      );
      synced++;
      results.push({ repoPath, ok: true });
    } catch (err: unknown) {
      failed++;
      results.push({ repoPath, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { synced, failed, results };
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

  const repoPaths = await discoverHarRepos({ apiUrl, cwd: options?.cwd });
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

  const response = await fetch(`${apiUrl}/api/repos`, {
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
  options: ControlSyncOptions & { repoPath: string },
): Promise<void> {
  const apiUrl = options.apiUrl ?? getControlApiUrl();
  const { repoPath, dryRun, full } = options;

  const registerResult = await registerRepoWithControl({ ...options, repoPath });
  const repoId = registerResult?.id;

  if (!repoId && !dryRun) {
    const listResponse = await fetch(`${apiUrl}/api/repos`);
    if (!listResponse.ok) throw new Error('Failed to list repos from Control API');
    const repos = (await listResponse.json()) as { id: string; path: string }[];
    const existing = repos.find((r) => path.resolve(r.path) === repoPath);
    if (!existing) {
      // Unregistered / blocked — nothing to sync locally.
      return;
    }
    await syncRepoRunsAndSlots(apiUrl, existing.id, repoPath, dryRun, full);
    return;
  }

  if (repoId) {
    await syncRepoRunsAndSlots(apiUrl, repoId, repoPath, dryRun, full);
  }
}

async function syncRepoWithPortal(
  options: ControlSyncOptions & { repoPath: string },
  controlApiUrl: string,
): Promise<void> {
  const portal = getPortalTarget();
  if (!portal) return;

  const { repoPath, dryRun, full } = options;
  const since = full ? null : readPortalWatermark(repoPath, portal.url);

  const runsTarget = runsWatermarkTarget(portal.url);
  const stored = full ? null : readRunsWatermarkEntry(repoPath, runsTarget);
  const runsSince = rewindSince(stored?.lastSyncedAt ?? null);
  const { syncBody, runs, events, maxSyncedAt } = await buildPortalPayload(
    repoPath,
    controlApiUrl,
    since,
    full,
  );
  const { selected: newRuns } = selectSince(runs, runsSince, runTimestamp);

  let repoId: string | undefined;
  await syncRunBatches(newRuns, repoPath, runsTarget, () => repoId, dryRun, async (batch, i) => {
    const body = i === 0 ? { ...syncBody, runs: batch } : { path: repoPath, runs: batch };
    const res = await postPortal(portal, '/api/sync', body, dryRun);
    if (i === 0 && typeof res?.repositoryId === 'string') repoId = res.repositoryId;
  });

  // Repo id changed → the portal repo was wiped; resend the whole history.
  if (!full && !dryRun && stored?.repoId && repoId && stored.repoId !== repoId) {
    await syncRunBatches(listRuns(repoPath), repoPath, runsTarget, () => repoId, dryRun, async (batch) => {
      await postPortal(portal, '/api/sync', { path: repoPath, runs: batch }, dryRun);
    });
  }

  for (const batch of chunkBySerializedSize(events, maxSyncBatchBytes())) {
    await postPortal(portal, '/api/otel', { path: repoPath, events: batch, spans: [] }, dryRun);
  }
  if (!dryRun && maxSyncedAt) {
    writePortalWatermark(repoPath, portal.url, maxSyncedAt);
  }
}

export async function syncRepoWithControl(options: ControlSyncOptions): Promise<void> {
  const repoPath = canonicalizeControlRepoPath(options.repoPath);
  const apiUrl = options.apiUrl ?? getControlApiUrl();

  if (options.cloud) {
    const remote = createRemoteExecutor();
    if (!remote) {
      throw new Error('HAR Cloud not configured (set HAR_CLOUD_API_URL and HAR_CLOUD_API_KEY)');
    }
    const runs = listRuns(repoPath);
    const status = collectEnvironmentStatus(repoPath);
    const harnessRoot = resolveHarnessRoot(repoPath);
    const response = await fetch(`${process.env.HAR_CLOUD_API_URL}/api/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.HAR_CLOUD_API_KEY}`,
      },
      body: JSON.stringify({
        path: repoPath,
        runs,
        slots: status.slots,
        workUnits: listWorkUnits(harnessRoot),
        attempts: listWorkAttempts(harnessRoot),
        validations: listValidations(harnessRoot),
        validationBindings: listValidationBindings(harnessRoot),
      }),
    });
    if (!response.ok) {
      throw new Error(`Cloud sync failed: ${response.status}`);
    }
    return;
  }

  await syncRepoWithLocalControl({ ...options, repoPath, apiUrl });
  await syncRepoWithPortal({ ...options, repoPath }, apiUrl);
}

async function syncRepoRunsAndSlots(
  apiUrl: string,
  repoId: string,
  repoPath: string,
  dryRun?: boolean,
  full?: boolean,
): Promise<void> {
  const runsTarget = runsWatermarkTarget(apiUrl);
  const stored = full ? null : readRunsWatermarkEntry(repoPath, runsTarget);
  const runsSince = rewindSince(stored?.repoId === repoId ? (stored?.lastSyncedAt ?? null) : null);
  const runs = listRuns(repoPath);
  const { selected: newRuns } = selectSince(runs, runsSince, runTimestamp);

  await syncRunBatches(newRuns, repoPath, runsTarget, () => repoId, dryRun, async (batch) => {
    await postJson(`${apiUrl}/api/repos/${repoId}/runs`, SyncRunsInputSchema.parse({ runs: batch }), dryRun);
  });

  const status: EnvironmentStatus = collectEnvironmentStatus(repoPath);
  const slotsBody = SyncSlotsInputSchema.parse({
    slots: status.slots,
    generatedAt: status.generatedAt,
  });
  await postJson(`${apiUrl}/api/repos/${repoId}/slots`, slotsBody, dryRun);

  const workUnitsBody = SyncWorkUnitsInputSchema.parse({
    workUnits: listWorkUnits(resolveHarnessRoot(repoPath)),
    attempts: listWorkAttempts(resolveHarnessRoot(repoPath)),
  });
  if (workUnitsBody.workUnits.length > 0 || workUnitsBody.attempts.length > 0) {
    await postJson(`${apiUrl}/api/repos/${repoId}/work-units`, workUnitsBody, dryRun);
  }

  if (isTelemetryEnabled() && process.env.NODE_ENV !== 'test') {
    try {
      const userEmail = resolvePortalUserEmail();
      const usage = status.slots.flatMap((slot) =>
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
}

const SYNC_TIMEOUT_MS = 15_000;
const EXPLICIT_SYNC_TIMEOUT_MS = 120_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Best-effort sync after harness operations. Never rejects.
 *
 * Callers MUST await this before returning control to the CLI: commands call
 * process.exit() as soon as their work resolves, which kills any still-pending
 * fetch — a fire-and-forget sync is silently dropped.
 */
export async function syncRepoWithControlAsync(repoPath: string): Promise<void> {
  if (process.env.HAR_CONTROL_DISABLED === 'true' || process.env.NODE_ENV === 'test') return;

  const verbose = process.env.HAR_CONTROL_VERBOSE === 'true';
  try {
    recordRepoForControlSync(repoPath);

    const apiUrl = getControlApiUrl();
    if (!(await isControlApiReachable(apiUrl))) {
      if (verbose) {
        process.stderr.write(`[har control] sync skipped: not reachable at ${apiUrl}\n`);
      }
      return;
    }
    const canonical = canonicalizeControlRepoPath(repoPath);
    await withTimeout(
      syncRepoWithControl({ repoPath: canonical }),
      SYNC_TIMEOUT_MS,
      'control sync',
    );
  } catch (err: unknown) {
    if (verbose) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[har control] sync skipped: ${message}\n`);
    }
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
    const listResponse = await fetch(`${apiUrl}/api/repos`);
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

  try {
    if (await isControlApiReachable(apiUrl)) {
      await syncRunWithLocalControl(canonical, run, apiUrl);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[har control] run sync skipped: ${message}\n`);
  }

  const portal = getPortalTarget();
  if (!portal) return;

  try {
    if (!(await isControlApiReachable(portal.url))) return;
    await postPortal(portal, '/api/sync', { path: canonical, runs: [run] });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[har control] run sync skipped: ${message}\n`);
  }
}
