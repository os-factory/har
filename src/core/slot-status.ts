import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { readHarnessEnv } from '../harness/env';
import { readManifest, resolveHarnessRoot } from '../harness/manifest';
import {
  AgentSlotHarnessUsage,
  AgentSlotStatus,
  EnvironmentStatus,
  HarnessStageRunStatus,
  RunRecord,
} from '../harness/schema';
import { getAgentSlotIds } from '../harness/stages';
import { computePreviewUrls } from './local-executor';
import { listRuns, resolveAgentWorkDir } from './runs';
import { readSlotRegistry } from './slot-registry';

const BYPASS_WARNING_MS = 15 * 60 * 1000;

function readGitRemote(repoPath: string): string | undefined {
  try {
    const remote = execSync('git remote get-url origin', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    return remote || undefined;
  } catch {
    return undefined;
  }
}

function runGit(cwd: string, args: string): string | undefined {
  try {
    return execSync(`git ${args}`, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function readWorktreeBranch(worktreePath: string): string | undefined {
  return runGit(worktreePath, 'rev-parse --abbrev-ref HEAD');
}

interface WorktreeDrift {
  detachedHead?: boolean;
  dirty?: boolean;
  ahead?: number;
  behind?: number;
  stale?: boolean;
}

/**
 * Compare the session worktree against its recorded base and the main
 * checkout: dirty/detached state, session commits (ahead), and commits the
 * main checkout gained since launch (behind → the worktree serves stale code).
 */
function collectWorktreeDrift(
  harnessRoot: string,
  worktreePath: string,
  baseCommit: string | undefined,
): WorktreeDrift {
  const drift: WorktreeDrift = {};

  drift.detachedHead = runGit(worktreePath, 'symbolic-ref -q HEAD') === undefined;

  const porcelain = runGit(worktreePath, 'status --porcelain');
  if (porcelain !== undefined) drift.dirty = porcelain.length > 0;

  if (baseCommit) {
    const ahead = runGit(worktreePath, `rev-list --count ${baseCommit}..HEAD`);
    if (ahead !== undefined) drift.ahead = Number(ahead);

    const behind = runGit(harnessRoot, `rev-list --count ${baseCommit}..HEAD`);
    if (behind !== undefined) {
      drift.behind = Number(behind);
      drift.stale = drift.behind > 0;
    }
  }

  return drift;
}

function latestRunForAgent(runs: RunRecord[], agentId: number): RunRecord | undefined {
  return runs.find((r) => r.agentId === agentId);
}

function deriveHarnessUsage(
  run: RunRecord | undefined,
  active: boolean,
): AgentSlotHarnessUsage {
  if (!run) {
    return active ? 'bypass_warning' : 'none';
  }

  const age = Date.now() - new Date(run.startedAt).getTime();
  if (active && age > BYPASS_WARNING_MS) {
    return 'bypass_warning';
  }

  return run.trigger;
}

function lastVerifyStatus(run: RunRecord | undefined): HarnessStageRunStatus | undefined {
  if (!run || run.stageId !== 'verify') return undefined;
  return run.status;
}

function lastBuildPass(run: RunRecord | undefined): boolean | undefined {
  if (!run?.result?.data) return undefined;
  const data = run.result.data as {
    verification?: { stages?: { name: string; pass: boolean }[] };
  };
  const build = data.verification?.stages?.find((s) => s.name === 'build');
  return build?.pass;
}

function collectSlotStatus(
  harnessRoot: string,
  agentId: number,
  runs: RunRecord[],
): AgentSlotStatus {
  const env = readHarnessEnv(harnessRoot);
  const projectName = env.HARNESS_PROJECT_NAME ?? path.basename(harnessRoot);
  // Session registry is the source of truth; the fixed path is a legacy
  // fallback for pre-registry sessions.
  const session = readSlotRegistry(harnessRoot, agentId);
  const legacyWorktreePath = path.join(
    os.homedir(),
    'worktrees',
    `${projectName}-agent-${agentId}`,
  );
  const worktreePath =
    session?.worktreePath && fs.existsSync(session.worktreePath)
      ? session.worktreePath
      : fs.existsSync(legacyWorktreePath)
        ? legacyWorktreePath
        : undefined;

  const workDir = resolveAgentWorkDir(harnessRoot, agentId);
  const envInWorkDir = workDir ? fs.existsSync(path.join(workDir, `.env.agent.${agentId}`)) : false;
  const envInRoot = fs.existsSync(path.join(harnessRoot, `.env.agent.${agentId}`));
  const envInWorktree = worktreePath
    ? fs.existsSync(path.join(worktreePath, `.env.agent.${agentId}`))
    : false;
  const active =
    (session !== undefined && session.status === 'active') ||
    envInWorkDir ||
    envInRoot ||
    envInWorktree;

  const latest = latestRunForAgent(runs, agentId);
  const verifyRun = runs.find((r) => r.agentId === agentId && r.stageId === 'verify');

  let previewUrls = session?.previewUrls;
  if (!previewUrls && active) {
    try {
      previewUrls = computePreviewUrls(harnessRoot, agentId);
    } catch {
      previewUrls = undefined;
    }
  }

  const drift = worktreePath
    ? collectWorktreeDrift(harnessRoot, worktreePath, session?.baseCommit)
    : {};

  return {
    agentId,
    active,
    workDir: workDir ?? worktreePath,
    worktreePath,
    branch: session?.branch ?? (worktreePath ? readWorktreeBranch(worktreePath) : undefined),
    previewUrls,
    harnessUsage: deriveHarnessUsage(latest, active),
    lastRunId: latest?.runId,
    lastRunAt: latest?.startedAt,
    lastVerifyStatus: lastVerifyStatus(verifyRun),
    lastBuildPass: lastBuildPass(verifyRun),
    mode: session?.mode,
    suffix: session?.suffix,
    baseBranch: session?.baseBranch,
    baseCommit: session?.baseCommit,
    sessionCreatedAt: session?.createdAt,
    ...drift,
  };
}

export function collectEnvironmentStatus(repoPath: string): EnvironmentStatus {
  const harnessRoot = resolveHarnessRoot(repoPath);
  const runs = listRuns(harnessRoot, { limit: 200 });
  const manifest = readManifest(harnessRoot);
  const slotIds = getAgentSlotIds(harnessRoot);

  return {
    repoPath: path.resolve(repoPath),
    harnessRoot,
    gitRemote: readGitRemote(harnessRoot),
    profile: manifest?.profile,
    slots: slotIds.map((id) => collectSlotStatus(harnessRoot, id, runs)),
    generatedAt: new Date().toISOString(),
  };
}
