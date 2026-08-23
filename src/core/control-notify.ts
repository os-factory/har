import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { resolveHarnessRoot } from '../harness/manifest';

/**
 * Resolve the har binary the way the shell runtime does: PATH first, then the
 * repo-local node_modules/.bin/har. Undefined when neither is executable.
 */
function resolveHarBin(harnessRoot: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'har');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep scanning */
    }
  }
  const local = path.join(harnessRoot, 'node_modules', '.bin', 'har');
  try {
    fs.accessSync(local, fs.constants.X_OK);
    return local;
  } catch {
    return undefined;
  }
}

/** Lock paths are per-user and shared with the bash runtime so both coalesce together. */
export function controlSyncLockPath(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(os.tmpdir(), `har-control-sync.${uid}`);
}

/**
 * Nudge Mission Control after a slot change without making the caller wait.
 * A sync takes about twenty seconds — too long to block a slot change on it.
 * Detached, and coalesced through a lock directory + pending marker so a run
 * of slot changes leaves one sync going, then one more if needed. The lock
 * protocol matches the bash har_notify_control byte-for-byte, so shell and
 * package callers coalesce against each other.
 */
export function notifyControlSync(repoPath: string): void {
  let root: string;
  try {
    root = resolveHarnessRoot(repoPath);
  } catch {
    root = path.resolve(repoPath);
  }
  const bin = resolveHarBin(root);
  if (!bin) return;

  const lock = controlSyncLockPath();
  try {
    fs.writeFileSync(`${lock}.pending`, '');
    fs.mkdirSync(lock);
  } catch {
    return; // another drainer holds the lock — it will pick up the pending marker
  }

  const script = [
    'trap "" HUP',
    'trap \'rmdir "$1" 2>/dev/null || true\' EXIT',
    'cd "$2" || exit 0',
    'while [ -f "$1.pending" ]; do',
    '  rm -f "$1.pending"',
    '  if command -v timeout >/dev/null 2>&1; then',
    '    timeout 120 "$3" control sync || true',
    '  else',
    '    "$3" control sync || true',
    '  fi',
    'done',
  ].join('\n');

  // Redirected as a whole, not per command: a detached job that keeps the
  // inherited stdio open makes any caller reading that pipe wait for it.
  const child = spawn('bash', ['-c', script, 'bash', lock, root, bin], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}
