import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { commandExists, packageRunner } from './package-runner';

export interface Pm2Process {
  name?: string;
  pm2_env?: { pm_cwd?: string; cwd?: string; status?: string };
}

function pm2Home(env: NodeJS.ProcessEnv): string {
  return env.PM2_HOME ?? path.join(env.HOME ?? os.homedir(), '.pm2');
}

/**
 * Whether a PM2 God daemon is alive for this PM2_HOME. Without one there are
 * no processes to list, and `pm2 jlist` would boot a daemon just to answer.
 */
export function pm2DaemonRunning(env: NodeJS.ProcessEnv = process.env): boolean {
  let pid: number;
  try {
    pid = Number.parseInt(fs.readFileSync(path.join(pm2Home(env), 'pm2.pid'), 'utf8').trim(), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

let cachedCommand: string | undefined;

/**
 * `pm2` when it is on PATH, otherwise the package runner (`npx --yes pm2`, …).
 * The direct binary answers in ~80ms; the runner re-resolves the package on
 * every call and costs several hundred ms of CPU.
 */
export function pm2Command(): string {
  if (cachedCommand === undefined) {
    cachedCommand = commandExists('pm2') ? 'pm2' : `${packageRunner()} pm2`;
  }
  return cachedCommand;
}

/** Test seam — clears the memoized pm2 command. */
export function resetPm2CommandCache(): void {
  cachedCommand = undefined;
}

/** Live PM2 process list; [] when no daemon runs, undefined when pm2 cannot be queried. */
export function listPm2Processes(): Pm2Process[] | undefined {
  if (!pm2DaemonRunning()) return [];
  try {
    const raw = execSync(`${pm2Command()} jlist`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 3000,
    });
    const procs = JSON.parse(raw) as Pm2Process[];
    return Array.isArray(procs) ? procs : undefined;
  } catch {
    return undefined;
  }
}
