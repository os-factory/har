import * as fs from 'fs';
import * as path from 'path';

/**
 * A repository's linked git worktrees, read from `<repo>/.git/worktrees/*`
 * without spawning git: each entry's `gitdir` file names the worktree's `.git`
 * file, and its `HEAD` names the branch. Mission Control uses them to tell a
 * session working in a non-slot worktree from one in the main checkout
 * (ADR 0003).
 */
export interface LinkedWorktree {
  path: string;
  branch: string | null;
}

export interface LinkedWorktrees {
  /**
   * False when the repository's git directory cannot be read (e.g. not
   * mounted): absence proves nothing — even with a reported listing, which
   * may predate a worktree.
   */
  readable: boolean;
  worktrees: LinkedWorktree[];
}

/** A repository row with the listing the CLI last reported for it. */
export interface RepositoryWorktreeSource {
  path: string;
  reportedWorktrees?: unknown;
}

/** Prisma select for `linkedWorktreesOf`. */
export const REPOSITORY_WORKTREE_COLUMNS = { id: true, path: true, reportedWorktrees: true } as const;

export function parseReportedWorktrees(value: unknown): LinkedWorktree[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const { path: worktreePath, branch } = entry as { path?: unknown; branch?: unknown };
    if (typeof worktreePath !== 'string' || !worktreePath) return [];
    return [{ path: worktreePath, branch: typeof branch === 'string' && branch ? branch : null }];
  });
}

const CACHE_TTL_MS = 10_000;
const cache = new Map<string, { at: number; value: LinkedWorktrees }>();

function readTrimmed(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function branchFromHead(head: string | null): string | null {
  const match = head?.match(/^ref:\s*refs\/heads\/(.+)$/);
  return match ? match[1] : null;
}

/** `maxAgeMs` lets a caller that missed re-read a listing older than that (a worktree added since). */
export function listLinkedWorktrees(
  repoPath: string,
  now = Date.now(),
  maxAgeMs = CACHE_TTL_MS,
): LinkedWorktrees {
  const cached = cache.get(repoPath);
  if (cached && now - cached.at < maxAgeMs) return cached.value;

  const gitDir = path.join(repoPath, '.git');
  let value: LinkedWorktrees;
  try {
    if (!fs.statSync(gitDir).isDirectory()) throw new Error('not a main checkout');
    const root = path.join(gitDir, 'worktrees');
    const entries = fs.existsSync(root) ? fs.readdirSync(root) : [];
    const worktrees: LinkedWorktree[] = [];
    for (const entry of entries) {
      const dotGit = readTrimmed(path.join(root, entry, 'gitdir'));
      if (!dotGit) continue;
      worktrees.push({
        path: path.dirname(path.resolve(root, entry, dotGit)),
        branch: branchFromHead(readTrimmed(path.join(root, entry, 'HEAD'))),
      });
    }
    value = { readable: true, worktrees };
  } catch {
    value = { readable: false, worktrees: [] };
  }
  cache.set(repoPath, { at: now, value });
  return value;
}

export function clearLinkedWorktreeCache(): void {
  cache.clear();
}

/**
 * A repository's linked worktrees as Mission Control can know them: read from
 * its git directory when that is visible (run from source), else the listing
 * the CLI last reported from the host (docker, where only `/data` is mounted).
 */
export function linkedWorktreesOf(
  repo: RepositoryWorktreeSource,
  now = Date.now(),
  maxAgeMs = CACHE_TTL_MS,
): LinkedWorktrees {
  const local = listLinkedWorktrees(repo.path, now, maxAgeMs);
  if (local.readable) return local;
  return { readable: false, worktrees: parseReportedWorktrees(repo.reportedWorktrees) };
}
