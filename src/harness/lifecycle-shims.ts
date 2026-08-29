import * as fs from 'fs';
import * as path from 'path';
import { getHarnessDir } from './manifest';
import { readStageRegistry, writeStageRegistry } from './stages';
import { MANAGED_SHIM_FILES } from './template-tokens';
import type { HarnessStage } from './schema';

/**
 * Lifecycle `.sh` files 1.0 used to generate as a third entry point (#314).
 * They are no longer written. This list is the prune/detect surface: maintain
 * deletes managed copies; migrate deletes vendored pre-1.0 copies; doctor and
 * the executor treat leftover `command`/`script` pointers as kind-dispatch.
 */
export const LIFECYCLE_SHIM_FILES = MANAGED_SHIM_FILES;

const LIFECYCLE_SHIM_SET = new Set<string>(LIFECYCLE_SHIM_FILES);

/** Kinds the package runtime owns — no `.har/*.sh` file required. */
export const PACKAGE_RUNTIME_KINDS = new Set([
  'launch',
  'verify',
  'teardown',
  'setup',
  'inspect',
]);

export function isLifecycleShimFile(name: string): boolean {
  return LIFECYCLE_SHIM_SET.has(path.basename(name.replace(/^\.\/\.har\//, '').replace(/^\.\//, '')));
}

/** First token of a stage command/script, stripped of `./.har/` prefix. */
export function stageCommandFile(stage: Pick<HarnessStage, 'command' | 'script'>): string | null {
  const raw = (stage.command ?? stage.script ?? '').trim();
  if (!raw) return null;
  return raw
    .split(/\s+/)[0]
    .replace(/^\.\/\.har\//, '')
    .replace(/^\.har\//, '')
    .replace(/^\.\//, '');
}

export function stagePointsAtLifecycleShim(stage: Pick<HarnessStage, 'command' | 'script'>): boolean {
  const file = stageCommandFile(stage);
  return file !== null && isLifecycleShimFile(file);
}

/**
 * Managed shim (#235) or stock ejected wrapper (#239). Vendored pre-1.0
 * runtime bash is neither — migrate deletes those, not this prune.
 */
export function isManagedShimContent(content: string): boolean {
  return content.includes('exec har env') || content.includes('EJECTED runtime');
}

export interface RetireLifecycleShimsResult {
  pruned: string[];
  stagesRewritten: boolean;
}

/**
 * Delete leftover managed/ejected lifecycle wrappers and drop `command`/`script`
 * on stages that pointed at them so the registry dispatches by kind.
 */
export function retireLifecycleShims(repoPath: string): RetireLifecycleShimsResult {
  const harnessDir = getHarnessDir(path.resolve(repoPath));
  const pruned: string[] = [];

  for (const shim of LIFECYCLE_SHIM_FILES) {
    const file = path.join(harnessDir, shim);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    const content = fs.readFileSync(file, 'utf8');
    if (!isManagedShimContent(content)) continue;
    fs.rmSync(file);
    pruned.push(shim);
  }

  const stagesRewritten = stripLifecycleShimCommands(repoPath);
  return { pruned, stagesRewritten };
}

/** Drop command/script when they point at a retired lifecycle wrapper. */
export function stripLifecycleShimCommands(repoPath: string): boolean {
  const resolved = path.resolve(repoPath);
  let registry;
  try {
    registry = readStageRegistry(resolved);
  } catch {
    return false;
  }

  let changed = false;
  const stages = registry.stages.map((stage) => {
    if (!stagePointsAtLifecycleShim(stage)) return stage;
    changed = true;
    const rest = { ...stage };
    delete rest.command;
    delete rest.script;
    return rest;
  });

  if (!changed) return false;
  writeStageRegistry(resolved, { ...registry, stages });
  return true;
}
