import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonicalizeControlRepoPath } from './control-repo-path';

interface PortalSyncStateEntry {
  repoPath: string;
  portalUrl: string;
  lastSyncedAt: string;
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
