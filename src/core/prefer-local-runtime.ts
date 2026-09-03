import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { getHarPackageVersion } from './package-version';
import { compareSemver } from '../utils/semver';

const PACKAGE_NAME = '@osfactory/har';

export interface PreferredRuntime {
  entryPath: string;
  version: string;
  reason: 'har-repo' | 'node_modules';
}

function readPackageJson(dir: string): { name?: string; version?: string; bin?: unknown } | null {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      name?: string;
      version?: string;
      bin?: unknown;
    };
  } catch {
    return null;
  }
}

function resolveHarEntry(pkgDir: string, pkg: { bin?: unknown }): string | null {
  let rel = 'dist/index.js';
  if (pkg.bin && typeof pkg.bin === 'object' && pkg.bin !== null && 'har' in pkg.bin) {
    const bin = (pkg.bin as { har?: unknown }).har;
    if (typeof bin === 'string' && bin.length > 0) rel = bin;
  } else if (typeof pkg.bin === 'string' && pkg.bin.length > 0) {
    rel = pkg.bin;
  }
  const entry = path.resolve(pkgDir, rel);
  return fs.existsSync(entry) ? entry : null;
}

function sameFile(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

function considerCandidate(
  candidate: PreferredRuntime | null,
  currentVersion: string,
  currentEntry: string | undefined,
): PreferredRuntime | null {
  if (!candidate) return null;
  if (currentEntry && sameFile(candidate.entryPath, currentEntry)) return null;
  if (compareSemver(candidate.version, currentVersion) <= 0) return null;
  return candidate;
}

function inspectDir(dir: string): PreferredRuntime | null {
  const pkg = readPackageJson(dir);
  if (pkg?.name === PACKAGE_NAME && pkg.version) {
    const entry = resolveHarEntry(dir, pkg);
    if (entry) return { entryPath: entry, version: pkg.version, reason: 'har-repo' };
  }

  const nestedDir = path.join(dir, 'node_modules', PACKAGE_NAME);
  const nested = readPackageJson(nestedDir);
  if (nested?.name === PACKAGE_NAME && nested.version) {
    const entry = resolveHarEntry(nestedDir, nested);
    if (entry) return { entryPath: entry, version: nested.version, reason: 'node_modules' };
  }

  return null;
}

function walkParents(start: string): string[] {
  const out: string[] = [];
  let current = path.resolve(start);
  const { root } = path.parse(current);
  for (;;) {
    out.push(current);
    if (current === root) break;
    current = path.dirname(current);
  }
  return out;
}

/**
 * Find a newer @osfactory/har next to `cwd` (the HAR repo itself, or
 * node_modules/@osfactory/har) so a stale global install is not used.
 */
export function findPreferredLocalRuntime(options: {
  cwd: string;
  currentVersion: string;
  currentEntry?: string;
  extraRoots?: string[];
}): PreferredRuntime | null {
  const seen = new Set<string>();
  const roots = [...(options.extraRoots ?? []).map((r) => path.resolve(r)), ...walkParents(options.cwd)];

  for (const dir of roots) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const found = considerCandidate(inspectDir(dir), options.currentVersion, options.currentEntry);
    if (found) return found;
  }

  return null;
}

/**
 * Re-exec a newer repo-local HAR when the running binary is stale (#344).
 * No-op when already re-exec'd, skipped, or no newer local runtime exists.
 */
export function maybeReexecPreferredRuntime(): void {
  if (process.env.HAR_USING_LOCAL_RUNTIME || process.env.HAR_SKIP_LOCAL_RUNTIME) {
    return;
  }

  const currentVersion = getHarPackageVersion();
  const extraRoots = process.env.HAR_ROOT ? [process.env.HAR_ROOT] : [];
  const found = findPreferredLocalRuntime({
    cwd: process.cwd(),
    currentVersion,
    currentEntry: process.argv[1],
    extraRoots,
  });
  if (!found) return;

  process.stderr.write(
    `Using repo-local @osfactory/har ${found.version} (this CLI is ${currentVersion})\n`,
  );
  const result = spawnSync(process.execPath, [found.entryPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, HAR_USING_LOCAL_RUNTIME: '1' },
  });
  process.exit(result.status ?? 1);
}
