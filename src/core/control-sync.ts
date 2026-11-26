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
import { getControlApiUrl, isControlEnabled } from './control-config';
import {
  listRegisteredRepos,
  recordRepoForControlSync,
  removeRegisteredRepo,
} from './control-registry';
import { readPortalCredentials } from './portal-credentials';
import { canonicalizeControlRepoPath } from './control-repo-path';
import {
  collectRunsBySource,
  collectRunsForSync,
  collectCommitBindingsForSync,
  collectWorkUnitsForSync,
  mergeSlotStatuses,
  resolveSyncSourcePaths,
  selectRunsForSync,
} from './sync-sources';
import { collectEnvironmentStatus } from './slot-status';
import { listValidations } from './validations';
import { listValidationBindings } from './work-units';
import { createRemoteExecutor } from './cloud-executor';
import { isTelemetryEnabled } from './telemetry-config';
import { warn } from '../utils/logging';
import { harvestEventsForSlot, harvestUsageForSlot } from './usage-harvest';
import {
  collectSessionAttribution,
  parseRemoteSessionBindings,
  type AttributionSlot,
} from './session-attribution-sync';
import { buildSessionKey } from './telemetry-env';
import { chunkBySerializedSize, maxSyncBatchBytes } from './sync-batches';
import {
  coveredSources,
  readRunsWatermarkEntry,
  writeRunsWatermark,
  selectSince,
} from './sync-watermark';
import type { AgentSessionUsage } from '../harness/schema';
import {
  isRetryableStatus,
  retryDelayMs,
  runWithDeadline,
  SyncDeadlineError,
  syncFetch,
  throwIfSyncAborted,
} from './sync-request';
import { readSyncSelection, resolveSyncSelection } from './control-sync-selection';
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
  /** Ignore the runs watermark and resend every run. */
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

function resolvePortalUserEmail(): string | undefined {
  return readPortalCredentials()?.email || undefined;
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

export async function isControlApiReachable(apiUrl = getControlApiUrl(), timeoutMs = 2000): Promise<boolean> {
  try {
    const response = await fetch(`${apiUrl}/api/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
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
 * only; it neither scans the filesystem nor depends on Mission Control state.
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

/**
 * Sync every selected repo with Mission Control. Nothing happens while it is
 * disabled or unreachable. `repoPaths` lists the repos this call synced, so a
 * caller can skip them.
 */
export async function syncAllKnownReposWithControl(options?: {
  apiUrl?: string;
  cwd?: string;
}): Promise<{ synced: number; failed: number; repoPaths: string[] }> {
  const apiUrl = options?.apiUrl ?? getControlApiUrl();
  if (!isControlEnabled() || !(await isControlApiReachable(apiUrl))) {
    return { synced: 0, failed: 0, repoPaths: [] };
  }
  const selected = selectedRepos(await discoverHarRepos({ apiUrl, cwd: options?.cwd }));
  const { synced, failed } = await syncReposWithControl({ repoPaths: selected, apiUrl });
  return { synced, failed, repoPaths: selected };
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

export async function syncRepoWithControl(
  options: ControlSyncOptions,
): Promise<{ warnings: string[] }> {
  // One read of slots, pm2 and git for the whole sync.
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

  await syncRepoWithLocalControl({ ...options, repoPath, workspacePath, apiUrl });
  return { warnings: [] };
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
 * dropping it left Mission Control stale with no sign of why.
 *
 * Callers MUST await this before returning control to the CLI: commands call
 * process.exit() as soon as their work resolves, which kills any still-pending
 * fetch — a fire-and-forget sync is silently dropped.
 */
export async function syncRepoWithControlAsync(repoPath: string): Promise<void> {
  if (process.env.NODE_ENV === 'test') return;

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
    const controlEnabled = isControlEnabled();
    if (!controlEnabled || !(await isControlApiReachable(apiUrl))) {
      if (verbose && controlEnabled) {
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
}
