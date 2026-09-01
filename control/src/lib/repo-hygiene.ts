import * as os from 'os';

export type RepoHiddenReason = 'temporary' | 'missing';

const TEMP_PREFIXES = ['/tmp/', '/private/tmp/', '/var/tmp/', '/var/folders/'];

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
}

/** Lab fixtures and scratch repos live under the OS temp dir. They are registered by tests and
 *  throwaway sessions and are never what a developer wants to see first. */
export function isTemporaryPath(repoPath: string, tmpdir: string = os.tmpdir()): boolean {
  const candidate = normalize(repoPath);
  const prefixes = [...TEMP_PREFIXES, normalize(tmpdir)];
  return prefixes.some((prefix) => candidate.startsWith(prefix));
}

/**
 * Decide whether a registered repository should be hidden from the default list.
 *
 * `hostPathsVisible` guards the "missing" rule: inside the packaged Docker image no host path
 * exists, and hiding everything would be worse than hiding nothing.
 */
export function classifyRepositoryVisibility(input: {
  path: string;
  onDisk: boolean;
  hostPathsVisible: boolean;
  tmpdir?: string;
}): { hidden: boolean; reason?: RepoHiddenReason } {
  if (isTemporaryPath(input.path, input.tmpdir)) return { hidden: true, reason: 'temporary' };
  if (input.hostPathsVisible && !input.onDisk) return { hidden: true, reason: 'missing' };
  return { hidden: false };
}
