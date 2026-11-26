import * as crypto from 'crypto';
import * as fs from 'fs';

/**
 * A synchronous, cross-process exclusive lock on one file, for short
 * read-modify-write sections.
 *
 * The lock is `<target>.lock`, created with O_EXCL and holding the owner's pid
 * and a random token. A waiter retries until `timeoutMs` and then throws
 * {@link FileLockTimeoutError}; it never waits forever and never proceeds
 * without the lock. A lock is reclaimed only when it is older than `staleMs`
 * AND its owner pid is not alive (or the file names no pid at all, e.g. a crash
 * between create and write). A live owner is never robbed, however old its
 * lock: a stuck holder makes waiters time out loudly instead.
 */

export interface FileLockOptions {
  /** Total time to wait for the lock (default 10 s). */
  timeoutMs?: number;
  /** Minimum age before a lock whose owner is dead may be reclaimed (default 2 s). */
  staleMs?: number;
  /** Pause between attempts (default 10 ms, jittered). */
  retryMs?: number;
}

export const FILE_LOCK_DEFAULTS = { timeoutMs: 10_000, staleMs: 2_000, retryMs: 10 } as const;

export class FileLockTimeoutError extends Error {
  readonly lockFile: string;
  readonly holderPid: number | undefined;
  readonly waitedMs: number;

  constructor(lockFile: string, holderPid: number | undefined, waitedMs: number) {
    const holder = holderPid === undefined ? 'an unknown process' : `pid ${holderPid}`;
    super(
      `Timed out after ${waitedMs} ms waiting for lock ${lockFile} (held by ${holder}). ` +
        `Nothing was written. If no such process is running, delete ${lockFile} and retry.`,
    );
    this.name = 'FileLockTimeoutError';
    this.lockFile = lockFile;
    this.holderPid = holderPid;
    this.waitedMs = waitedMs;
  }
}

export function lockFileFor(target: string): string {
  return `${target}.lock`;
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, ms);
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as NodeJS.ErrnoException).code : undefined;
}

/** True when a process with this pid exists (EPERM: exists, owned by someone else). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) === 'EPERM';
  }
}

interface LockOwner {
  pid?: number;
  token?: string;
}

function readOwner(lock: string): LockOwner | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(lock, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    const { pid, token } = parsed as Record<string, unknown>;
    return {
      pid: typeof pid === 'number' ? pid : undefined,
      token: typeof token === 'string' ? token : undefined,
    };
  } catch (err) {
    // Gone between stat and read, or empty / partly written: no owner known.
    return errorCode(err) === 'ENOENT' ? undefined : {};
  }
}

function tryCreate(lock: string, token: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(lock, 'wx', 0o600);
  } catch (err) {
    if (errorCode(err) === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() }));
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/**
 * Move a stale lock out of the way. Renaming first makes reclaim race-safe: of
 * two reclaimers only one rename succeeds. If what we moved is not the lock we
 * judged stale (it was reclaimed and re-created in between), put it back.
 */
function reclaim(lock: string, judged: fs.Stats): void {
  const aside = `${lock}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.stale`;
  try {
    fs.renameSync(lock, aside);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return;
    throw err;
  }
  try {
    const moved = fs.statSync(aside);
    if (moved.ino !== judged.ino || moved.dev !== judged.dev) {
      try {
        fs.linkSync(aside, lock);
      } catch {
        // A newer lock already took its place; the robbed owner keeps its token check.
      }
    }
  } finally {
    fs.rmSync(aside, { force: true });
  }
}

/** Acquire the lock, returning its token. Throws {@link FileLockTimeoutError}. */
export function acquireFileLock(target: string, options: FileLockOptions = {}): string {
  const timeoutMs = options.timeoutMs ?? FILE_LOCK_DEFAULTS.timeoutMs;
  const staleMs = options.staleMs ?? FILE_LOCK_DEFAULTS.staleMs;
  const retryMs = options.retryMs ?? FILE_LOCK_DEFAULTS.retryMs;
  const lock = lockFileFor(target);
  const token = crypto.randomBytes(12).toString('hex');
  const started = Date.now();
  let holderPid: number | undefined;

  for (;;) {
    if (tryCreate(lock, token)) return token;

    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(lock);
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') throw err;
    }
    if (stat) {
      const owner = readOwner(lock);
      holderPid = owner?.pid;
      const old = Date.now() - stat.mtimeMs >= staleMs;
      if (owner && old && (owner.pid === undefined || !pidAlive(owner.pid))) {
        reclaim(lock, stat);
        continue;
      }
    }

    const waited = Date.now() - started;
    if (waited >= timeoutMs) throw new FileLockTimeoutError(lock, holderPid, waited);
    sleepSync(Math.min(retryMs + Math.floor(Math.random() * retryMs), Math.max(1, timeoutMs - waited)));
  }
}

/** Release a lock acquired with `token`; a lock someone else now holds is left alone. */
export function releaseFileLock(target: string, token: string): void {
  const lock = lockFileFor(target);
  if (readOwner(lock)?.token !== token) return;
  fs.rmSync(lock, { force: true });
}

/** Run `fn` while holding the lock on `target`. */
export function withFileLock<T>(target: string, fn: () => T, options: FileLockOptions = {}): T {
  const token = acquireFileLock(target, options);
  try {
    return fn();
  } finally {
    releaseFileLock(target, token);
  }
}
