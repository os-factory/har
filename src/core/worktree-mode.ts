import { readHarnessEnv } from '../harness/env';
import { resolveHarnessRoot } from '../harness/manifest';
import type { WorktreeMode } from '../harness/schema';
import { resolveMainWorkingTree } from './control-repo-path';
import { parseBoolean } from '../utils/parse-boolean';
import { readOnboardingPreferences } from './onboarding-preferences';

/** Key of a repository in `preferences.worktree.repos`: its main checkout. */
export function worktreePreferenceKey(repoPath: string): string {
  const harnessRoot = resolveHarnessRoot(repoPath);
  return resolveMainWorkingTree(harnessRoot) ?? harnessRoot;
}

/**
 * Whether a launch gets a session worktree, and who decided. Highest first:
 * explicit flag / MCP parameter, `HAR_WORKTREE`, the user's setting for this
 * repo, the user's setting for all repos, the repo's `HARNESS_USE_WORKTREE`,
 * then on.
 */
export function resolveWorktreeMode(repoPath: string, explicit?: boolean): WorktreeMode {
  if (explicit !== undefined) return { enabled: explicit, source: 'flag' };

  const fromEnv = parseBoolean(process.env.HAR_WORKTREE);
  if (fromEnv !== undefined) return { enabled: fromEnv, source: 'env' };

  const preference = readOnboardingPreferences().worktree;
  const forRepo = preference.repos[worktreePreferenceKey(repoPath)];
  if (forRepo) return { enabled: forRepo === 'on', source: 'repo-preference' };
  if (preference.default) return { enabled: preference.default === 'on', source: 'global-preference' };

  const harnessEnv = readHarnessEnv(resolveHarnessRoot(repoPath)).HARNESS_USE_WORKTREE;
  if (harnessEnv !== undefined) {
    return { enabled: parseBoolean(harnessEnv, true), source: 'harness-env' };
  }
  return { enabled: true, source: 'default' };
}

const SOURCE_PHRASES: Record<WorktreeMode['source'], string> = {
  flag: 'set for this launch',
  env: 'HAR_WORKTREE',
  'repo-preference': 'your setting for this repo',
  'global-preference': 'your setting for all repos',
  'harness-env': 'HARNESS_USE_WORKTREE in .har/harness.env',
  default: 'default',
};

/** `Worktree: off (your setting for this repo; run `har worktree on` to change)` */
export function describeWorktreeMode(mode: WorktreeMode): string {
  const state = mode.enabled ? 'on' : 'off';
  const change = `run \`har worktree ${mode.enabled ? 'off' : 'on'}\` to change`;
  return `Worktree: ${state} (${SOURCE_PHRASES[mode.source]}; ${change})`;
}
