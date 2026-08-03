import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { readHarnessEnv } from '../harness/env';
import { resolveHarnessRoot } from '../harness/manifest';
import type { AgentSlotStatus } from '../harness/schema';
import { readSlotRegistry, isSlotResumable } from './slot-registry';

export interface LaunchGuardOptions {
  resume?: boolean;
}

export interface LaunchGuardResult {
  allowed: boolean;
  blocked?: boolean;
  reason?: string;
  slot?: AgentSlotStatus;
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

function worktreeDirty(worktreePath: string): boolean {
  const porcelain = runGit(worktreePath, 'status --porcelain');
  return porcelain !== undefined && porcelain.length > 0;
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

function discoverWorktree(harnessRoot: string, agentId: number, projectName: string): string | undefined {
  const session = readSlotRegistry(harnessRoot, agentId);
  if (session?.worktreePath && fs.existsSync(session.worktreePath)) {
    return session.worktreePath;
  }
  const legacy = path.join(os.homedir(), 'worktrees', `${projectName}-agent-${agentId}`);
  if (fs.existsSync(legacy) && sameGitCheckout(harnessRoot, legacy)) return legacy;
  const worktreesRoot = path.join(os.homedir(), 'worktrees');
  if (!fs.existsSync(worktreesRoot)) return undefined;
  const suffix = `-har-agent-${agentId}-`;
  const relPrefix = runGit(harnessRoot, 'rev-parse --show-prefix') ?? '';
  for (const name of fs.readdirSync(worktreesRoot)) {
    if (!name.includes(suffix)) continue;
    const candidate = path.join(worktreesRoot, name);
    if (!sameGitCheckout(harnessRoot, candidate)) continue;
    if (!fs.existsSync(path.join(candidate, relPrefix, `.env.agent.${agentId}`))) continue;
    return candidate;
  }
  return undefined;
}

/** Lightweight occupied check — avoids full collectEnvironmentStatus (and PM2 polling). */
function collectOccupiedSlot(repoPath: string, agentId: number): AgentSlotStatus | undefined {
  const harnessRoot = resolveHarnessRoot(repoPath);
  const env = readHarnessEnv(harnessRoot);
  const projectName = env.HARNESS_PROJECT_NAME ?? path.basename(harnessRoot);
  const session = readSlotRegistry(harnessRoot, agentId);
  const worktreePath = discoverWorktree(harnessRoot, agentId, projectName);
  const workDir = session?.workDir;
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

  if (!active) return undefined;

  const dirty = worktreePath ? worktreeDirty(worktreePath) : undefined;
  return {
    agentId,
    active: true,
    workDir: workDir ?? worktreePath,
    worktreePath,
    branch: session?.branch,
    sessionStatus: session?.status,
    lastError: session?.lastError,
    sessionCreatedAt: session?.createdAt,
    dirty,
    harnessUsage: 'none',
  };
}

/** Describe the HEAD that a new launch would use (main checkout / --repo). */
export function describeLaunchBase(repoPath: string): string[] {
  const harnessRoot = resolveHarnessRoot(repoPath);
  const branch = runGit(harnessRoot, 'rev-parse --abbrev-ref HEAD') ?? 'detached';
  const sha = runGit(harnessRoot, 'rev-parse --short HEAD');
  return [
    `New session will be based on: ${branch}${sha ? ` @ ${sha}` : ''}`,
    `  (HEAD of ${harnessRoot})`,
    '  Switch the main checkout to your intended base before launching a new session.',
  ];
}

function formatOccupiedSlot(
  slot: AgentSlotStatus,
  repoPath: string,
  resume?: boolean,
): string {
  const lines = [
    `Slot ${slot.agentId} is already in use.`,
    slot.worktreePath ? `  Worktree: ${slot.worktreePath}` : undefined,
    slot.branch ? `  Branch:   ${slot.branch}` : undefined,
    slot.workDir ? `  Work dir: ${slot.workDir}` : undefined,
    slot.sessionStatus ? `  Status:   ${slot.sessionStatus}` : undefined,
    slot.lastError ? `  Error:    ${slot.lastError}` : undefined,
    slot.sessionCreatedAt ? `  Since:    ${slot.sessionCreatedAt}` : undefined,
    slot.dirty
      ? '  Git:      dirty (uncommitted changes — commit or discard them in the worktree)'
      : '  Git:      clean',
    '',
    ...describeLaunchBase(repoPath),
    '',
  ];

  if (
    resume ||
    slot.sessionStatus === 'failed' ||
    slot.sessionStatus === 'starting'
  ) {
    lines.push(
      'This session failed partway through launch. Resume without a new launch:',
      `  har env launch ${slot.agentId} --resume`,
      `  har env recover ${slot.agentId}`,
      `  ./.har/launch.sh ${slot.agentId} --resume`,
      '',
    );
  } else {
    lines.push(
      'Free the slot before starting a new session:',
      slot.dirty
        ? `  Commit or discard changes in the worktree, then: har env teardown ${slot.agentId} (or complete ${slot.agentId})`
        : `  har env complete ${slot.agentId}   # or: har env teardown ${slot.agentId}`,
      `  har env launch ${slot.agentId}`,
      '',
    );
  }

  lines.push(
    'complete/teardown remove the worktree. The session branch is kept only if you committed.',
    'Gitignored paths (state/, runs/, local clones) are NOT preserved.',
  );
  return lines.filter(Boolean).join('\n');
}

/** Occupied-slot guard only — used by inspectSlotReadiness and the combined launch guard. */
export function checkLaunchGuard(
  repoPath: string,
  agentId: number,
  options: LaunchGuardOptions = {},
): LaunchGuardResult {
  const slot = collectOccupiedSlot(repoPath, agentId);
  if (!slot?.active) {
    return { allowed: true };
  }

  const harnessRoot = resolveHarnessRoot(repoPath);
  const session = readSlotRegistry(harnessRoot, agentId);
  if (options.resume) {
    if (!isSlotResumable(session)) {
      return {
        allowed: false,
        blocked: true,
        slot,
        reason: [
          `Slot ${agentId} is not resumable (status=${session?.status ?? 'none'}).`,
          'Only failed or starting sessions can be resumed.',
          `Free the slot first: har env teardown ${agentId} (or complete ${agentId}), then har env launch ${agentId}.`,
        ].join('\n'),
      };
    }
    return { allowed: true, slot };
  }

  return {
    allowed: false,
    blocked: true,
    slot,
    reason: formatOccupiedSlot(slot, repoPath),
  };
}
