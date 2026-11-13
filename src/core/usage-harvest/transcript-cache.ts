import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Transcript reads shared by every harvest in a process, plus an on-disk index
 * of which workspaces each transcript belongs to.
 *
 * Matching a slot to its transcripts used to parse every file under
 * `~/.claude/projects` and `~/.codex/sessions` once per slot and per call — tens
 * of seconds per repo, repeated for Mission Control and HQ. The index keeps the
 * workspaces per file keyed on (mtime, size), so only new or changed files are
 * parsed; the record cache keeps the parsed files a sync actually uses.
 */

export interface TranscriptWorkspaces {
  /** Distinct top-level `cwd` values, in first-seen order. */
  cwds: string[];
  /** The last top-level `cwd` / `working_directory` in record order (Codex semantics). */
  lastWorkspace?: string;
}

interface IndexEntry extends TranscriptWorkspaces {
  mtimeMs: number;
  size: number;
}

interface IndexFile {
  version: number;
  files: Record<string, IndexEntry>;
}

interface CachedRecords {
  mtimeMs: number;
  size: number;
  records: unknown[];
}

const INDEX_VERSION = 1;
const DEFAULT_RECORD_CACHE_BYTES = 256 * 1024 * 1024;

let index: IndexFile | null = null;
let indexDirty = false;
const recordCache = new Map<string, CachedRecords>();
let recordCacheBytes = 0;

function indexPath(): string | null {
  if (process.env.HAR_TRANSCRIPT_INDEX_PATH) {
    return path.resolve(process.env.HAR_TRANSCRIPT_INDEX_PATH);
  }
  // Unit tests point the harvest at fixture dirs; keep their index in memory.
  if (process.env.NODE_ENV === 'test') return null;
  return path.join(os.homedir(), '.har', 'cache', 'transcript-index.json');
}

function recordCacheBudget(): number {
  const raw = Number(process.env.HAR_TRANSCRIPT_CACHE_BYTES);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_RECORD_CACHE_BYTES;
}

function loadIndex(): IndexFile {
  if (index) return index;
  index = { version: INDEX_VERSION, files: {} };
  const file = indexPath();
  if (!file) return index;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as IndexFile;
    if (parsed?.version === INDEX_VERSION && parsed.files && typeof parsed.files === 'object') {
      index = parsed;
    }
  } catch {
    // Missing or unreadable index: rebuild it from the transcripts.
  }
  return index;
}

/** Write the index if this process changed it. Atomic; never throws. */
export function persistTranscriptIndex(): void {
  if (!indexDirty || !index) return;
  const file = indexPath();
  indexDirty = false;
  if (!file) return;
  try {
    for (const filePath of Object.keys(index.files)) {
      if (!fs.existsSync(filePath)) delete index.files[filePath];
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(index));
    fs.renameSync(tmp, file);
  } catch {
    // A cache that cannot be written only costs the next process a re-scan.
  }
}

export function parseJsonlText(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip bad lines
    }
  }
  return out;
}

function statFile(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function workspacesOf(records: unknown[]): TranscriptWorkspaces {
  const cwds = new Set<string>();
  let lastWorkspace: string | undefined;
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const payload = record as { cwd?: unknown; working_directory?: unknown };
    if (typeof payload.cwd === 'string') {
      if (payload.cwd) cwds.add(payload.cwd);
      lastWorkspace = payload.cwd;
    }
    if (typeof payload.working_directory === 'string') lastWorkspace = payload.working_directory;
  }
  return { cwds: [...cwds], ...(lastWorkspace !== undefined ? { lastWorkspace } : {}) };
}

function remember(filePath: string, entry: CachedRecords): void {
  const budget = recordCacheBudget();
  if (entry.size > budget) return;
  const previous = recordCache.get(filePath);
  if (previous) {
    recordCacheBytes -= previous.size;
    recordCache.delete(filePath);
  }
  recordCache.set(filePath, entry);
  recordCacheBytes += entry.size;
  for (const [key, cached] of recordCache) {
    if (recordCacheBytes <= budget) break;
    recordCache.delete(key);
    recordCacheBytes -= cached.size;
  }
}

/** Parsed records of a transcript, reused while its mtime and size hold. */
export function readTranscriptRecords(filePath: string): unknown[] {
  const stat = statFile(filePath);
  if (!stat) return [];
  const cached = recordCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.records;
  }
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const records = parseJsonlText(text);
  remember(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, records });
  return records;
}

/**
 * Workspaces a transcript ran in, from the index when the file is unchanged.
 * Callers persist the index with `persistTranscriptIndex()` after a scan.
 */
export function transcriptWorkspaces(
  filePath: string,
  stat: fs.Stats | null = statFile(filePath),
): TranscriptWorkspaces & { mtimeMs: number } {
  if (!stat) return { cwds: [], mtimeMs: 0 };
  const files = loadIndex().files;
  const known = files[filePath];
  if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) {
    return { ...known };
  }
  // Not cached for its records: a cold index parses every transcript once, and
  // keeping them all would hold the whole history in memory.
  const cached = recordCache.get(filePath);
  const records =
    cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size
      ? cached.records
      : (() => {
          try {
            return parseJsonlText(fs.readFileSync(filePath, 'utf8'));
          } catch {
            return [];
          }
        })();
  const workspaces = workspacesOf(records);
  files[filePath] = { ...workspaces, mtimeMs: stat.mtimeMs, size: stat.size };
  indexDirty = true;
  return { ...workspaces, mtimeMs: stat.mtimeMs };
}

/** Test seam: forget everything cached in this process. */
export function resetTranscriptCache(): void {
  index = null;
  indexDirty = false;
  recordCache.clear();
  recordCacheBytes = 0;
}
