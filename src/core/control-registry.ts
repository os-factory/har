import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readManifest } from '../harness/manifest';
import { canonicalizeControlRepoPath, resolveMainWorkingTree } from './control-repo-path';

interface ControlRegistry {
  repos: string[];
  /** Paths that stay on local Mission Control only (skip hosted portal sync). */
  portalOptOut?: string[];
}

function getRegistryPath(): string {
  if (process.env.HAR_CONTROL_REGISTRY_PATH) {
    return path.resolve(process.env.HAR_CONTROL_REGISTRY_PATH);
  }
  return path.join(os.homedir(), '.har', 'repos.json');
}

function normalizeRegistry(raw: Partial<ControlRegistry> | null | undefined): ControlRegistry {
  const repos = Array.isArray(raw?.repos) ? raw.repos.filter((p): p is string => typeof p === 'string') : [];
  const portalOptOut = Array.isArray(raw?.portalOptOut)
    ? raw.portalOptOut.filter((p): p is string => typeof p === 'string')
    : undefined;
  return portalOptOut && portalOptOut.length > 0 ? { repos, portalOptOut } : { repos };
}

function readRegistry(): ControlRegistry {
  const registryPath = getRegistryPath();
  try {
    if (!fs.existsSync(registryPath)) return { repos: [] };
    return normalizeRegistry(JSON.parse(fs.readFileSync(registryPath, 'utf8')) as ControlRegistry);
  } catch {
    return { repos: [] };
  }
}

function writeRegistry(registry: ControlRegistry): void {
  const registryPath = getRegistryPath();
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const normalized = normalizeRegistry(registry);
  fs.writeFileSync(registryPath, JSON.stringify(normalized, null, 2) + '\n');
}

function registryChanged(before: string[], after: string[]): boolean {
  if (before.length !== after.length) return true;
  return before.some((repoPath, index) => repoPath !== after[index]);
}

function pathEqualsCanonical(entry: string, resolved: string): boolean {
  try {
    return canonicalizeControlRepoPath(entry) === resolved;
  } catch {
    return path.resolve(entry) === resolved;
  }
}

function prunePortalOptOut(registry: ControlRegistry, keptRepos: string[]): string[] | undefined {
  const kept = new Set(keptRepos);
  const next: string[] = [];
  const seen = new Set<string>();
  for (const entry of registry.portalOptOut ?? []) {
    let canonical: string;
    try {
      canonical = canonicalizeControlRepoPath(entry);
    } catch {
      canonical = path.resolve(entry);
    }
    if (!kept.has(canonical) || seen.has(canonical)) continue;
    seen.add(canonical);
    next.push(canonical);
  }
  return next.length > 0 ? next : undefined;
}

/** Remember a repo so Mission Control can sync it when the dashboard starts. */
export function recordRepoForControlSync(repoPath: string): void {
  if (process.env.HAR_CONTROL_DISABLED === 'true') return;

  const resolved = canonicalizeControlRepoPath(repoPath);
  if (!resolveMainWorkingTree(resolved)) return;
  if (!readManifest(resolved)) return;

  const registry = readRegistry();
  if (registry.repos.includes(resolved)) return;

  registry.repos.push(resolved);
  writeRegistry(registry);
}

/**
 * Whether this repo may sync to the hosted portal when credentials exist.
 * Default is enabled; only paths listed in `portalOptOut` are skipped.
 */
export function isRepoPortalSyncEnabled(repoPath: string): boolean {
  const resolved = canonicalizeControlRepoPath(repoPath);
  const registry = readRegistry();
  return !(registry.portalOptOut ?? []).some((entry) => pathEqualsCanonical(entry, resolved));
}

/**
 * Persist whether a registered repo should sync to the hosted portal.
 * `enabled: false` opts out; `true` clears a prior opt-out.
 */
export function setRepoPortalSync(repoPath: string, enabled: boolean): void {
  const resolved = canonicalizeControlRepoPath(repoPath);
  const registry = readRegistry();
  const current = registry.portalOptOut ?? [];
  const without = current.filter((entry) => !pathEqualsCanonical(entry, resolved));

  if (enabled) {
    if (without.length === current.length) return;
    writeRegistry({
      repos: registry.repos,
      ...(without.length > 0 ? { portalOptOut: without } : {}),
    });
    return;
  }

  if (without.length !== current.length) return; // already opted out
  writeRegistry({
    repos: registry.repos,
    portalOptOut: [...without, resolved],
  });
}

/** Drop a repo from the local sync registry (does not touch Mission Control DB). */
export function removeRegisteredRepo(repoPath: string): boolean {
  const resolved = canonicalizeControlRepoPath(repoPath);
  const registry = readRegistry();
  const next = registry.repos.filter((entry) => !pathEqualsCanonical(entry, resolved));
  if (next.length === registry.repos.length) return false;
  const portalOptOut = prunePortalOptOut(registry, next);
  writeRegistry({
    repos: next,
    ...(portalOptOut ? { portalOptOut } : {}),
  });
  return true;
}

/** Registered repos that still exist and have a harness manifest. */
export function listRegisteredRepos(): string[] {
  const registry = readRegistry();
  const kept: string[] = [];
  const seen = new Set<string>();

  for (const repoPath of registry.repos) {
    if (!fs.existsSync(repoPath)) continue;
    const canonical = canonicalizeControlRepoPath(repoPath);
    if (!fs.existsSync(canonical) || !readManifest(canonical)) continue;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    kept.push(canonical);
  }

  const prunedOptOut = prunePortalOptOut(registry, kept);
  const optOutBefore = registry.portalOptOut ?? [];
  const optOutChanged =
    (prunedOptOut?.length ?? 0) !== optOutBefore.length ||
    (prunedOptOut ?? []).some((p, i) => p !== optOutBefore[i]);

  if (registryChanged(registry.repos, kept) || optOutChanged) {
    writeRegistry({
      repos: kept,
      ...(prunedOptOut ? { portalOptOut: prunedOptOut } : {}),
    });
  }

  return kept;
}

export function getControlRegistryPath(): string {
  return getRegistryPath();
}

/** Clear every path from the local sync registry. Returns how many entries were removed. */
export function clearRegisteredRepos(): number {
  const registry = readRegistry();
  const count = registry.repos.length;
  if (count === 0 && !(registry.portalOptOut?.length)) return 0;
  writeRegistry({ repos: [] });
  return count;
}
