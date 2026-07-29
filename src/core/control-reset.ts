import { getControlApiUrl } from './control-config';
import {
  clearRegisteredRepos,
  listRegisteredRepos,
} from './control-registry';
import {
  scrubLocalHarnessForRepos,
  type HarnessScrubResult,
} from './harness-scrub';

export interface ControlResetOptions {
  apiUrl?: string;
  dryRun?: boolean;
  /** Scrub `.har/{runs,validations,state,slots}` on the host (default true). */
  scrubLocalHarness?: boolean;
  /** Clear `~/.har/repos.json` so auto-sync does not re-register (default true). */
  clearRegistry?: boolean;
}

export interface ControlResetResult {
  ok: true;
  dryRun: boolean;
  repositoriesDeleted: number;
  unregisteredCleared: number;
  scrubLocalHarness: boolean;
  clearRegistry: boolean;
  registryCleared: boolean;
  repoPaths: string[];
  scrubbed: HarnessScrubResult[];
  apiUnreachable?: boolean;
}

async function askYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) => {
    rl.question(question, resolve);
  });
  rl.close();
  return /^[Yy]$/.test(answer.trim());
}

export async function confirmControlReset(options: {
  yes?: boolean;
  repoCount: number;
}): Promise<boolean> {
  if (options.yes) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Non-interactive terminal — pass --yes');
  }
  return askYesNo(
    `Clear Mission Control data for ${options.repoCount} registered repositor${
      options.repoCount === 1 ? 'y' : 'ies'
    } (and scrub local .har history)? [y/N] `,
  );
}

/**
 * Wipe Mission Control via API, scrub local harness dirs on the host, and clear
 * the local sync registry so a later register starts clean.
 */
export async function resetMissionControlFromCli(
  options: ControlResetOptions = {},
): Promise<ControlResetResult> {
  const apiUrl = options.apiUrl ?? getControlApiUrl();
  const scrubLocalHarness = options.scrubLocalHarness !== false;
  const clearRegistry = options.clearRegistry !== false;

  const registryPaths = listRegisteredRepos();
  let apiRepoPaths: string[] = [];
  let apiUnreachable = false;
  let repositoriesDeleted = 0;
  let unregisteredCleared = 0;
  let apiScrubbed: HarnessScrubResult[] = [];

  if (!options.dryRun) {
    try {
      const listResponse = await fetch(`${apiUrl}/api/repos`, {
        signal: AbortSignal.timeout(5000),
      });
      if (listResponse.ok) {
        const repos = (await listResponse.json()) as { path: string }[];
        apiRepoPaths = repos.map((repo) => repo.path);
      } else {
        apiUnreachable = true;
      }
    } catch {
      apiUnreachable = true;
    }
  }

  const repoPaths = [...new Set([...registryPaths, ...apiRepoPaths])].sort();

  let scrubbed: HarnessScrubResult[] = [];
  if (scrubLocalHarness) {
    scrubbed = options.dryRun
      ? repoPaths.flatMap((repoPath) =>
          (['runs', 'validations', 'state', 'slots'] as const).map((directory) => ({
            path: `${repoPath}/.har/${directory}`,
            directory,
            deleted: false,
          })),
        )
      : scrubLocalHarnessForRepos(repoPaths);
  }

  if (!options.dryRun && !apiUnreachable) {
    const response = await fetch(`${apiUrl}/api/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirm: 'RESET',
        // Host scrub already ran; skip duplicate best-effort inside Docker/API.
        scrubLocalHarness: false,
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Control API ${response.status}: ${text || response.statusText}`);
    }
    const payload = (await response.json()) as {
      repositoriesDeleted: number;
      unregisteredCleared: number;
      scrubbed?: HarnessScrubResult[];
    };
    repositoriesDeleted = payload.repositoriesDeleted;
    unregisteredCleared = payload.unregisteredCleared;
    apiScrubbed = payload.scrubbed ?? [];
  } else if (!options.dryRun && apiUnreachable) {
    // Local scrub + registry clear still proceed; dashboard DB needs MC running.
  }

  let registryCleared = false;
  if (clearRegistry) {
    if (options.dryRun) {
      registryCleared = registryPaths.length > 0;
    } else {
      registryCleared = clearRegisteredRepos() > 0;
    }
  }

  return {
    ok: true,
    dryRun: options.dryRun === true,
    repositoriesDeleted: options.dryRun ? repoPaths.length : repositoriesDeleted,
    unregisteredCleared,
    scrubLocalHarness,
    clearRegistry,
    registryCleared,
    repoPaths,
    scrubbed: scrubbed.length > 0 ? scrubbed : apiScrubbed,
    apiUnreachable: apiUnreachable || undefined,
  };
}
