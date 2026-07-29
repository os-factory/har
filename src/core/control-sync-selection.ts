import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonicalizeControlRepoPath } from './control-repo-path';

interface SyncSelection {
  repos: string[];
}

function getSelectionPath(): string {
  if (process.env.HAR_CONTROL_SYNC_SELECTION_PATH) {
    return path.resolve(process.env.HAR_CONTROL_SYNC_SELECTION_PATH);
  }
  return path.join(os.homedir(), '.har', 'sync-selection.json');
}

/** Persisted sync selection, or null when the user has never chosen one. */
export function readSyncSelection(): string[] | null {
  const selectionPath = getSelectionPath();
  try {
    if (!fs.existsSync(selectionPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(selectionPath, 'utf8')) as SyncSelection;
    if (!Array.isArray(parsed.repos)) return null;
    return parsed.repos.map((repoPath) => canonicalizeControlRepoPath(repoPath));
  } catch {
    return null;
  }
}

export function writeSyncSelection(repos: string[]): void {
  const selectionPath = getSelectionPath();
  const canonical = Array.from(new Set(repos.map((repoPath) => canonicalizeControlRepoPath(repoPath))));
  fs.mkdirSync(path.dirname(selectionPath), { recursive: true });
  fs.writeFileSync(selectionPath, JSON.stringify({ repos: canonical }, null, 2) + '\n');
}

export function getSyncSelectionPath(): string {
  return getSelectionPath();
}

export interface SyncSelectionResolution {
  /** CLI should open the interactive checkbox with `promptDefaults` pre-checked. */
  needsPrompt: boolean;
  promptDefaults: string[];
  /** Repos to sync directly when `needsPrompt` is false. */
  toSync: string[];
}

/**
 * Decide what `har control sync` should push, given the repos discovered this
 * run and the persisted selection. Pure — the CLI owns the actual prompt and
 * persistence; persisting only ever follows a completed prompt.
 *
 * - First run, interactive → prompt (all discovered pre-checked).
 * - First run, non-TTY → sync all discovered (no persist).
 * - Stored selection, a new repo appeared, interactive → re-prompt (stored + new
 *   pre-checked).
 * - Stored selection otherwise (or non-TTY) → sync the stored set silently.
 * - `--select` (forceSelect), interactive → always prompt (current selection
 *   pre-checked); non-TTY → sync stored/all without prompting.
 */
export function resolveSyncSelection(input: {
  discovered: string[];
  stored: string[] | null;
  forceSelect: boolean;
  isTTY: boolean;
}): SyncSelectionResolution {
  const { discovered, stored, forceSelect, isTTY } = input;
  const discoveredSet = new Set(discovered);
  const effectiveStored = stored ? stored.filter((repo) => discoveredSet.has(repo)) : null;

  if (forceSelect) {
    if (isTTY) {
      const defaults = effectiveStored && effectiveStored.length > 0 ? effectiveStored : discovered;
      return { needsPrompt: true, promptDefaults: defaults, toSync: [] };
    }
    return { needsPrompt: false, promptDefaults: [], toSync: effectiveStored ?? discovered };
  }

  if (effectiveStored === null) {
    if (isTTY) {
      return { needsPrompt: true, promptDefaults: discovered, toSync: [] };
    }
    return { needsPrompt: false, promptDefaults: [], toSync: discovered };
  }

  const newRepos = discovered.filter((repo) => !(stored ?? []).includes(repo));
  if (newRepos.length > 0 && isTTY) {
    return { needsPrompt: true, promptDefaults: [...effectiveStored, ...newRepos], toSync: [] };
  }

  return { needsPrompt: false, promptDefaults: [], toSync: effectiveStored };
}
