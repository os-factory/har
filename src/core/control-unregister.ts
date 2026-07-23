import * as fs from 'fs';
import * as path from 'path';
import { canonicalizeControlRepoPath } from './control-repo-path';
import { removeRegisteredRepo } from './control-registry';
import { getControlApiUrl } from './control-config';
import { listSlotRegistryEntries } from './slot-registry';
import { collectEnvironmentStatus } from './slot-status';
import { createRunService } from './run-service';

export interface SessionWorktreeCandidate {
  agentId: number;
  worktreePath: string;
  workDir?: string;
  branch?: string;
  dirty?: boolean;
  exists: boolean;
}

export interface UnregisterOptions {
  repoPath: string;
  apiUrl?: string;
  dryRun?: boolean;
  deleteWorktrees?: boolean;
}

export interface UnregisterWorktreeOutcome {
  path: string;
  agentId?: number;
  deleted: boolean;
  error?: string;
}

export interface UnregisterResult {
  ok: true;
  id: string | null;
  path: string;
  removedFromRegistry: boolean;
  deleteWorktrees: boolean;
  worktrees: UnregisterWorktreeOutcome[];
  apiUnreachable?: boolean;
}

/** Collect session worktrees that unregister may propose deleting. */
export function listUnregisterWorktreeCandidates(repoPath: string): SessionWorktreeCandidate[] {
  const harnessRoot = canonicalizeControlRepoPath(repoPath);
  const byPath = new Map<string, SessionWorktreeCandidate>();

  const add = (partial: Omit<SessionWorktreeCandidate, 'exists'> & { exists?: boolean }) => {
    const resolved = path.resolve(partial.worktreePath);
    if (!resolved || resolved === harnessRoot) return;
    const exists = partial.exists ?? fs.existsSync(resolved);
    const prev = byPath.get(resolved);
    if (prev) {
      byPath.set(resolved, {
        ...prev,
        dirty: prev.dirty || partial.dirty,
        branch: prev.branch ?? partial.branch,
        workDir: prev.workDir ?? partial.workDir,
      });
      return;
    }
    byPath.set(resolved, {
      agentId: partial.agentId,
      worktreePath: resolved,
      workDir: partial.workDir,
      branch: partial.branch,
      dirty: partial.dirty,
      exists,
    });
  };

  for (const entry of listSlotRegistryEntries(harnessRoot)) {
    const worktreePath = entry.worktreePath ?? entry.workDir;
    if (!worktreePath) continue;
    add({
      agentId: entry.agentId,
      worktreePath,
      workDir: entry.workDir,
      branch: entry.branch,
    });
  }

  try {
    const status = collectEnvironmentStatus(harnessRoot);
    for (const slot of status.slots) {
      const worktreePath = slot.worktreePath ?? slot.workDir;
      if (!worktreePath) continue;
      add({
        agentId: slot.agentId,
        worktreePath,
        workDir: slot.workDir,
        branch: slot.branch,
        dirty: slot.dirty === true,
      });
    }
  } catch {
    // Slot status is best-effort when the harness is incomplete.
  }

  return [...byPath.values()].sort((a, b) => a.agentId - b.agentId);
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

/** Prompt helpers for CLI unregister (default No). */
export async function confirmUnregister(options: {
  yes?: boolean;
  worktrees: SessionWorktreeCandidate[];
}): Promise<{ proceed: boolean; deleteWorktrees: boolean }> {
  if (options.yes) {
    return { proceed: true, deleteWorktrees: false };
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Non-interactive terminal — pass --yes (and optionally --delete-worktrees)');
  }

  const proceed = await askYesNo('Unregister this repository from Mission Control? [y/N] ');
  if (!proceed) return { proceed: false, deleteWorktrees: false };

  const existing = options.worktrees.filter((w) => w.exists);
  if (existing.length === 0) {
    return { proceed: true, deleteWorktrees: false };
  }

  process.stderr.write('\nSession worktrees:\n');
  for (const wt of existing) {
    const dirty = wt.dirty ? ' (dirty)' : '';
    process.stderr.write(`  agent-${wt.agentId}: ${wt.worktreePath}${dirty}\n`);
  }

  const deleteWorktrees = await askYesNo(
    `Also delete ${existing.length} session worktree(s) on disk? [y/N] `,
  );
  return { proceed: true, deleteWorktrees };
}

async function deleteJson<T>(
  url: string,
  body: unknown,
  dryRun?: boolean,
): Promise<{ ok: true; data: T } | { ok: false; status: number; text: string } | null> {
  if (dryRun) return null;

  const response = await fetch(url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return { ok: false, status: response.status, text: text || response.statusText };
  }

  return { ok: true, data: (await response.json()) as T };
}

async function teardownWorktrees(
  repoPath: string,
  candidates: SessionWorktreeCandidate[],
  dryRun?: boolean,
): Promise<UnregisterWorktreeOutcome[]> {
  const outcomes: UnregisterWorktreeOutcome[] = [];
  const service = createRunService();
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (!candidate.exists) continue;
    if (seen.has(candidate.worktreePath)) continue;
    seen.add(candidate.worktreePath);

    if (dryRun) {
      outcomes.push({ path: candidate.worktreePath, agentId: candidate.agentId, deleted: false });
      continue;
    }

    try {
      const result = await service.teardownEnvironment({
        repoPath,
        agentId: candidate.agentId,
        capture: false,
        trigger: 'cli',
      });
      if (result.code !== 0) {
        // Teardown may fail if the slot registry was already cleared; remove the directory.
        if (fs.existsSync(candidate.worktreePath)) {
          fs.rmSync(candidate.worktreePath, { recursive: true, force: true });
        }
      }
      outcomes.push({
        path: candidate.worktreePath,
        agentId: candidate.agentId,
        deleted: !fs.existsSync(candidate.worktreePath),
        error: result.code !== 0 && fs.existsSync(candidate.worktreePath) ? result.stderr : undefined,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        if (fs.existsSync(candidate.worktreePath)) {
          fs.rmSync(candidate.worktreePath, { recursive: true, force: true });
        }
      } catch {
        // ignore secondary failure
      }
      outcomes.push({
        path: candidate.worktreePath,
        agentId: candidate.agentId,
        deleted: !fs.existsSync(candidate.worktreePath),
        error: message,
      });
    }
  }

  return outcomes;
}

/**
 * Unregister a repository from Mission Control and the local sync registry.
 * Optionally tears down session worktrees on the host.
 */
export async function unregisterRepoWithControl(
  options: UnregisterOptions,
): Promise<UnregisterResult> {
  const repoPath = canonicalizeControlRepoPath(options.repoPath);
  const apiUrl = options.apiUrl ?? getControlApiUrl();
  const deleteWorktrees = options.deleteWorktrees === true;
  const candidates = listUnregisterWorktreeCandidates(repoPath);

  let id: string | null = null;
  let apiUnreachable = false;
  let apiWorktrees: UnregisterWorktreeOutcome[] = [];

  if (!options.dryRun) {
    try {
      const listResponse = await fetch(`${apiUrl}/api/repos`, {
        signal: AbortSignal.timeout(5000),
      });
      if (listResponse.ok) {
        const repos = (await listResponse.json()) as { id: string; path: string }[];
        id = repos.find((r) => canonicalizeControlRepoPath(r.path) === repoPath)?.id ?? null;
      } else {
        apiUnreachable = true;
      }
    } catch {
      apiUnreachable = true;
    }
  }

  if (id && !options.dryRun) {
    const deleted = await deleteJson<{
      ok: true;
      id: string;
      path: string;
      deleteWorktrees: boolean;
      worktrees: UnregisterWorktreeOutcome[];
    }>(`${apiUrl}/api/repos/${id}`, { deleteWorktrees: false }, options.dryRun);

    if (deleted && !deleted.ok && deleted.status !== 404) {
      throw new Error(`Control API ${deleted.status}: ${deleted.text}`);
    }
    if (deleted?.ok) {
      apiWorktrees = deleted.data.worktrees ?? [];
    }
  } else if (!id && !options.dryRun && !apiUnreachable) {
    // Not in MC — still clear local registry / worktrees.
  }

  const removedFromRegistry = options.dryRun ? false : removeRegisteredRepo(repoPath);

  let worktrees: UnregisterWorktreeOutcome[] = apiWorktrees;
  if (deleteWorktrees) {
    worktrees = await teardownWorktrees(repoPath, candidates, options.dryRun);
  } else {
    worktrees = candidates
      .filter((c) => c.exists)
      .map((c) => ({ path: c.worktreePath, agentId: c.agentId, deleted: false }));
  }

  return {
    ok: true,
    id,
    path: repoPath,
    removedFromRegistry,
    deleteWorktrees,
    worktrees,
    apiUnreachable: apiUnreachable || undefined,
  };
}
