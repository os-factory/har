import { readInstalledLineProgram } from '../harness/lines';
import { readLineLedger } from '../harness/line-ledger';
import { listLocalLineIds } from '../harness/line-resolve';

/** Ids of every line installed in this repo (ledger first, then on-disk). */
export function listInstalledLineIds(repoPath: string): string[] {
  const ledger = readLineLedger(repoPath);
  const fromLedger = ledger?.lines.map((l) => l.id) ?? [];
  const onDisk = listLocalLineIds(repoPath).filter(
    (id) => readInstalledLineProgram(repoPath, id) !== null,
  );
  return [...new Set([...fromLedger, ...onDisk])].sort();
}

/**
 * The factory line and station a verify runs under (`har env verify --line
 * <id> --station <id>`), checked against the installed program. Both null when
 * neither is given. `--line` may be omitted when exactly one line is installed.
 */
export function resolveVerifyLineStation(
  repoPath: string,
  input: { line?: string; station?: string },
): { factoryLine: string | null; station: string | null } {
  if (!input.line && !input.station) return { factoryLine: null, station: null };
  if (!input.station) throw new Error('--line needs --station <id>: a factory run is verified at one station.');
  let lineId = input.line;
  if (!lineId) {
    const ids = listInstalledLineIds(repoPath);
    if (ids.length !== 1) {
      throw new Error(
        ids.length === 0
          ? 'No factory line installed; --station needs one (har line add <spec>).'
          : `Multiple lines installed (${ids.join(', ')}). Pass --line <id>.`,
      );
    }
    lineId = ids[0];
  }
  const program = readInstalledLineProgram(repoPath, lineId);
  if (!program) throw new Error(`Line not installed: ${lineId}`);
  if (!program.stations.some((station) => station.id === input.station)) {
    throw new Error(
      `Unknown station "${input.station}" on line ${lineId}. Stations: ${program.stations.map((s) => s.id).join(', ')}`,
    );
  }
  return { factoryLine: lineId, station: input.station };
}
