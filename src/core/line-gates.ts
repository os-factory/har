import * as fs from 'fs';
import * as path from 'path';
import { getHarnessDir, resolveHarnessRoot } from '../harness/manifest';
import { LineGateRun, LineGateRunSchema } from '../harness/schema';
import { ensureHarnessSubdirIgnored } from './gitignore';
import { markDirty } from './sync-context';

/**
 * Line gate run records — `.har/line-gates/YYYY-MM-DD/HH-mm-ss_<line>_<station>.json`.
 *
 * Stored like run records: under the harness root (the main checkout for HAR
 * worktree slots), never in the session worktree, so sync reads them from the
 * same place it reads `.har/runs/`.
 */
export const LINE_GATES_DIR = 'line-gates';

function getLineGatesDir(harnessRoot: string): string {
  return path.join(getHarnessDir(harnessRoot), LINE_GATES_DIR);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export type RecordLineGateRunInput = Pick<
  LineGateRun,
  | 'gateRunId'
  | 'lineId'
  | 'stationId'
  | 'scope'
  | 'repoPath'
  | 'agentId'
  | 'branch'
  | 'headSha'
  | 'workUnitId'
  | 'attemptId'
  | 'stages'
  | 'pass'
  | 'skipped'
  | 'skipReason'
  | 'startedAt'
  | 'finishedAt'
>;

function buildRelativePath(record: RecordLineGateRunInput, gatesDir: string): string {
  const started = new Date(record.startedAt);
  const dateFolder = `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())}`;
  const timePart = `${pad(started.getHours())}-${pad(started.getMinutes())}-${pad(started.getSeconds())}`;
  const base = `${timePart}_${record.lineId}_${record.stationId}`;
  const filename = fs.existsSync(path.join(gatesDir, dateFolder, `${base}.json`))
    ? `${base}-${record.gateRunId.slice(0, 8)}.json`
    : `${base}.json`;
  return path.join(dateFolder, filename);
}

export function recordLineGateRun(input: RecordLineGateRunInput): LineGateRun {
  const harnessRoot = resolveHarnessRoot(input.repoPath);
  const gatesDir = getLineGatesDir(harnessRoot);
  ensureHarnessSubdirIgnored(harnessRoot, LINE_GATES_DIR);

  const relativePath = buildRelativePath(input, gatesDir);
  const record = LineGateRunSchema.parse({
    ...input,
    repoPath: path.resolve(input.repoPath),
    harnessRoot,
    relativePath,
  });

  const filePath = path.join(gatesDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
  markDirty(record.repoPath);
  return record;
}

function collectFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(full));
    else if (entry.name.endsWith('.json')) files.push(full);
  }
  return files;
}

/** Gate runs for a repo, newest first. Unreadable files are skipped. */
export function listLineGateRuns(repoPath: string, filter: { lineId?: string } = {}): LineGateRun[] {
  const records: LineGateRun[] = [];
  for (const file of collectFiles(getLineGatesDir(resolveHarnessRoot(repoPath)))) {
    try {
      const parsed = LineGateRunSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (!parsed.success) continue;
      if (filter.lineId && parsed.data.lineId !== filter.lineId) continue;
      records.push(parsed.data);
    } catch {
      continue;
    }
  }
  return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
