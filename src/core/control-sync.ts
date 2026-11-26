import * as path from 'path';
import { readManifest, resolveHarnessRoot } from '../harness/manifest';
import { readStageRegistry } from '../harness/stages';
import {
  AgentSlotStatus,
  EnvironmentStatus,
  RegisterRepoInput,
  SyncSlotsInputSchema,
} from '../harness/schema';
import { getControlApiUrl, isControlEnabled } from './control-config';
import {
  listRegisteredRepos,
  recordRepoForControlSync,
  removeRegisteredRepo,
} from './control-registry';
import { canonicalizeControlRepoPath } from './control-repo-path';
import {
  collectRunsForSync,
  collectCommitBindingsForSync,
  collectWorkUnitsForSync,
  mergeSlotStatuses,
  resolveSyncSourcePaths,
} from './sync-sources';
import { collectEnvironmentStatus } from './slot-status';
import { listValidations } from './validations';
import { listValidationBindings } from './work-units';
import { createRemoteExecutor } from './cloud-executor';
import { warn } from '../utils/logging';
import {
  isRetryableStatus,
  retryDelayMs,
  runWithDeadline,
  SyncDeadlineError,
  syncFetch,
  throwIfSyncAborted,
} from './sync-request';
import { readSyncSelection, resolveSyncSelection } from './control-sync-selection';
import { snapshotMemo, withStatusSnapshot } from './status-snapshot';

/**
 * Mission Control's local endpoints, outside the ingest contract.
 *
 * The CLI 2.0 sends records, proofs, evidence and telemetry through ingest v2
 * only (ADR 0005 section 7): every receiver, Mission Control included, gets
 * them from `ingest-publish.ts` and otel-hook. What is left here is local to
 * Mission Control and has no v2 record: registering a repository (and listing
 * or unregistering it), and the live view of its slots.
 */

export interface ControlSyncOptions {
  repoPath: string;
  apiUrl?: string;
  dryRun?: boolean;
  cloud?: boolean;
  /** Re-register even if the path was previously unregistered. */
  force?: boolean;
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
  const { repoPath, workspacePath, dryRun } = options;

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
    await syncRepoSlots(apiUrl, existing.id, repoPath, workspacePath, dryRun);
    return;
  }

  if (repoId) {
    await syncRepoSlots(apiUrl, repoId, repoPath, workspacePath, dryRun);
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

/**
 * The live slot view: the slot statuses of every source that stores a session
 * for this repository. Everything else Mission Control holds comes through
 * ingest v2 and OTLP.
 */
async function syncRepoSlots(
  apiUrl: string,
  repoId: string,
  repoPath: string,
  workspacePath?: string,
  dryRun?: boolean,
): Promise<void> {
  const sourcePaths = resolveSyncSourcePaths(repoPath, workspacePath);
  const status: EnvironmentStatus = collectEnvironmentStatusForSync(repoPath, sourcePaths);
  const slotsBody = SyncSlotsInputSchema.parse({
    slots: status.slots,
    generatedAt: status.generatedAt,
  });
  await postJson(`${apiUrl}/api/repos/${repoId}/slots`, slotsBody, dryRun);
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
