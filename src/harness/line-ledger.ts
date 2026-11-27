import * as fs from 'fs';
import * as path from 'path';
import { writeFileSafe } from '../utils/file-ops';
import { lineLedgerPathRel, LINE_SCOPES, scopeRoot, type LineScope } from './line-scope';
import { LineLedger, LineLedgerEntry, LineLedgerSchema } from './schema';

/**
 * Installed-line ledgers, one per scope:
 * team `.har/lines.json` (committed, sibling of `.har/plugins.json`) and
 * personal `.har/local/lines.json` (gitignored; the main checkout's inside a
 * worktree slot — see `personalHarRoot`).
 */
export function getLineLedgerPath(repoPath: string, scope: LineScope = 'team'): string {
  return path.join(scopeRoot(repoPath, scope), lineLedgerPathRel(scope));
}

export function readLineLedger(repoPath: string, scope: LineScope = 'team'): LineLedger | null {
  const ledgerPath = getLineLedgerPath(repoPath, scope);
  if (!fs.existsSync(ledgerPath)) return null;
  try {
    const parsed = LineLedgerSchema.safeParse(JSON.parse(fs.readFileSync(ledgerPath, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A ledger entry plus the scope it was read from (derived, never stored). */
export interface ScopedLineLedgerEntry extends LineLedgerEntry {
  scope: LineScope;
}

/** Entries from both ledgers, team first. The same id may appear in both — callers report the clash. */
export function readAllLineLedgerEntries(repoPath: string): ScopedLineLedgerEntry[] {
  return LINE_SCOPES.flatMap((scope) =>
    (readLineLedger(repoPath, scope)?.lines ?? []).map((entry) => ({ ...entry, scope })),
  );
}

export function writeLineLedger(repoPath: string, ledger: LineLedger, scope: LineScope = 'team'): void {
  const ledgerPath = getLineLedgerPath(repoPath, scope);
  const ledgerDir = path.dirname(ledgerPath);
  if (!fs.existsSync(ledgerDir)) {
    fs.mkdirSync(ledgerDir, { recursive: true });
  }
  writeFileSafe(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
}

export function upsertLineLedgerEntry(
  repoPath: string,
  entry: LineLedgerEntry,
  scope: LineScope = 'team',
): LineLedger {
  const existing = readLineLedger(repoPath, scope) ?? { version: '1' as const, lines: [] };
  // Re-installing (`line add --force`) rewrites the entry from the bundle; the
  // `required` policy belongs to the repo, so keep it unless the caller sets one.
  const previous = existing.lines.find((l) => l.id === entry.id);
  const lines = existing.lines.filter((l) => l.id !== entry.id);
  lines.push(
    entry.required === undefined && previous?.required !== undefined
      ? { ...entry, required: previous.required }
      : entry,
  );
  lines.sort((a, b) => a.id.localeCompare(b.id));

  const ledger: LineLedger = { version: '1', lines };
  writeLineLedger(repoPath, ledger, scope);
  return ledger;
}

export function removeLineLedgerEntry(
  repoPath: string,
  lineId: string,
  scope: LineScope = 'team',
): LineLedger {
  const existing = readLineLedger(repoPath, scope) ?? { version: '1' as const, lines: [] };
  const ledger: LineLedger = {
    version: '1',
    lines: existing.lines.filter((l) => l.id !== lineId),
  };
  writeLineLedger(repoPath, ledger, scope);
  return ledger;
}
