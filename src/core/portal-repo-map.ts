import { canonicalizeControlRepoPath } from './control-repo-path';
import { listRegisteredRepos, recordRepoForControlSync } from './control-registry';
import { attachRepoToPortal, listAttachedRepos } from './portal-targets';

/** Registered repos, other than `currentRepo`, not yet attached to the org connection. */
export function unattachedRegisteredRepos(
  currentRepo: string | null,
  registeredRepos: string[] = listRegisteredRepos(),
  attachedRepos: string[] = listAttachedRepos(),
): string[] {
  const skip = new Set(
    [...attachedRepos, ...(currentRepo ? [currentRepo] : [])].map(canonicalizeControlRepoPath),
  );
  return [...new Set(registeredRepos.map(canonicalizeControlRepoPath))].filter(
    (repoPath) => !skip.has(repoPath),
  );
}

/** Attach these repos to the active org connection. */
export function attachReposToPortal(repoPaths: string[]): string[] {
  return repoPaths.map((repoPath) => {
    const canonical = canonicalizeControlRepoPath(repoPath);
    attachRepoToPortal(canonical);
    recordRepoForControlSync(canonical);
    return canonical;
  });
}
