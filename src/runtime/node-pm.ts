import * as fs from 'fs';
import * as path from 'path';
import { realSystemOps, SystemOps } from './exec';

/**
 * Node package-manager resolution — TS home of the logic in
 * runtime-bundles/shared-kernel/lib/node-pm.sh (#234). Same formulas:
 * declared manager (HARNESS_NODE_PACKAGE_MANAGER → package.json
 * "packageManager" → lockfile), fallback to whatever is installed, and
 * substitute installs never migrate the repo's lockfile.
 */

/** Package managers HAR can drive, in fallback preference order. */
export const NODE_PACKAGE_MANAGERS = ['npm', 'bun', 'pnpm', 'yarn'] as const;

export type HarnessEnv = Record<string, string | undefined>;

/**
 * Package manager the repo declares: an explicit HARNESS_NODE_PACKAGE_MANAGER
 * wins, then package.json "packageManager", then the lockfile. Empty string
 * when the repo says nothing.
 */
export function declaredNodePackageManager(
  dir: string,
  env: HarnessEnv = {},
  _ops: SystemOps = realSystemOps,
): string {
  void _ops;
  const explicit = env.HARNESS_NODE_PACKAGE_MANAGER;
  if (explicit) return explicit;

  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    // Same tolerant extraction as the sed in node-pm.sh: a lowercase manager
    // name before the "@" of "packageManager", even if the JSON is imperfect.
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const match = raw.match(/"packageManager"\s*:\s*"([a-z]*)@/);
    if (match && match[1]) return match[1];
  }

  if (fs.existsSync(path.join(dir, 'bun.lock')) || fs.existsSync(path.join(dir, 'bun.lockb'))) return 'bun';
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(dir, 'package-lock.json'))) return 'npm';
  return '';
}

/**
 * Package manager to actually run. A manager the repo declares but this
 * machine lacks falls back to one that is installed, so a repo pinned to npm
 * still provisions on a bun-only machine (and the reverse).
 */
export function nodePackageManager(
  dir: string,
  env: HarnessEnv = {},
  ops: SystemOps = realSystemOps,
): string {
  const declared = declaredNodePackageManager(dir, env, ops);
  if (declared && ops.which(declared)) return declared;
  for (const candidate of NODE_PACKAGE_MANAGERS) {
    if (ops.which(candidate)) return candidate;
  }
  return declared || 'npm';
}

/** Lockfile a manager writes, so a substitute install can clean up after itself. */
export function nodeLockfile(manager: string): string {
  switch (manager) {
    case 'bun':
      return 'bun.lock';
    case 'npm':
      return 'package-lock.json';
    case 'pnpm':
      return 'pnpm-lock.yaml';
    case 'yarn':
      return 'yarn.lock';
    default:
      return '';
  }
}

/**
 * Install dependencies in a directory. When a substitute manager stands in
 * for the one the repo declares, any lockfile it creates is removed
 * afterwards: provisioning must not migrate the repo to a different package
 * manager. (bun writes bun.lock even under --no-save.)
 */
export async function nodeInstall(
  dir: string,
  manager: string,
  declared: string = '',
  ops: SystemOps = realSystemOps,
): Promise<number> {
  const substituting = declared !== '' && declared !== manager;
  const lockfile = substituting ? nodeLockfile(manager) : '';
  const hadLockfile = lockfile !== '' && fs.existsSync(path.join(dir, lockfile));

  const result = await ops.run(manager, ['install', '--silent'], { cwd: dir, stream: true });

  if (substituting && !hadLockfile && lockfile !== '') {
    fs.rmSync(path.join(dir, lockfile), { force: true });
    if (manager === 'bun') fs.rmSync(path.join(dir, 'bun.lockb'), { force: true });
  }
  return result.code;
}

/**
 * Package runner (npx equivalent) for one-off CLIs such as pm2, including the
 * flag that keeps it non-interactive. Takes a manager name, or none to
 * resolve from the environment and PATH.
 */
export function pkgExec(
  manager?: string,
  env: HarnessEnv = {},
  ops: SystemOps = realSystemOps,
): string {
  switch (manager || env.HARNESS_NODE_PACKAGE_MANAGER || '') {
    case 'bun':
      return 'bunx';
    case 'pnpm':
      return 'pnpm dlx';
    case 'yarn':
      return 'yarn dlx';
    case 'npm':
      return 'npx --yes';
  }
  if (ops.which('npx')) return 'npx --yes';
  if (ops.which('bunx')) return 'bunx';
  if (ops.which('pnpm')) return 'pnpm dlx';
  return 'npx --yes';
}
