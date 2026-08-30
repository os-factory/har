import * as fs from 'fs';
import * as path from 'path';
import { writeFileSafe } from '../utils/file-ops';
import { DEFAULT_HAR_DIR } from './manifest';
import { LineLedger, LineLedgerEntry, LineLedgerSchema } from './schema';

/** Installed-line ledger — `.har/lines.json`, sibling of `.har/plugins.json`. */
export function getLineLedgerPath(repoPath: string): string {
  return path.join(path.resolve(repoPath), DEFAULT_HAR_DIR, 'lines.json');
}

export function readLineLedger(repoPath: string): LineLedger | null {
  const ledgerPath = getLineLedgerPath(repoPath);
  if (!fs.existsSync(ledgerPath)) return null;
  try {
    const parsed = LineLedgerSchema.safeParse(JSON.parse(fs.readFileSync(ledgerPath, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeLineLedger(repoPath: string, ledger: LineLedger): void {
  const ledgerPath = getLineLedgerPath(repoPath);
  const harnessDir = path.dirname(ledgerPath);
  if (!fs.existsSync(harnessDir)) {
    fs.mkdirSync(harnessDir, { recursive: true });
  }
  writeFileSafe(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
}

export function upsertLineLedgerEntry(repoPath: string, entry: LineLedgerEntry): LineLedger {
  const existing = readLineLedger(repoPath) ?? { version: '1' as const, lines: [] };
  const lines = existing.lines.filter((l) => l.id !== entry.id);
  lines.push(entry);
  lines.sort((a, b) => a.id.localeCompare(b.id));

  const ledger: LineLedger = { version: '1', lines };
  writeLineLedger(repoPath, ledger);
  return ledger;
}

export function removeLineLedgerEntry(repoPath: string, lineId: string): LineLedger {
  const existing = readLineLedger(repoPath) ?? { version: '1' as const, lines: [] };
  const ledger: LineLedger = {
    version: '1',
    lines: existing.lines.filter((l) => l.id !== lineId),
  };
  writeLineLedger(repoPath, ledger);
  return ledger;
}
