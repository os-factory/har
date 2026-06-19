import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getHarnessDir } from '../harness/manifest';
import { RunRecord, RunRecordSchema, StageResult } from '../harness/schema';
import { ExecutionContext } from './types';

const RUNS_DIR = 'runs';

function getRunsDir(repoPath: string): string {
  return path.join(getHarnessDir(repoPath), RUNS_DIR);
}

function getRunPath(repoPath: string, runId: string): string {
  return path.join(getRunsDir(repoPath), `${runId}.json`);
}

export interface CreateRunMeta {
  stageId: string;
  kind?: RunRecord['kind'];
  agentId?: number;
}

export function createRun(ctx: ExecutionContext, meta: CreateRunMeta): RunRecord {
  const repoPath = path.resolve(ctx.repoPath);
  const runsDir = getRunsDir(repoPath);
  fs.mkdirSync(runsDir, { recursive: true });

  const run: RunRecord = RunRecordSchema.parse({
    runId: crypto.randomUUID(),
    repoPath,
    stageId: meta.stageId,
    kind: meta.kind,
    agentId: meta.agentId,
    status: 'unknown',
    startedAt: new Date().toISOString(),
    trigger: ctx.trigger ?? 'cli',
  });

  fs.writeFileSync(getRunPath(repoPath, run.runId), JSON.stringify(run, null, 2) + '\n');
  return run;
}

export function finishRun(
  repoPath: string,
  runId: string,
  update: { status: RunRecord['status']; result?: StageResult; durationMs?: number },
): RunRecord {
  const resolved = path.resolve(repoPath);
  const runPath = getRunPath(resolved, runId);
  if (!fs.existsSync(runPath)) {
    throw new Error(`Run not found: ${runId}`);
  }

  const existing = RunRecordSchema.parse(JSON.parse(fs.readFileSync(runPath, 'utf8')));
  const finished: RunRecord = RunRecordSchema.parse({
    ...existing,
    status: update.status,
    result: update.result,
    durationMs: update.durationMs ?? update.result?.durationMs ?? existing.durationMs,
    finishedAt: new Date().toISOString(),
  });

  fs.writeFileSync(runPath, JSON.stringify(finished, null, 2) + '\n');
  return finished;
}

export function getRun(repoPath: string, runId: string): RunRecord | null {
  const runPath = getRunPath(path.resolve(repoPath), runId);
  if (!fs.existsSync(runPath)) return null;
  const parsed = RunRecordSchema.safeParse(JSON.parse(fs.readFileSync(runPath, 'utf8')));
  return parsed.success ? parsed.data : null;
}

export interface ListRunsFilter {
  stageId?: string;
  limit?: number;
}

export function listRuns(repoPath: string, filter: ListRunsFilter = {}): RunRecord[] {
  const runsDir = getRunsDir(path.resolve(repoPath));
  if (!fs.existsSync(runsDir)) return [];

  const runs: RunRecord[] = [];
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const parsed = RunRecordSchema.safeParse(
      JSON.parse(fs.readFileSync(path.join(runsDir, entry.name), 'utf8')),
    );
    if (!parsed.success) continue;
    if (filter.stageId && parsed.data.stageId !== filter.stageId) continue;
    runs.push(parsed.data);
  }

  runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (filter.limit && filter.limit > 0) {
    return runs.slice(0, filter.limit);
  }
  return runs;
}
