/** Convert a git remote (HTTPS or SSH) into a browser URL when possible. */
export function gitRemoteBrowseUrl(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const trimmed = remote.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\.git$/i, '');
  }

  const ssh = trimmed.match(/^git@([^:]+):(.+)$/i);
  if (ssh) {
    const host = ssh[1];
    const path = ssh[2].replace(/\.git$/i, '');
    return `https://${host}/${path}`;
  }

  const sshProtocol = trimmed.match(/^ssh:\/\/git@([^/]+)\/(.+)$/i);
  if (sshProtocol) {
    const host = sshProtocol[1];
    const path = sshProtocol[2].replace(/\.git$/i, '');
    return `https://${host}/${path}`;
  }

  return null;
}
