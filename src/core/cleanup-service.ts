import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { discoverHarRepos } from './control-sync';
import { canonicalizeControlRepoPath } from './control-repo-path';
import { collectEnvironmentStatus } from './slot-status';
import { createRunService } from './run-service';
import { resolveHarnessRoot, readManifest } from '../harness/manifest';
import type { AgentSlotStatus } from '../harness/schema';

export type CleanupCandidateKind = 'active_slot' | 'orphan_worktree';

export type CleanupRecommendation = 'teardown' | 'remove_orphan' | 'keep' | 'review';

export interface CleanupKeepPin {
  repoPath?: string;
  agentId?: number;
  worktreePath?: string;
}

export interface CleanupCandidate {
  kind: CleanupCandidateKind;
  repoPath: string;
  projectName: string;
  agentId?: number;
  worktreePath?: string;
  branch?: string;
  active: boolean;
  dirty?: boolean;
  ageDays?: number;
  sessionCreatedAt?: string;
  recommendation: CleanupRecommendation;
  reason: string;
}

export interface CleanupPlan {
  candidates: CleanupCandidate[];
  generatedAt: string;
}

export interface DiscoverCleanupOptions {
  cwd?: string;
  repoPaths?: string[];
  keep?: CleanupKeepPin[];
  staleDays?: number;
  orphans?: boolean;
  includeReview?: boolean;
}

export interface CleanupExecutionOutcome {
  candidate: CleanupCandidate;
  ok: boolean;
  error?: string;
}

export interface ExecuteCleanupOptions {
  dryRun?: boolean;
  yes?: boolean;
  includeReview?: boolean;
}

const DEFAULT_STALE_DAYS = 7;

function getWorktreesRoot(): string {
  if (process.env.HAR_WORKTREES_ROOT) {
    return path.resolve(process.env.HAR_WORKTREES_ROOT);
  }
  return path.join(process.env.HOME || os.homedir(), 'worktrees');
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

function basenameRepo(repoPath: string): string {
  return path.basename(canonicalizeControlRepoPath(repoPath));
}

function ageDaysFrom(iso?: string): number | undefined {
  if (!iso) return undefined;
  const created = Date.parse(iso);
  if (Number.isNaN(created)) return undefined;
  return Math.floor((Date.now() - created) / (24 * 60 * 60 * 1000));
}

function matchesKeep(candidate: CleanupCandidate, keep: CleanupKeepPin[] | undefined): boolean {
  if (!keep?.length) return false;
  for (const pin of keep) {
    if (pin.worktreePath && candidate.worktreePath) {
      if (path.resolve(pin.worktreePath) === path.resolve(candidate.worktreePath)) return true;
    }
    if (pin.repoPath && pin.agentId !== undefined && candidate.agentId !== undefined) {
      const repo = canonicalizeControlRepoPath(pin.repoPath);
      const candidateRepo = path.resolve(candidate.repoPath);
      if (
        (repo === candidateRepo || path.resolve(pin.repoPath) === candidateRepo) &&
        pin.agentId === candidate.agentId
      ) {
        return true;
      }
    }
    if (pin.repoPath && pin.agentId === undefined && !pin.worktreePath) {
      if (canonicalizeControlRepoPath(pin.repoPath) === candidate.repoPath) return true;
    }
  }
  return false;
}

export function classifySlotCandidate(
  repoPath: string,
  projectName: string,
  slot: AgentSlotStatus,
  options?: { staleDays?: number; keep?: CleanupKeepPin[] },
): CleanupCandidate | undefined {
  if (!slot.active && !slot.worktreePath) return undefined;

  const candidate: CleanupCandidate = {
    kind: 'active_slot',
    repoPath,
    projectName,
    agentId: slot.agentId,
    worktreePath: slot.worktreePath ?? slot.workDir,
    branch: slot.branch,
    active: slot.active,
    dirty: slot.dirty,
    ageDays: ageDaysFrom(slot.sessionCreatedAt),
    sessionCreatedAt: slot.sessionCreatedAt,
    recommendation: 'review',
    reason: 'active session',
  };

  if (matchesKeep(candidate, options?.keep)) {
    candidate.recommendation = 'keep';
    candidate.reason = 'pinned with --keep';
    return candidate;
  }

  if (slot.dirty) {
    candidate.recommendation = 'review';
    candidate.reason = 'uncommitted changes — review before teardown';
    return candidate;
  }

  if (slot.sessionStatus === 'failed' || slot.sessionStatus === 'starting') {
    candidate.recommendation = 'review';
    candidate.reason = 'failed or resumable session — recover or teardown manually';
    return candidate;
  }

  const staleDays = options?.staleDays ?? DEFAULT_STALE_DAYS;
  const age = candidate.ageDays;
  if (age !== undefined && age >= staleDays) {
    candidate.recommendation = 'teardown';
    candidate.reason = `idle ${age}d, clean`;
    return candidate;
  }

  if (slot.active) {
    candidate.recommendation = 'review';
    candidate.reason =
      age !== undefined
        ? `active session (${age}d) — keep unless finished`
        : 'active session — keep unless finished';
  }

  return candidate;
}

function resolveRepoForWorktree(worktreePath: string): string | undefined {
  if (!fs.existsSync(worktreePath)) return undefined;
  const commonDir = runGit(worktreePath, 'rev-parse --git-common-dir');
  if (!commonDir) return undefined;
  const gitRoot = path.resolve(worktreePath, commonDir, '..');
  if (!readManifest(gitRoot)) return undefined;
  return canonicalizeControlRepoPath(gitRoot);
}

function discoverOrphanWorktrees(knownPaths: Set<string>): CleanupCandidate[] {
  const worktreesRoot = getWorktreesRoot();
  if (!fs.existsSync(worktreesRoot)) return [];

  const orphans: CleanupCandidate[] = [];
  for (const entry of fs.readdirSync(worktreesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.includes('-har-agent-')) continue;
    const worktreePath = path.resolve(path.join(worktreesRoot, entry.name));
    if (knownPaths.has(worktreePath)) continue;

    const repoPath = resolveRepoForWorktree(worktreePath) ?? worktreesRoot;
    const porcelain = runGit(worktreePath, 'status --porcelain');
    const dirty = porcelain !== undefined ? porcelain.length > 0 : undefined;
    const branch = runGit(worktreePath, 'rev-parse --abbrev-ref HEAD');

    orphans.push({
      kind: 'orphan_worktree',
      repoPath,
      projectName: basenameRepo(repoPath),
      worktreePath,
      branch: branch && branch !== 'HEAD' ? branch : undefined,
      active: false,
      dirty,
      recommendation: dirty ? 'review' : 'remove_orphan',
      reason: dirty
        ? 'orphan worktree with uncommitted changes'
        : 'orphan worktree — no slot registry',
    });
  }

  return orphans.sort((a, b) => (a.worktreePath ?? '').localeCompare(b.worktreePath ?? ''));
}

export async function discoverCleanupCandidates(
  options: DiscoverCleanupOptions = {},
): Promise<CleanupPlan> {
  const repoPaths =
    options.repoPaths ??
    (await discoverHarRepos({ cwd: options.cwd ?? process.cwd() }));

  const candidates: CleanupCandidate[] = [];
  const knownWorktreePaths = new Set<string>();

  for (const repoPath of repoPaths) {
    if (!fs.existsSync(repoPath) || !readManifest(repoPath)) continue;
    const harnessRoot = resolveHarnessRoot(repoPath);
    const canonicalRepo = canonicalizeControlRepoPath(harnessRoot);
    const status = collectEnvironmentStatus(harnessRoot);
    const projectName = basenameRepo(harnessRoot);

    for (const slot of status.slots) {
      if (slot.worktreePath) knownWorktreePaths.add(path.resolve(slot.worktreePath));
      if (slot.workDir) knownWorktreePaths.add(path.resolve(slot.workDir));

      const candidate = classifySlotCandidate(canonicalRepo, projectName, slot, {
        staleDays: options.staleDays,
        keep: options.keep,
      });
      if (!candidate) continue;
      if (candidate.recommendation === 'review' && !options.includeReview) {
        // Still list review rows in the plan; callers filter at execute time.
      }
      candidates.push(candidate);
    }
  }

  if (options.orphans !== false) {
    for (const orphan of discoverOrphanWorktrees(knownWorktreePaths)) {
      if (matchesKeep(orphan, options.keep)) {
        orphan.recommendation = 'keep';
        orphan.reason = 'pinned with --keep';
      }
      candidates.push(orphan);
    }
  }

  return {
    candidates: candidates.sort((a, b) => {
      const repo = a.repoPath.localeCompare(b.repoPath);
      if (repo !== 0) return repo;
      return (a.agentId ?? 0) - (b.agentId ?? 0);
    }),
    generatedAt: new Date().toISOString(),
  };
}

export function selectAutoApprovedCandidates(
  plan: CleanupPlan,
  options?: { includeReview?: boolean },
): CleanupCandidate[] {
  return plan.candidates.filter((candidate) => {
    if (candidate.recommendation === 'keep') return false;
    if (candidate.recommendation === 'review') return options?.includeReview === true;
    return candidate.recommendation === 'teardown' || candidate.recommendation === 'remove_orphan';
  });
}

export function formatCleanupPlan(plan: CleanupPlan): string {
  if (plan.candidates.length === 0) {
    return 'No session worktrees or orphans found.';
  }

  const lines: string[] = [];
  lines.push(
    `${'REC'.padEnd(8)} ${'REPO'.padEnd(18)} ${'SLOT'.padEnd(6)} ${'AGE'.padEnd(5)} WORKTREE / REASON`,
  );
  lines.push('-'.repeat(100));

  for (const candidate of plan.candidates) {
    const slot = candidate.agentId !== undefined ? String(candidate.agentId) : '-';
    const age = candidate.ageDays !== undefined ? `${candidate.ageDays}d` : '-';
    const target = candidate.worktreePath ?? candidate.repoPath;
    lines.push(
      `${candidate.recommendation.padEnd(8)} ${candidate.projectName.padEnd(18)} ${slot.padEnd(6)} ${age.padEnd(5)} ${target}`,
    );
    lines.push(`         ${candidate.reason}`);
  }

  return lines.join('\n');
}

async function askYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) => {
    rl.question(question, resolve);
  });
  rl.close();
  return /^[Yy]$/.test(answer.trim());
}

export async function confirmCleanupSelection(
  candidates: CleanupCandidate[],
): Promise<CleanupCandidate[]> {
  if (candidates.length === 0) return [];
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Non-interactive terminal — pass --yes (and optionally --include-review)');
  }

  const approved: CleanupCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.recommendation === 'keep') continue;
    const label =
      candidate.kind === 'orphan_worktree'
        ? `orphan ${candidate.worktreePath}`
        : `${candidate.projectName} agent ${candidate.agentId}`;
    const action =
      candidate.recommendation === 'remove_orphan' ? 'remove' : 'teardown';
    const ok = await askYesNo(`${action} ${label}? [${candidate.recommendation === 'teardown' || candidate.recommendation === 'remove_orphan' ? 'Y' : 'y'}/n] `);
    if (ok) approved.push(candidate);
  }
  return approved;
}

export async function executeCleanupCandidates(
  candidates: CleanupCandidate[],
  options: ExecuteCleanupOptions = {},
): Promise<CleanupExecutionOutcome[]> {
  const service = createRunService();
  const outcomes: CleanupExecutionOutcome[] = [];

  for (const candidate of candidates) {
    if (candidate.recommendation === 'keep') continue;

    if (options.dryRun) {
      outcomes.push({ candidate, ok: true });
      continue;
    }

    try {
      if (candidate.kind === 'active_slot' && candidate.agentId !== undefined) {
        const result = await service.teardownEnvironment({
          repoPath: candidate.repoPath,
          agentId: candidate.agentId,
          capture: false,
          trigger: 'cli',
        });
        outcomes.push({
          candidate,
          ok: result.code === 0,
          error: result.code === 0 ? undefined : result.stderr?.trim() || `exit ${result.code}`,
        });
        continue;
      }

      if (candidate.kind === 'orphan_worktree' && candidate.worktreePath) {
        if (fs.existsSync(candidate.worktreePath)) {
          const repoRoot =
            candidate.repoPath !== getWorktreesRoot()
              ? candidate.repoPath
              : resolveRepoForWorktree(candidate.worktreePath);
          if (repoRoot) {
            try {
              execSync(`git worktree remove --force ${JSON.stringify(candidate.worktreePath)}`, {
                cwd: repoRoot,
                stdio: ['pipe', 'pipe', 'ignore'],
              });
            } catch {
              // Fall through to directory removal when git metadata is broken.
            }
          }
          if (fs.existsSync(candidate.worktreePath)) {
            fs.rmSync(candidate.worktreePath, { recursive: true, force: true });
          }
        }
        outcomes.push({ candidate, ok: true });
        continue;
      }

      outcomes.push({ candidate, ok: false, error: 'unsupported candidate' });
    } catch (err: unknown) {
      outcomes.push({
        candidate,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return outcomes;
}

export function parseCleanupKeepPins(values: string[] | undefined): CleanupKeepPin[] {
  if (!values?.length) return [];
  return values.map((raw) => {
    const agentMatch = raw.match(/^(.+):(\d+)$/);
    if (agentMatch) {
      return { repoPath: agentMatch[1], agentId: Number(agentMatch[2]) };
    }
    if (raw.startsWith('/') || raw.startsWith('~')) {
      return {
        worktreePath: raw.startsWith('~')
          ? path.join(process.env.HOME || os.homedir(), raw.slice(2))
          : path.resolve(raw),
      };
    }
    return { repoPath: raw };
  });
}
