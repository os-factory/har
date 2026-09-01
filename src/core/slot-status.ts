import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { readHarnessEnv } from '../harness/env';
import { getHarnessDir, readManifest, resolveHarnessRoot } from '../harness/manifest';
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
import { allocateAppPorts } from './slot-ports';
import { inspectSlotReadiness, scanUntrackedWorktreePaths } from './slot-preflight';
import { packageRunner } from '../utils/package-runner';

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

function gitCommonDir(cwd: string): string | undefined {
  const out = runGit(cwd, 'rev-parse --git-common-dir');
  return out ? path.resolve(cwd, out) : undefined;
}

function sameGitCheckout(a: string, b: string): boolean {
  const left = gitCommonDir(a);
  const right = gitCommonDir(b);
  return left !== undefined && right !== undefined && left === right;
}

function gitPrefix(cwd: string): string {
  const out = runGit(cwd, 'rev-parse --show-prefix');
  return out ?? '';
}

function discoverSessionWorktreePath(harnessRoot: string, agentId: number): string | undefined {
  const worktreesRoot = path.join(os.homedir(), 'worktrees');
  if (!fs.existsSync(worktreesRoot)) return undefined;

  const suffix = `-har-agent-${agentId}-`;
  const relPrefix = gitPrefix(harnessRoot);
  const matches = fs
    .readdirSync(worktreesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.includes(suffix))
    .map((entry) => path.join(worktreesRoot, entry.name))
    .filter(
      (candidate) =>
        sameGitCheckout(harnessRoot, candidate) &&
        fs.existsSync(path.join(candidate, relPrefix, `.env.agent.${agentId}`)),
    );

  return matches.sort()[0];
}

/** "unknown" | "clean" | "dirty (N changed)" — mirrors the bash slot_dirty_summary. */
export function slotDirtySummary(worktreePath: string | undefined): string {
  if (!worktreePath || !fs.existsSync(worktreePath)) return 'unknown';
  const porcelain = runGit(worktreePath, 'status --porcelain');
  if (!porcelain) return 'clean';
  const count = porcelain.split('\n').filter(Boolean).length;
  return `dirty (${count} changed)`;
}

/**
 * Resolve .env.agent.<id> — registry work dir first, then the repo root, then
 * legacy and randomized session worktree fallbacks (the retired bash
 * resolve_agent_env_file, in the same order).
 */
export function resolveAgentEnvFile(harnessRoot: string, agentId: number): string | undefined {
  const session = readSlotRegistry(harnessRoot, agentId);
  if (session?.workDir) {
    const inWorkDir = path.join(session.workDir, `.env.agent.${agentId}`);
    if (fs.existsSync(inWorkDir)) return inWorkDir;
  }

  const env = readHarnessEnv(harnessRoot);
  const projectName = env.HARNESS_PROJECT_NAME ?? path.basename(harnessRoot);
  // Worktrees are repo-rooted — if the project lives in a subdirectory
  // (monorepo), the env file sits under that prefix inside the worktree.
  const relPrefix = gitPrefix(harnessRoot);

  for (const candidate of [
    path.join(harnessRoot, `.env.agent.${agentId}`),
    path.join(os.homedir(), 'worktrees', `${projectName}-agent-${agentId}`, relPrefix, `.env.agent.${agentId}`),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const worktreesRoot = path.join(os.homedir(), 'worktrees');
  if (!fs.existsSync(worktreesRoot)) return undefined;
  const suffix = `-har-agent-${agentId}-`;
  for (const name of fs.readdirSync(worktreesRoot).sort()) {
    if (!name.includes(suffix)) continue;
    const candidateDir = path.join(worktreesRoot, name);
    const candidate = path.join(candidateDir, relPrefix, `.env.agent.${agentId}`);
    if (!fs.existsSync(candidate)) continue;
    if (!sameGitCheckout(harnessRoot, candidateDir)) continue;
    return candidate;
  }
  return undefined;
}

export interface AgentSlotPorts {
  frontend?: number;
  api?: number;
  debug?: number;
  db?: number;
}

function parseEnvFilePorts(envFile: string): AgentSlotPorts {
  const values: Record<string, string> = {};
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const match = line.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  const num = (raw: string | undefined) => {
    const value = Number(raw);
    return raw !== undefined && raw !== '' && Number.isFinite(value) ? value : undefined;
  };
  return {
    frontend: num(values.FE_PORT),
    api: num(values.API_PORT ?? values.PORT),
    debug: num(values.DEBUG_PORT),
    db: num(values.PGPORT ?? values.DB_PORT),
  };
}

/**
 * Persisted app/infra ports for a slot: .env.agent.<id> first, then the slot
 * registry, then a fresh allocation (the retired bash load_agent_ports).
 */
export function loadAgentPorts(harnessRoot: string, agentId: number): AgentSlotPorts {
  const envFile = resolveAgentEnvFile(harnessRoot, agentId);
  if (envFile) return parseEnvFilePorts(envFile);

  const session = readSlotRegistry(harnessRoot, agentId);
  if (session?.ports && Object.keys(session.ports).length > 0) {
    const { frontend, api, debug, db } = session.ports;
    return { frontend, api, debug, db };
  }

  const env = readHarnessEnv(harnessRoot);
  const allocated = allocateAppPorts(harnessRoot, agentId);
  const infraEnv = path.join(getHarnessDir(harnessRoot), 'state', 'infra.env');
  const infraState: Record<string, string> = {};
  if (fs.existsSync(infraEnv)) {
    for (const line of fs.readFileSync(infraEnv, 'utf8').split('\n')) {
      const match = line.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match) infraState[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
  const db = Number(
    infraState.AGENT_DB_PORT ?? env.HARNESS_DB_PORT_DEFAULT ?? 15432,
  );
  if ('error' in allocated) return { db };
  return { frontend: allocated.frontend, api: allocated.api, debug: allocated.debug, db };
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

function listPm2Processes(): Array<{ name?: string }> | undefined {
  try {
    const raw = execSync(`${packageRunner()} pm2 jlist`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 3000,
    });
    const procs = JSON.parse(raw) as Array<{ name?: string }>;
    return Array.isArray(procs) ? procs : undefined;
  } catch {
    return undefined;
  }
}

function detectPm2Issue(
  projectName: string,
  agentId: number,
  session: ReturnType<typeof readSlotRegistry>,
  procs: Array<{ name?: string }> | undefined,
): AgentSlotStatus['pm2Issue'] {
  if (!procs) return undefined;

  const slotPrefix = `har-${projectName}-agent-${agentId}-`;
  const legacyPrefix = `agent-${agentId}-`;
  const owned = procs.filter((p) => p.name?.startsWith(slotPrefix));
  const foreign = procs.filter(
    (p) =>
      p.name &&
      ((p.name.startsWith('har-') &&
        p.name.includes(`-agent-${agentId}-`) &&
        !p.name.startsWith(slotPrefix)) ||
        (p.name.startsWith(legacyPrefix) && !p.name.startsWith('har-'))),
  );

  if (foreign.length > 0) return 'foreign_pm2';
  if (owned.length > 0) {
    if (!session) return 'registry_missing';
    if (session.projectName && session.projectName !== projectName) {
      return 'project_mismatch';
    }
  }
  return undefined;
}

function collectSlotStatus(
  harnessRoot: string,
  agentId: number,
  runs: RunRecord[],
  pm2Procs: Array<{ name?: string }> | undefined,
  untrackedPaths?: string[],
): AgentSlotStatus {
  const env = readHarnessEnv(harnessRoot);
  const projectName = env.HARNESS_PROJECT_NAME ?? path.basename(harnessRoot);
  // Session registry is the source of truth; fallback discovery keeps partial
  // launches recoverable when a script failed after creating the worktree/env.
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
        : discoverSessionWorktreePath(harnessRoot, agentId);

  const workDir = resolveAgentWorkDir(harnessRoot, agentId);
  const envInWorkDir = workDir ? fs.existsSync(path.join(workDir, `.env.agent.${agentId}`)) : false;
  const envInRoot = fs.existsSync(path.join(harnessRoot, `.env.agent.${agentId}`));
  const envInWorktree = worktreePath
    ? fs.existsSync(path.join(worktreePath, `.env.agent.${agentId}`))
    : false;
  const active =
    (session !== undefined && session.status !== 'completed') ||
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

  const pm2Issue = detectPm2Issue(projectName, agentId, session, pm2Procs);
  const readiness = inspectSlotReadiness(harnessRoot, agentId, {
    allocatePorts: true,
    occupied: { active, dirty: drift.dirty },
    untrackedPaths: untrackedPaths ?? scanUntrackedWorktreePaths(harnessRoot, env),
  });

  const resumeHint =
    session?.status === 'failed' || session?.status === 'starting'
      ? `har env launch ${agentId} --resume (alias: har env recover ${agentId})`
      : undefined;

  return {
    agentId,
    active,
    workDir: workDir ?? worktreePath,
    worktreePath,
    branch: session?.branch ?? (worktreePath ? readWorktreeBranch(worktreePath) : undefined),
    previewUrls,
    ports: session?.ports,
    pm2Issue,
    readiness,
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
    workUnitId: session?.workUnitId,
    attemptId: session?.attemptId,
    sessionStatus: session?.status,
    lastError: session?.lastError,
    resumeHint,
    ...drift,
  };
}

/**
 * Text rendering over the structured status — the single status source for the
 * CLI text view, `--json`, and MCP. Deliberately omits gitRemote: remote URLs
 * can embed credentials and must never reach logs.
 */
export function renderEnvironmentStatusText(status: EnvironmentStatus): string {
  const lines: string[] = [];
  lines.push(`Harness: ${status.harnessRoot}${status.profile ? ` (profile: ${status.profile})` : ''}`);

  for (const slot of status.slots) {
    const state = slot.active ? (slot.sessionStatus ?? 'active') : 'free';
    lines.push(`Agent ${slot.agentId}: ${state}`);
    if (slot.branch) {
      const drift = [
        slot.dirty ? 'dirty' : undefined,
        slot.ahead ? `ahead ${slot.ahead}` : undefined,
        slot.stale ? `stale (base behind main by ${slot.behind})` : undefined,
        slot.detachedHead ? 'detached HEAD' : undefined,
      ].filter(Boolean);
      lines.push(`  branch:      ${slot.branch}${drift.length ? ` [${drift.join(', ')}]` : ''}`);
    }
    if (slot.workDir) lines.push(`  work dir:    ${slot.workDir}`);
    if (slot.mode === 'external') {
      lines.push(`  worktree:    ${slot.worktreePath ?? slot.workDir} (externally owned — HAR will not remove it)`);
    }
    if (slot.previewUrls && Object.keys(slot.previewUrls).length > 0) {
      lines.push(
        `  preview:     ${Object.entries(slot.previewUrls)
          .map(([label, url]) => `${label}=${url}`)
          .join(' ')}`,
      );
    }
    if (slot.workUnitId) {
      lines.push(`  work unit:   ${slot.workUnitId}${slot.attemptId ? ` (attempt ${slot.attemptId})` : ''}`);
    }
    if (slot.lastRunAt) {
      lines.push(`  last run:    ${slot.lastRunAt} (${slot.harnessUsage})`);
    }
    if (slot.lastVerifyStatus) {
      lines.push(`  last verify: ${slot.lastVerifyStatus}`);
    }
    if (slot.pm2Issue) lines.push(`  pm2:         ${slot.pm2Issue}`);
    if (slot.lastError) lines.push(`  last error:  ${slot.lastError}`);
    if (slot.resumeHint) lines.push(`  resume:      ${slot.resumeHint}`);
    if (slot.readiness && !slot.readiness.canLaunch && !slot.active) {
      for (const blocker of slot.readiness.blockers) {
        lines.push(`  blocker:     ${blocker}`);
      }
    }
  }

  return lines.join('\n') + '\n';
}

export function collectEnvironmentStatus(repoPath: string): EnvironmentStatus {
  const harnessRoot = resolveHarnessRoot(repoPath);
  const runs = listRuns(harnessRoot, { limit: 200 });
  const manifest = readManifest(harnessRoot);
  const slotIds = getAgentSlotIds(harnessRoot);
  const pm2Procs = listPm2Processes();
  // Repo-wide and identical for every slot — scanned once, like pm2Procs above.
  const untrackedPaths = scanUntrackedWorktreePaths(harnessRoot, readHarnessEnv(harnessRoot));

  return {
    repoPath: path.resolve(repoPath),
    harnessRoot,
    gitRemote: readGitRemote(harnessRoot),
    profile: manifest?.profile,
    slots: slotIds.map((id) => collectSlotStatus(harnessRoot, id, runs, pm2Procs, untrackedPaths)),
    generatedAt: new Date().toISOString(),
  };
}
