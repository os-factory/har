import { execFileSync } from 'child_process';
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

export interface Pm2ResolveDeps {
  /** Absolute path of the pm2 CLI shipped with @osfactory/har, or undefined. */
  resolveBundled?: () => string | undefined;
  commandExists?: (command: string) => boolean;
  packageRunner?: () => string;
  /** Runtime that executes the bundled CLI (node, or bun under bunx). */
  execPath?: string;
}

/**
 * Locates the pm2 CLI that ships as a dependency of @osfactory/har. esbuild
 * leaves `require.resolve` alone, so the bundled dist resolves it from its own
 * node_modules at runtime — pm2 is never inlined into dist/index.js.
 */
export function resolveBundledPm2(): string | undefined {
  try {
    return require.resolve('pm2/bin/pm2');
  } catch {
    return undefined;
  }
}

/**
 * The argv that runs pm2, in preference order:
 *   1. HAR's own pm2 dependency via the current runtime — pinned to the version
 *      HAR ships, no global install, ~10x cheaper than a package runner;
 *   2. `pm2` on PATH;
 *   3. the package runner (`npx --yes pm2`, `bunx pm2`, …).
 */
export function resolvePm2Argv(deps: Pm2ResolveDeps = {}): string[] {
  const bundled = (deps.resolveBundled ?? resolveBundledPm2)();
  if (bundled) return [deps.execPath ?? process.execPath, bundled];
  if ((deps.commandExists ?? commandExists)('pm2')) return ['pm2'];
  return [...(deps.packageRunner ?? packageRunner)().split(' ').filter(Boolean), 'pm2'];
}

let cachedArgv: string[] | undefined;

/** Memoized {@link resolvePm2Argv} for the running process. */
export function pm2Argv(): string[] {
  if (cachedArgv === undefined) cachedArgv = resolvePm2Argv();
  return [...cachedArgv];
}

function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** {@link pm2Argv} as a shell command line, for remediation text and `sh -c`. */
export function pm2Command(): string {
  return pm2Argv().map(shellQuote).join(' ');
}

/** Test seam — clears the memoized pm2 argv. */
export function resetPm2CommandCache(): void {
  cachedArgv = undefined;
}

/** Live PM2 process list; [] when no daemon runs, undefined when pm2 cannot be queried. */
export function listPm2Processes(): Pm2Process[] | undefined {
  if (!pm2DaemonRunning()) return [];
  try {
    const [cmd, ...args] = pm2Argv();
    const raw = execFileSync(cmd, [...args, 'jlist'], {
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
