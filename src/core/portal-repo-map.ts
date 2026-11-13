import { canonicalizeControlRepoPath } from './control-repo-path';
import { listRegisteredRepos, recordRepoForControlSync } from './control-registry';
import {
  attachRepoToPortal,
  displayPortalTargetLabel,
  getActivePortalConnection,
  listAttachedRepos,
  type PortalTargetRecord,
} from './portal-targets';

export type RepoMapPlan =
  | { kind: 'none' }
  | {
      kind: 'attach-more';
      workspaceAlias: string;
      workspaceLabel: string;
      repos: string[];
    };

/**
 * After `har hq connect` attaches the current checkout, decide whether to offer
 * the other registered repositories. There is only ever one org connection, so
 * the only choice is which not-yet-attached repos also sync to it.
 */
export function planRepoWorkspaceMap(opts: {
  currentRepo: string | null;
  registeredRepos?: string[];
  connection?: PortalTargetRecord | null;
  attachedRepos?: string[];
}): RepoMapPlan {
  const connection = opts.connection === undefined ? getActivePortalConnection() : opts.connection;
  if (!connection) return { kind: 'none' };

  const attached = new Set(
    (opts.attachedRepos ?? listAttachedRepos()).map((repoPath) =>
      canonicalizeControlRepoPath(repoPath),
    ),
  );
  const current = opts.currentRepo ? canonicalizeControlRepoPath(opts.currentRepo) : null;
  const others = (opts.registeredRepos ?? listRegisteredRepos())
    .map((repoPath) => canonicalizeControlRepoPath(repoPath))
    .filter((repoPath) => repoPath !== current && !attached.has(repoPath));
  if (others.length === 0) return { kind: 'none' };

  return {
    kind: 'attach-more',
    workspaceAlias: connection.alias,
    workspaceLabel: displayPortalTargetLabel(connection),
    repos: [...new Set(others)],
  };
}

/** Attach these repos to the active org connection. */
export function attachReposToPortal(repoPaths: string[]): string[] {
  const attached: string[] = [];
  for (const repoPath of repoPaths) {
    const canonical = canonicalizeControlRepoPath(repoPath);
    attachRepoToPortal(canonical);
    recordRepoForControlSync(canonical);
    attached.push(canonical);
  }
  return attached;
}
