import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_HAR_DIR } from './manifest';

/**
 * Where a factory line lives.
 *
 * - `team`: `.har/lines/<id>/` + `.har/lines.json` — committed, shared with
 *   the team and CI (the only scope before personal lines existed).
 * - `personal`: `.har/local/lines/<id>/` + `.har/local/lines.json` —
 *   gitignored, one developer's own workflow.
 *
 * Scope is never stored in a ledger entry: it is derived from which ledger
 * (and which directory) the line was found in, so a committed team ledger
 * cannot claim an entry is personal.
 */
export const LINE_SCOPES = ['team', 'personal'] as const;
export type LineScope = (typeof LINE_SCOPES)[number];

/** Gitignored per-developer area inside `.har/` (personal lines and their stage scripts). */
export const HAR_LOCAL_DIR = 'local';

/** `.har/`-relative prefix for personal-scope files. */
const LOCAL_PREFIX = `${HAR_LOCAL_DIR}/`;

/** Repo-relative home of every line in a scope. */
export function linesDirRel(scope: LineScope): string {
  return scope === 'personal'
    ? `${DEFAULT_HAR_DIR}/${HAR_LOCAL_DIR}/lines`
    : `${DEFAULT_HAR_DIR}/lines`;
}

/** Repo-relative path of a scope's install ledger. */
export function lineLedgerPathRel(scope: LineScope): string {
  return scope === 'personal'
    ? `${DEFAULT_HAR_DIR}/${HAR_LOCAL_DIR}/lines.json`
    : `${DEFAULT_HAR_DIR}/lines.json`;
}

/**
 * Map a repo-relative bundle file destination into the personal area.
 * `.har/stages/x.sh` → `.har/local/stages/x.sh`. Destinations outside `.har/`
 * are returned unchanged (the caller warns: they are not gitignored).
 */
export function personalFileDest(dest: string): string {
  const normalized = dest.replace(/\\/g, '/').replace(/^\.\//, '');
  const harPrefix = `${DEFAULT_HAR_DIR}/`;
  if (!normalized.startsWith(harPrefix)) return dest;
  const rest = normalized.slice(harPrefix.length);
  if (rest.startsWith(LOCAL_PREFIX)) return normalized;
  return `${harPrefix}${LOCAL_PREFIX}${rest}`;
}

/** True when a repo-relative path is inside `.har/` (and so can be made personal). */
export function isUnderHarDir(dest: string): boolean {
  return dest.replace(/\\/g, '/').replace(/^\.\//, '').startsWith(`${DEFAULT_HAR_DIR}/`);
}

/**
 * Make sure `.har/.gitignore` ignores `local/`. Called by `har env maintain`
 * (older repos) and before anything personal is written, so a personal line
 * can never land in a commit because the ignore rule was missing.
 */
export function ensureHarLocalIgnored(repoPath: string): boolean {
  const harDir = path.join(path.resolve(repoPath), DEFAULT_HAR_DIR);
  if (!fs.existsSync(harDir)) return false;
  const gitignorePath = path.join(harDir, '.gitignore');
  const content = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const entries = new Set(content.split('\n').map((line) => line.trim()));
  if (entries.has(LOCAL_PREFIX) || entries.has(HAR_LOCAL_DIR) || entries.has(`/${LOCAL_PREFIX}`)) {
    return false;
  }
  const separator = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(
    gitignorePath,
    `${content}${separator}\n# Personal factory lines and their stage scripts (har line … --personal)\n${LOCAL_PREFIX}\n`,
  );
  return true;
}
