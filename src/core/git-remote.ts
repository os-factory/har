import { execSync } from 'child_process';

/** `origin`'s URL, or undefined outside a git checkout or without that remote. */
export function readGitRemote(repoPath: string): string | undefined {
  try {
    const remote = execSync('git remote get-url origin', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    return remote || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A remote as a repository URL safe to export (`vcs.repository.url.full`):
 * user, password, query and fragment are dropped, since remotes can embed
 * tokens. scp-style `user@host:path` becomes `ssh://host/path`. Anything that
 * is not a URL (a local path) is undefined.
 */
export function sanitizeGitRemoteUrl(remote: string | undefined): string | undefined {
  const raw = remote?.trim();
  if (!raw) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.host ? url.toString() : undefined;
    } catch {
      return undefined;
    }
  }
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(raw);
  if (scp) return `ssh://${scp[1]}/${scp[2].replace(/^\/+/, '')}`;
  return undefined;
}
