import { canonicalizeControlRepoPath } from './control-repo-path';
import { listRegisteredRepos, recordRepoForControlSync } from './control-registry';
import {
  attachRepoPortalTarget,
  displayPortalTargetLabel,
  listPortalTargetRecords,
  type PortalTargetRecord,
} from './portal-targets';

export type RepoMapConnection = { alias: string; label: string };

export type RepoMapPlan =
  | { kind: 'none' }
  | {
      kind: 'attach-more';
      workspaceAlias: string;
      workspaceLabel: string;
      repos: string[];
    }
  | {
      kind: 'map-orgs';
      currentAlias: string;
      repos: string[];
      connections: RepoMapConnection[];
    };

/**
 * After `har hq connect` attaches the current checkout, decide whether to ask
 * about other registered repositories. One saved workspace → checkbox to attach
 * more to that workspace. Several workspaces → pick a destination per repo.
 */
export function planRepoWorkspaceMap(opts: {
  currentRepo: string | null;
  currentAlias: string;
  registeredRepos?: string[];
  connections?: PortalTargetRecord[];
}): RepoMapPlan {
  const registered = (opts.registeredRepos ?? listRegisteredRepos()).map((repoPath) =>
    canonicalizeControlRepoPath(repoPath),
  );
  const current = opts.currentRepo ? canonicalizeControlRepoPath(opts.currentRepo) : null;
  const others = registered.filter((repoPath) => repoPath !== current);
  const connections = opts.connections ?? listPortalTargetRecords();
  if (others.length === 0 || connections.length === 0) return { kind: 'none' };

  if (connections.length === 1) {
    const only = connections[0];
    return {
      kind: 'attach-more',
      workspaceAlias: only.alias,
      workspaceLabel: displayPortalTargetLabel(only),
      repos: others,
    };
  }

  return {
    kind: 'map-orgs',
    currentAlias: opts.currentAlias,
    repos: others,
    connections: connections.map((entry) => ({
      alias: entry.alias,
      label: displayPortalTargetLabel(entry),
    })),
  };
}

export function applyRepoWorkspaceMap(
  assignments: { repoPath: string; alias: string | null }[],
): string[] {
  const attached: string[] = [];
  for (const row of assignments) {
    if (!row.alias) continue;
    const canonical = canonicalizeControlRepoPath(row.repoPath);
    attachRepoPortalTarget(canonical, row.alias);
    recordRepoForControlSync(canonical);
    attached.push(canonical);
  }
  return attached;
}

/** Repos still unassigned after a mapping round — already-picked paths are hidden. */
export function remainingUnassignedRepos(
  repos: string[],
  assigned: Iterable<string>,
): string[] {
  const taken = new Set(
    [...assigned].map((repoPath) => canonicalizeControlRepoPath(repoPath)),
  );
  return repos.filter((repoPath) => !taken.has(canonicalizeControlRepoPath(repoPath)));
}

export function remainingConnections(
  connections: RepoMapConnection[],
  usedAliases: Iterable<string>,
): RepoMapConnection[] {
  const used = new Set([...usedAliases]);
  return connections.filter((entry) => !used.has(entry.alias));
}
