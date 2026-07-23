import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { readHarnessEnv } from '../harness/env';
import { resolveHarnessRoot } from '../harness/manifest';
import type { AgentSlotStatus } from '../harness/schema';
import { readSlotRegistry, isSlotResumable } from './slot-registry';

export interface LaunchGuardOptions {
  confirmReplace?: boolean;
  force?: boolean;
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
    purpose: session?.purpose,
    dirty,
    harnessUsage: 'none',
  };
}

function formatNewSessionBase(repoPath: string, agentId: number): string[] {
  const resolved = path.resolve(repoPath);
  const branch = runGit(resolved, 'rev-parse --abbrev-ref HEAD');
  const sha = runGit(resolved, 'rev-parse --short HEAD');
  if (!branch && !sha) return [];
  return [
    `New session will be based on: ${branch ?? 'unknown'} @ ${sha ?? 'unknown'}`,
    `  (HEAD of ${resolved})`,
    '  --replace does not select main; switch the main checkout first for a new unrelated task.',
    `  Prefer: har env complete ${agentId} / teardown, then launch — not replace to "clean".`,
  ];
}

function formatOccupiedSlot(
  slot: AgentSlotStatus,
  options: { resume?: boolean; repoPath?: string } = {},
): string {
  const { resume, repoPath } = options;
  const lines = [
    `Slot ${slot.agentId} is already in use.`,
    slot.purpose ? `  Purpose:  ${slot.purpose}` : undefined,
    slot.worktreePath ? `  Worktree: ${slot.worktreePath}` : undefined,
    slot.branch ? `  Branch:   ${slot.branch}` : undefined,
    slot.workDir ? `  Work dir: ${slot.workDir}` : undefined,
    slot.sessionStatus ? `  Status:   ${slot.sessionStatus}` : undefined,
    slot.lastError ? `  Error:    ${slot.lastError}` : undefined,
    slot.sessionCreatedAt ? `  Since:    ${slot.sessionCreatedAt}` : undefined,
    slot.dirty
      ? '  Git:      dirty (uncommitted changes — commit or use force to discard)'
      : '  Git:      clean',
    '',
  ];

  if (
    resume ||
    slot.sessionStatus === 'failed' ||
    slot.sessionStatus === 'starting'
  ) {
    lines.push(
      'This session failed partway through launch. Resume without replacing:',
      `  har env launch ${slot.agentId} --resume`,
      `  har env recover ${slot.agentId}`,
      `  ./.har/launch.sh ${slot.agentId} --resume`,
      '',
    );
  }

  if (repoPath) {
    const base = formatNewSessionBase(repoPath, slot.agentId);
    if (base.length > 0) {
      lines.push(...base, '');
    }
  }

  lines.push(
    'Replacing removes the worktree. The session branch is kept only if you committed.',
    'Gitignored paths (state/, runs/, local clones) are NOT preserved.',
    '',
    'To free the slot cleanly: har env complete / teardown, then launch.',
    'To replace immediately: confirmReplace=true (MCP), --replace (CLI), or answer y at the prompt.',
    'If the worktree is dirty, also pass force=true / --force after explicit user approval.',
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
          'Use a normal launch with --replace to start fresh.',
        ].join('\n'),
      };
    }
    return { allowed: true, slot };
  }

  if (isSlotResumable(session) && !options.confirmReplace) {
    return {
      allowed: false,
      blocked: true,
      slot,
      reason: formatOccupiedSlot(slot, { repoPath }),
    };
  }

  if (!options.confirmReplace) {
    return {
      allowed: false,
      blocked: true,
      slot,
      reason: formatOccupiedSlot(slot, { repoPath }),
    };
  }

  if (slot.dirty && !options.force) {
    return {
      allowed: false,
      blocked: true,
      slot,
      reason: [
        formatOccupiedSlot(slot, { repoPath }),
        '',
        'The occupied worktree has uncommitted changes.',
        'Pass force=true / --force to discard them (only after explicit user approval).',
      ].join('\n'),
    };
  }

  return { allowed: true, slot };
}
