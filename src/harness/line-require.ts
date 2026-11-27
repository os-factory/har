import * as path from 'path';
import { getLineLedgerPath, readLineLedger, writeLineLedger } from './line-ledger';
import { locateInstalledLine, readInstalledLineProgram } from './lines';
import type { LineLedger, LineRequired } from './schema';

/**
 * Required lines (BE-3803): a team marks a line as required up to a station.
 * The policy is a `required` block on the line's entry in the committed team
 * ledger (`.har/lines.json`) — not the line program, which is a shared bundle.
 * `har line check` (CI) reads it; nothing here runs a gate.
 */

export interface RequireLineResult {
  lineId: string;
  /** Station the line is now required up to. */
  station: string;
  /** Station it was required up to before, if any. */
  previousStation?: string;
  /** Repo-relative ledger file holding the policy — commit it. */
  ledgerPath: string;
}

export interface UnrequireLineResult {
  lineId: string;
  /** Station it was required up to; undefined when it was not required (no-op). */
  previousStation?: string;
  ledgerPath: string;
}

function teamLedgerRel(repoPath: string): string {
  return path.relative(repoPath, getLineLedgerPath(repoPath, 'team')).replace(/\\/g, '/');
}

/** The team ledger, with the line's entry — or a clear error saying why it cannot be required. */
function teamEntryFor(repoPath: string, lineId: string): { ledger: LineLedger; index: number } {
  const scope = locateInstalledLine(repoPath, lineId);
  if (!scope) {
    throw new Error(`Line not installed: ${lineId}. Install it with "har line add ${lineId}".`);
  }
  if (scope === 'personal') {
    throw new Error(
      `Line "${lineId}" is personal — only team lines can be required (CI and teammates cannot see personal lines). ` +
        `Share it first with "har line promote ${lineId}".`,
    );
  }
  const ledger = readLineLedger(repoPath, 'team');
  const index = ledger?.lines.findIndex((l) => l.id === lineId) ?? -1;
  if (!ledger || index < 0) {
    throw new Error(
      `Line "${lineId}" is not in .har/lines.json. Reinstall it with "har line add ${lineId} --force" so it has a ledger entry.`,
    );
  }
  return { ledger, index };
}

/** Mark a team line as required up to `station` (default: its last station). */
export function requireLine(repoPath: string, lineId: string, station?: string): RequireLineResult {
  const resolved = path.resolve(repoPath);
  const { ledger, index } = teamEntryFor(resolved, lineId);
  const program = readInstalledLineProgram(resolved, lineId, 'team');
  if (!program) {
    throw new Error(`Line "${lineId}" has no readable program. Reinstall it with "har line add ${lineId} --force".`);
  }
  const stationIds = program.stations.map((s) => s.id);
  const target = station ?? stationIds[stationIds.length - 1];
  if (!stationIds.includes(target)) {
    throw new Error(`Unknown station "${target}" for line "${lineId}". Stations: ${stationIds.join(', ')}`);
  }

  const entry = ledger.lines[index];
  const required: LineRequired = { station: target };
  const lines = [...ledger.lines];
  lines[index] = { ...entry, required };
  writeLineLedger(resolved, { ...ledger, lines }, 'team');

  return {
    lineId,
    station: target,
    ...(entry.required ? { previousStation: entry.required.station } : {}),
    ledgerPath: teamLedgerRel(resolved),
  };
}

/** Drop a team line's required policy. A no-op (not an error) when it was not required. */
export function unrequireLine(repoPath: string, lineId: string): UnrequireLineResult {
  const resolved = path.resolve(repoPath);
  const { ledger, index } = teamEntryFor(resolved, lineId);
  const entry = ledger.lines[index];
  if (entry.required) {
    const lines = [...ledger.lines];
    lines[index] = { ...entry, required: undefined };
    writeLineLedger(resolved, { ...ledger, lines }, 'team');
  }
  return {
    lineId,
    ...(entry.required ? { previousStation: entry.required.station } : {}),
    ledgerPath: teamLedgerRel(resolved),
  };
}
