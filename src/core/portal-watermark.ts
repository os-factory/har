import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonicalizeControlRepoPath } from './control-repo-path';

interface PortalSyncStateEntry {
  repoPath: string;
  portalUrl: string;
  lastSyncedAt: string;
  /** Server repo id at last sync; a change means the repo was wiped/recreated. */
  repoId?: string;
  /**
   * Source roots this watermark was advanced over (#255). A source missing here
   * has never been synced to this target, so its records must not be filtered
   * by a timestamp it never contributed to. Absent on legacy entries, which
   * predate multi-source reads and cover the canonical path only.
   */
  sources?: string[];
}

export interface RunsWatermark {
  lastSyncedAt: string;
  repoId?: string;
  sources?: string[];
}

interface PortalSyncState {
  states: PortalSyncStateEntry[];
}

function getStatePath(): string {
  if (process.env.HAR_PORTAL_SYNC_STATE_PATH) {
    return path.resolve(process.env.HAR_PORTAL_SYNC_STATE_PATH);
  }
  return path.join(os.homedir(), '.har', 'portal-sync-state.json');
}

function readState(): PortalSyncState {
  const statePath = getStatePath();
  try {
    if (!fs.existsSync(statePath)) return { states: [] };
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as PortalSyncState;
    return Array.isArray(parsed.states) ? parsed : { states: [] };
  } catch {
    return { states: [] };
  }
}

function writeState(state: PortalSyncState): void {
  const statePath = getStatePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
}

/** Last-sync timestamp for a (repo, portal) pair, or null when never synced. */
export function readPortalWatermark(repoPath: string, portalUrl: string): string | null {
  const canonical = canonicalizeControlRepoPath(repoPath);
  const entry = readState().states.find(
    (state) => state.repoPath === canonical && state.portalUrl === portalUrl,
  );
  return entry?.lastSyncedAt ?? null;
}

export function writePortalWatermark(
  repoPath: string,
  portalUrl: string,
  lastSyncedAt: string,
): void {
  const canonical = canonicalizeControlRepoPath(repoPath);
  const state = readState();
  const existing = state.states.find(
    (entry) => entry.repoPath === canonical && entry.portalUrl === portalUrl,
  );
  if (existing) {
    existing.lastSyncedAt = lastSyncedAt;
  } else {
    state.states.push({ repoPath: canonical, portalUrl, lastSyncedAt });
  }
  writeState(state);
}

export function getPortalWatermarkPath(): string {
  return getStatePath();
}

export function readRunsWatermarkEntry(repoPath: string, target: string): RunsWatermark | null {
  const canonical = canonicalizeControlRepoPath(repoPath);
  const entry = readState().states.find(
    (state) => state.repoPath === canonical && state.portalUrl === target,
  );
  return entry
    ? { lastSyncedAt: entry.lastSyncedAt, repoId: entry.repoId, sources: entry.sources }
    : null;
}

export function writeRunsWatermark(
  repoPath: string,
  target: string,
  repoId: string | undefined,
  lastSyncedAt: string,
  sources?: string[],
): void {
  const canonical = canonicalizeControlRepoPath(repoPath);
  const state = readState();
  const existing = state.states.find(
    (entry) => entry.repoPath === canonical && entry.portalUrl === target,
  );
  const merged = sources
    ? [...new Set([...(existing?.sources ?? [canonical]), ...sources.map((s) => path.resolve(s))])]
    : existing?.sources;
  if (existing) {
    existing.lastSyncedAt = lastSyncedAt;
    existing.repoId = repoId;
    if (merged) existing.sources = merged;
  } else {
    state.states.push({
      repoPath: canonical,
      portalUrl: target,
      lastSyncedAt,
      repoId,
      ...(merged ? { sources: merged } : {}),
    });
  }
  writeState(state);
}

/** Source roots a watermark already covers; legacy entries cover canonical only. */
export function coveredSources(repoPath: string, entry: RunsWatermark | null): string[] {
  return entry?.sources ?? [canonicalizeControlRepoPath(repoPath)];
}

/**
 * Select rows newer than `since` and report the newest timestamp among them.
 * Rows without a comparable timestamp are always included (can't tell → send;
 * the portal upsert is idempotent). `since === null` selects everything.
 */
export function selectSince<T>(
  rows: T[],
  since: string | null,
  getTimestamp: (row: T) => string | null | undefined,
): { selected: T[]; maxSyncedAt: string | null } {
  let maxSyncedAt: string | null = null;
  const selected: T[] = [];

  for (const row of rows) {
    const ts = getTimestamp(row);
    if (since && ts && ts <= since) continue;
    selected.push(row);
    if (ts && (maxSyncedAt === null || ts > maxSyncedAt)) maxSyncedAt = ts;
  }

  return { selected, maxSyncedAt };
}
