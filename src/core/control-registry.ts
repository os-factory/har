import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readManifest } from '../harness/manifest';

interface ControlRegistry {
  repos: string[];
}

function getRegistryPath(): string {
  if (process.env.HAR_CONTROL_REGISTRY_PATH) {
    return path.resolve(process.env.HAR_CONTROL_REGISTRY_PATH);
  }
  return path.join(os.homedir(), '.har', 'repos.json');
}

function readRegistry(): ControlRegistry {
  const registryPath = getRegistryPath();
  try {
    if (!fs.existsSync(registryPath)) return { repos: [] };
    return JSON.parse(fs.readFileSync(registryPath, 'utf8')) as ControlRegistry;
  } catch {
    return { repos: [] };
  }
}

function writeRegistry(registry: ControlRegistry): void {
  const registryPath = getRegistryPath();
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
}

/** Remember a repo so Mission Control can sync it when the dashboard starts. */
export function recordRepoForControlSync(repoPath: string): void {
  if (process.env.HAR_CONTROL_DISABLED === 'true') return;

  const resolved = path.resolve(repoPath);
  if (!readManifest(resolved)) return;

  const registry = readRegistry();
  if (registry.repos.includes(resolved)) return;

  registry.repos.push(resolved);
  writeRegistry(registry);
}

/** Registered repos that still exist and have a harness manifest. */
export function listRegisteredRepos(): string[] {
  const registry = readRegistry();
  const kept = registry.repos.filter((repoPath) => fs.existsSync(repoPath) && readManifest(repoPath));

  if (kept.length !== registry.repos.length) {
    writeRegistry({ repos: kept });
  }

  return kept;
}

export function getControlRegistryPath(): string {
  return getRegistryPath();
}
