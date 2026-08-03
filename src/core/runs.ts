import * as crypto from 'crypto';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readHarnessEnv } from '../harness/env';
import { getHarnessDir, resolveHarnessRoot } from '../harness/manifest';
import { RunRecord, RunRecordSchema, StageResult } from '../harness/schema';
import { readSlotRegistry } from './slot-registry';
import { markDirty } from './sync-context';
import { ExecutionContext } from './types';

const RUNS_DIR = 'runs';

function gitCommonDir(cwd: string): string | undefined {
  try {
    const out = execSync('git rev-parse --git-common-dir', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    return out ? path.resolve(cwd, out) : undefined;
  } catch {
    return undefined;
  }
}

function sameGitCheckout(a: string, b: string): boolean {
  const left = gitCommonDir(a);
  const right = gitCommonDir(b);
  return left !== undefined && right !== undefined && left === right;
}

function gitPrefix(cwd: string): string {
  try {
    return execSync('git rev-parse --show-prefix', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function getRunsDir(harnessRoot: string): string {
  return path.join(getHarnessDir(harnessRoot), RUNS_DIR);
}

function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatLocalTime(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}-${m}-${s}`;
}

export function buildRunRelativePath(
  stageId: string,
  agentId: number | undefined,
  startedAt: string,
  runId: string,
  runsDir: string,
): string {
  const started = new Date(startedAt);
  const dateFolder = formatLocalDate(started);
  const timePart = formatLocalTime(started);
  const agentPart = agentId !== undefined ? `_agent-${agentId}` : '';
  let filename = `${timePart}_${stageId}${agentPart}.json`;

  const fullPath = path.join(runsDir, dateFolder, filename);
  if (fs.existsSync(fullPath)) {
    filename = `${timePart}_${stageId}${agentPart}-${runId.slice(0, 8)}.json`;
  }

  return path.join(dateFolder, filename);
}

function resolveRunFilePath(harnessRoot: string, run: RunRecord): string {
  if (run.relativePath) {
    return path.join(getRunsDir(harnessRoot), run.relativePath);
  }
  return path.join(getRunsDir(harnessRoot), `${run.runId}.json`);
}

function collectRunFiles(runsDir: string): string[] {
  if (!fs.existsSync(runsDir)) return [];

  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.json')) {
        files.push(full);
      }
    }
  };
  walk(runsDir);
  return files;
}

export function resolveAgentWorkDir(harnessRoot: string, agentId?: number): string | undefined {
  if (agentId === undefined) return undefined;

  // Session registry is the source of truth — worktree paths carry a random
  // per-session suffix and cannot be derived from the agent id alone.
  const entry = readSlotRegistry(harnessRoot, agentId);
  if (entry?.workDir && fs.existsSync(entry.workDir)) return entry.workDir;

  const env = readHarnessEnv(harnessRoot);
  const projectName = env.HARNESS_PROJECT_NAME ?? path.basename(harnessRoot);
  const worktreeDir = path.join(os.homedir(), 'worktrees', `${projectName}-agent-${agentId}`);
  const relPrefix = gitPrefix(harnessRoot);
  const sessionEnvFiles: string[] = [];
  const worktreesRoot = path.join(os.homedir(), 'worktrees');
  if (fs.existsSync(worktreesRoot)) {
    const suffix = `-har-agent-${agentId}-`;
    for (const entry of fs.readdirSync(worktreesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.includes(suffix)) continue;
      const sessionDir = path.join(worktreesRoot, entry.name);
      if (!sameGitCheckout(harnessRoot, sessionDir)) continue;
      sessionEnvFiles.push(path.join(sessionDir, relPrefix, `.env.agent.${agentId}`));
    }
  }

  const candidates = [
    path.join(worktreeDir, `.env.agent.${agentId}`),
    path.join(harnessRoot, `.env.agent.${agentId}`),
    ...sessionEnvFiles.sort(),
  ];

  for (const envFile of candidates) {
    if (!fs.existsSync(envFile)) continue;
    const content = fs.readFileSync(envFile, 'utf8');
    const match = content.match(/^REPO_ROOT=(.+)$/m);
    if (match) return match[1].trim();
  }

  return undefined;
}

export interface CreateRunMeta {
  stageId: string;
  kind?: RunRecord['kind'];
  agentId?: number;
  command?: string;
}

export function createRun(ctx: ExecutionContext, meta: CreateRunMeta): RunRecord {
  const harnessRoot = resolveHarnessRoot(ctx.repoPath);
  const runsDir = getRunsDir(harnessRoot);
  const startedAt = new Date().toISOString();
  const runId = crypto.randomUUID();

  const relativePath = buildRunRelativePath(meta.stageId, meta.agentId, startedAt, runId, runsDir);
  const runFilePath = path.join(runsDir, relativePath);
  fs.mkdirSync(path.dirname(runFilePath), { recursive: true });

  const run: RunRecord = RunRecordSchema.parse({
    runId,
    repoPath: path.resolve(ctx.repoPath),
    harnessRoot,
    stageId: meta.stageId,
    kind: meta.kind,
    agentId: meta.agentId,
    command: meta.command,
    status: 'unknown',
    startedAt,
    relativePath,
    trigger: ctx.trigger ?? 'cli',
    workUnitId: ctx.workUnitId,
    attemptId: ctx.attemptId,
  });

  fs.writeFileSync(runFilePath, JSON.stringify(run, null, 2) + '\n');
  markDirty(run.repoPath);
  return run;
}

export function finishRun(
  repoPath: string,
  runId: string,
  update: { status: RunRecord['status']; result?: StageResult; durationMs?: number },
): RunRecord {
  const harnessRoot = resolveHarnessRoot(repoPath);
  const existing = findRunRecord(harnessRoot, runId);
  if (!existing) {
    throw new Error(`Run not found: ${runId}`);
  }

  const workDir = resolveAgentWorkDir(harnessRoot, existing.agentId);
  const finished: RunRecord = RunRecordSchema.parse({
    ...existing,
    status: update.status,
    result: update.result,
    workDir,
    durationMs: update.durationMs ?? update.result?.durationMs ?? existing.durationMs,
    finishedAt: new Date().toISOString(),
  });

  const runPath = resolveRunFilePath(harnessRoot, finished);
  fs.writeFileSync(runPath, JSON.stringify(finished, null, 2) + '\n');
  markDirty(finished.repoPath);
  return finished;
}

function findRunRecord(harnessRoot: string, runId: string): RunRecord | null {
  const runsDir = getRunsDir(harnessRoot);
  for (const filePath of collectRunFiles(runsDir)) {
    const parsed = RunRecordSchema.safeParse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    if (parsed.success && parsed.data.runId === runId) {
      return parsed.data;
    }
  }
  return null;
}

export function getRun(repoPath: string, runId: string): RunRecord | null {
  return findRunRecord(resolveHarnessRoot(repoPath), runId);
}

export interface ListRunsFilter {
  stageId?: string;
  limit?: number;
}

export function listRuns(repoPath: string, filter: ListRunsFilter = {}): RunRecord[] {
  const runsDir = getRunsDir(resolveHarnessRoot(repoPath));
  if (!fs.existsSync(runsDir)) return [];

  const runs: RunRecord[] = [];
  for (const filePath of collectRunFiles(runsDir)) {
    const parsed = RunRecordSchema.safeParse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
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
