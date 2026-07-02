import * as path from 'path';
import { readManifest, resolveHarnessRoot } from '../harness/manifest';
import { readStageRegistry } from '../harness/stages';
import {
  EnvironmentStatus,
  RegisterRepoInput,
  RunRecord,
  SyncRunsInputSchema,
  SyncSlotsInputSchema,
  SyncValidationsInputSchema,
} from '../harness/schema';
import { getControlApiUrl } from './control-config';
import { collectEnvironmentStatus } from './slot-status';
import { listRuns } from './runs';
import { listValidations } from './validations';
import { createRemoteExecutor } from './cloud-executor';

export interface ControlSyncOptions {
  repoPath: string;
  apiUrl?: string;
  dryRun?: boolean;
  cloud?: boolean;
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

export async function registerRepoWithControl(
  options: ControlRegisterOptions,
): Promise<{ id: string } | null> {
  const repoPath = path.resolve(options.repoPath);
  const apiUrl = options.apiUrl ?? getControlApiUrl();
  const manifest = readManifest(repoPath);
  const stagesRegistry = readStageRegistry(repoPath);

  const body: RegisterRepoInput = {
    path: repoPath,
    gitRemote: options.gitRemote,
    manifest: manifest ?? undefined,
    stagesRegistry: stagesRegistry ?? undefined,
  };

  return postJson<{ id: string }>(`${apiUrl}/api/repos`, body, options.dryRun);
}

export async function syncRepoWithControl(options: ControlSyncOptions): Promise<void> {
  const repoPath = path.resolve(options.repoPath);
  const apiUrl = options.apiUrl ?? getControlApiUrl();

  if (options.cloud) {
    const remote = createRemoteExecutor();
    if (!remote) {
      throw new Error('HAR Cloud not configured (set HAR_CLOUD_API_URL and HAR_CLOUD_API_KEY)');
    }
    const runs = listRuns(repoPath);
    const status = collectEnvironmentStatus(repoPath);
    const response = await fetch(`${process.env.HAR_CLOUD_API_URL}/api/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.HAR_CLOUD_API_KEY}`,
      },
      body: JSON.stringify({ path: repoPath, runs, slots: status.slots }),
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
    if (!existing) throw new Error(`Repo not registered: ${repoPath}`);
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

  const validations = listValidations(resolveHarnessRoot(repoPath));
  if (validations.length > 0) {
    const validationsBody = SyncValidationsInputSchema.parse({ validations });
    await postJson(`${apiUrl}/api/repos/${repoId}/validations`, validationsBody, dryRun);
  }
}

/** Fire-and-forget sync after harness operations. Never throws. */
export function syncRepoWithControlAsync(repoPath: string): void {
  if (process.env.HAR_CONTROL_DISABLED === 'true' || process.env.NODE_ENV === 'test') return;

  void syncRepoWithControl({ repoPath }).catch((err: unknown) => {
    if (process.env.HAR_CONTROL_VERBOSE === 'true') {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[har control] sync skipped: ${message}\n`);
    }
  });
}

export async function syncRunWithControlAsync(repoPath: string, run: RunRecord): Promise<void> {
  if (process.env.HAR_CONTROL_DISABLED === 'true') return;

  const apiUrl = getControlApiUrl();
  try {
    const reachable = await isControlApiReachable(apiUrl);
    if (!reachable) return;

    const registerResult = await registerRepoWithControl({ repoPath, apiUrl });
    let repoId = registerResult?.id;

    if (!repoId) {
      const listResponse = await fetch(`${apiUrl}/api/repos`);
      if (!listResponse.ok) return;
      const repos = (await listResponse.json()) as { id: string; path: string }[];
      repoId = repos.find((r) => path.resolve(r.path) === path.resolve(repoPath))?.id;
    }

    if (!repoId) return;

    const runsBody = SyncRunsInputSchema.parse({ runs: [run] });
    await postJson(`${apiUrl}/api/repos/${repoId}/runs`, runsBody);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[har control] run sync skipped: ${message}\n`);
  }
}
