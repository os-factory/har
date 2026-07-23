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
import { getControlApiUrl, isControlEnabled } from './control-config';
import { listRegisteredRepos, removeRegisteredRepo } from './control-registry';
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
import { harvestEventsForSlot, harvestUsageForSlot } from './usage-harvest';
import { buildSessionKey } from './telemetry-env';

export interface ControlSyncOptions {
  repoPath: string;
  apiUrl?: string;
  dryRun?: boolean;
  cloud?: boolean;
  /** Re-register even if the path was previously unregistered. */
  force?: boolean;
}

export interface ControlRegisterOptions extends ControlSyncOptions {
  gitRemote?: string;
}

async function postJson<T>(url: string, body: unknown, dryRun?: boolean): Promise<T | null> {
  if (dryRun) return null;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Control API ${response.status}: ${text || response.statusText}`);
  }

  return (await response.json()) as T;
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

export async function syncAllKnownReposWithControl(options?: {
  apiUrl?: string;
  cwd?: string;
}): Promise<{ synced: number; failed: number }> {
  if (!isControlEnabled()) return { synced: 0, failed: 0 };

  const apiUrl = options?.apiUrl ?? getControlApiUrl();
  if (!(await isControlApiReachable(apiUrl))) {
    return { synced: 0, failed: 0 };
  }

  const repoPaths = new Set<string>(listRegisteredRepos());

  if (options?.cwd) {
    const cwd = canonicalizeControlRepoPath(options.cwd);
    if (readManifest(cwd)) repoPaths.add(cwd);
  }

  try {
    const listResponse = await fetch(`${apiUrl}/api/repos`);
    if (listResponse.ok) {
      const repos = (await listResponse.json()) as { path: string }[];
      for (const repo of repos) {
        const resolved = canonicalizeControlRepoPath(repo.path);
        if (readManifest(resolved)) repoPaths.add(resolved);
      }
    }
  } catch {
    // Best-effort — registry + cwd repos are enough for first sync.
  }

  let synced = 0;
  let failed = 0;
  for (const repoPath of repoPaths) {
    try {
      await withTimeout(syncRepoWithControl({ repoPath, apiUrl }), SYNC_TIMEOUT_MS, 'control sync');
      synced++;
    } catch {
      failed++;
    }
  }

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

  const registerResult = await registerRepoWithControl({ ...options, repoPath });
  const repoId = registerResult?.id;

  if (!repoId && !options.dryRun) {
    const listResponse = await fetch(`${apiUrl}/api/repos`);
    if (!listResponse.ok) throw new Error('Failed to list repos from Control API');
    const repos = (await listResponse.json()) as { id: string; path: string }[];
    const existing = repos.find((r) => path.resolve(r.path) === repoPath);
    if (!existing) {
      // Unregistered / blocked — nothing to sync.
      return;
    }
    await syncRepoRunsAndSlots(apiUrl, existing.id, repoPath, options.dryRun);
    return;
  }

  if (repoId) {
    await syncRepoRunsAndSlots(apiUrl, repoId, repoPath, options.dryRun);
  }
}

async function syncRepoRunsAndSlots(
  apiUrl: string,
  repoId: string,
  repoPath: string,
  dryRun?: boolean,
): Promise<void> {
  const runs = listRuns(repoPath);
  const runsBody = SyncRunsInputSchema.parse({ runs });
  await postJson(`${apiUrl}/api/repos/${repoId}/runs`, runsBody, dryRun);

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
    const apiUrl = getControlApiUrl();
    if (!(await isControlApiReachable(apiUrl))) {
      if (verbose) {
        process.stderr.write(`[har control] sync skipped: control API not reachable at ${apiUrl}\n`);
      }
      return;
    }
    const canonical = canonicalizeControlRepoPath(repoPath);
    await withTimeout(
      syncRepoWithControl({ repoPath: canonical, apiUrl }),
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

export async function syncRunWithControlAsync(repoPath: string, run: RunRecord): Promise<void> {
  if (process.env.HAR_CONTROL_DISABLED === 'true') return;

  const apiUrl = getControlApiUrl();
  try {
    const reachable = await isControlApiReachable(apiUrl);
    if (!reachable) return;

    const canonical = canonicalizeControlRepoPath(repoPath);
    const registerResult = await registerRepoWithControl({ repoPath: canonical, apiUrl });
    let repoId = registerResult?.id;

    if (!repoId) {
      const listResponse = await fetch(`${apiUrl}/api/repos`);
      if (!listResponse.ok) return;
      const repos = (await listResponse.json()) as { id: string; path: string }[];
      repoId = repos.find((r) => path.resolve(r.path) === canonical)?.id;
    }

    if (!repoId) return;

    const runsBody = SyncRunsInputSchema.parse({ runs: [run] });
    await postJson(`${apiUrl}/api/repos/${repoId}/runs`, runsBody);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[har control] run sync skipped: ${message}\n`);
  }
}
