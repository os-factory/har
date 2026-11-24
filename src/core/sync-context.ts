import * as path from 'path';

const dirtyRepos = new Set<string>();
let syncAllRegistered = false;

export function markDirty(repoPath: string): void {
  if (!repoPath) return;
  dirtyRepos.add(path.resolve(repoPath));
}

export function markAllRegisteredDirty(): void {
  syncAllRegistered = true;
}

export function hasPendingSync(): boolean {
  return syncAllRegistered || dirtyRepos.size > 0;
}

export async function syncDirtyRepos(): Promise<void> {
  if (!hasPendingSync()) return;

  const repos = [...dirtyRepos];
  const all = syncAllRegistered;
  dirtyRepos.clear();
  syncAllRegistered = false;

  try {
    const { syncRepoWithControlAsync, syncAllKnownReposWithControl } =
      await import('./control-sync');
    const { canonicalizeControlRepoPath } = await import('./control-repo-path');
    // A repo the all-repos pass already synced is not sent again.
    const done = new Set<string>();
    if (all) {
      const result = await syncAllKnownReposWithControl();
      for (const repo of result.repoPaths ?? []) done.add(repo);
    }
    for (const repo of repos) {
      if (done.has(repo) || done.has(canonicalizeControlRepoPath(repo))) continue;
      await syncRepoWithControlAsync(repo);
    }
  } catch {
    // best-effort; the watermark reships anything missed on the next edge
  }
}
