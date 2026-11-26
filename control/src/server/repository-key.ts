import type { PrismaClient } from '@prisma/client';
import { gitRemoteBrowseUrl } from '@/lib/git-remote-url';

/**
 * How v2 records name a repository (ADR 0005 section 3): by its URL
 * (`vcs.repository.url.full`), never by a local path. A work unit id is scoped
 * to its repository, so the work unit key is (repository key, work unit id).
 *
 * `scripts/migrate-db.cjs` carries a copy of these functions (it runs before
 * the app is built); the migration test checks the two agree.
 */

/** Host and path of a remote, lowercased, without scheme, credentials or `.git`. */
export function repositoryUrlKey(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const browse = gitRemoteBrowseUrl(remote);
  if (!browse) return null;
  try {
    const url = new URL(browse);
    return `${url.hostname}${url.pathname}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    return null;
  }
}

/** The key of a record's `repositoryUrl`: "" when the record has none. */
export function recordRepositoryKey(repositoryUrl: string | null | undefined): string {
  return repositoryUrlKey(repositoryUrl) ?? '';
}

/** The remote as a repository URL without credentials (`vcs.repository.url.full`). */
export function repositoryUrlOf(remote: string | null | undefined): string | null {
  const browse = gitRemoteBrowseUrl(remote);
  if (!browse) return null;
  try {
    const url = new URL(browse);
    url.username = '';
    url.password = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * The key a registered repository's records are scoped to when a 1.x
 * `har control sync` sends them by repository id: its remote, else the
 * repository itself (two remote-less checkouts never share work units).
 */
export function repositoryKeyFor(repository: { id: string; gitRemote: string | null }): string {
  return repositoryUrlKey(repository.gitRemote) ?? `repo:${repository.id}`;
}

type Db = Pick<PrismaClient, 'repository' | 'agentSlot'>;

/**
 * The registered repository a record's URL names, for display only. Several
 * registered checkouts can share a remote (a monorepo registered per harness):
 * the one whose slot holds the attempt, else the one on the attempt's branch,
 * else none.
 */
export async function registeredRepositoryFor(
  db: Db,
  repositoryUrl: string | null | undefined,
  hint: { attemptId?: string | null; branch?: string | null } = {},
): Promise<string | null> {
  const key = repositoryUrlKey(repositoryUrl);
  if (!key) return null;
  const repos = await db.repository.findMany({ select: { id: true, gitRemote: true } });
  const matches = repos.filter((repo) => repositoryUrlKey(repo.gitRemote) === key);
  if (matches.length === 1) return matches[0].id;
  if (matches.length === 0) return null;
  const ids = matches.map((repo) => repo.id);
  if (hint.attemptId) {
    const slot = await db.agentSlot.findFirst({
      where: { repositoryId: { in: ids }, attemptId: hint.attemptId },
      select: { repositoryId: true },
    });
    if (slot) return slot.repositoryId;
  }
  if (hint.branch) {
    const slots = await db.agentSlot.findMany({
      where: { repositoryId: { in: ids }, branch: hint.branch },
      select: { repositoryId: true },
    });
    const owners = [...new Set(slots.map((slot) => slot.repositoryId))];
    if (owners.length === 1) return owners[0];
  }
  return null;
}
