import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { readSlotRegistry, isSlotResumable } from '../core/slot-registry';

/**
 * Package-side session worktree runtime (#234) — ports the git/session parts of
 * .har/launch.sh and .har/teardown.sh. Observable behavior (branch/worktree
 * naming, work-dir resolution, exclude patterns) is byte-compatible with the
 * bash implementation.
 */

/** Runs `git -C <cwd> <args…>` and returns trimmed stdout. */
export type GitRunner = (args: string[], cwd: string) => string;

const defaultGit: GitRunner = (args, cwd) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

function tryGit(git: GitRunner, args: string[], cwd: string): string | undefined {
  try {
    return git(args, cwd);
  } catch {
    return undefined;
  }
}

/** Patterns launch.sh seeds into <git-common-dir>/info/exclude. */
export const GIT_EXCLUDE_PATTERNS = [
  '.env.agent.*',
  'ecosystem.agent.*.config.cjs',
  '.har/venv',
] as const;

/** `${BASE_BRANCH//\//-}` — every slash becomes a dash. */
export function sanitizeSessionBranch(baseBranch: string): string {
  return baseBranch.replace(/\//g, '-');
}

/**
 * 4 chars of [a-z0-9], mirroring `tr -dc 'a-z0-9' </dev/urandom | head -c 4`
 * with the zero-padded `RANDOM % 10000` fallback.
 */
export function generateSessionSuffix(
  randomBytes: (size: number) => Buffer = crypto.randomBytes,
): string {
  try {
    let out = '';
    while (out.length < 4) {
      for (const byte of randomBytes(16)) {
        const ch = String.fromCharCode(byte);
        if (/[a-z0-9]/.test(ch)) {
          out += ch;
          if (out.length === 4) break;
        }
      }
    }
    return out;
  } catch {
    return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  }
}

/** `<base-branch>-<sha4>-har-agent-<id>-<rand4>` — branch and worktree basename. */
export function buildSessionName(
  baseBranch: string,
  shortSha: string,
  agentId: number,
  suffix: string,
): string {
  return `${sanitizeSessionBranch(baseBranch)}-${shortSha}-har-agent-${agentId}-${suffix}`;
}

function stripOneTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/**
 * `WORK_DIR="${WORKTREE_DIR%/}/${REL_PREFIX}"; WORK_DIR="${WORK_DIR%/}"` —
 * relPrefix is git's `rev-parse --show-prefix` output ('' at the repo root,
 * trailing slash otherwise).
 */
export function joinWorkDir(worktreeDir: string, relPrefix: string): string {
  return stripOneTrailingSlash(`${stripOneTrailingSlash(worktreeDir)}/${relPrefix}`);
}

export interface SessionWorktreeOptions {
  /** Main checkout root (launch.sh's REPO_ROOT). */
  repoRoot: string;
  agentId: number;
  /** Overrides $HOME (worktrees live under <home>/worktrees). */
  homeDir?: string;
  /** Injectable for tests; defaults to a fresh random suffix. */
  suffix?: string;
  git?: GitRunner;
}

export interface SessionWorktree {
  sessionName: string;
  branch: string;
  suffix: string;
  worktreeDir: string;
  /** Where edits/builds happen: worktree + monorepo prefix. */
  workDir: string;
  /** `git rev-parse --show-prefix` of the repo root ('' outside a subdir). */
  relPrefix: string;
  baseBranch: string;
  baseCommit: string;
}

/**
 * Creates the suffixed session worktree from HEAD — the non-resume branch of
 * launch.sh: naming, `git worktree add -b`, monorepo prefix resolution.
 */
export function createSessionWorktree(options: SessionWorktreeOptions): SessionWorktree {
  const git = options.git ?? defaultGit;
  const repoRoot = options.repoRoot;
  const homeDir = options.homeDir ?? os.homedir();

  const baseBranch = tryGit(git, ['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot) ?? 'detached';
  const baseCommit = tryGit(git, ['rev-parse', 'HEAD'], repoRoot) ?? '';
  const shortSha = git(['rev-parse', '--short=4', 'HEAD'], repoRoot);
  const suffix = options.suffix ?? generateSessionSuffix();

  const sessionName = buildSessionName(baseBranch, shortSha, options.agentId, suffix);
  const worktreeDir = path.join(homeDir, 'worktrees', sessionName);

  git(['worktree', 'add', worktreeDir, '-b', sessionName], repoRoot);

  const relPrefix = tryGit(git, ['rev-parse', '--show-prefix'], repoRoot) ?? '';
  const workDir = joinWorkDir(worktreeDir, relPrefix);

  return {
    sessionName,
    branch: sessionName,
    suffix,
    worktreeDir,
    workDir,
    relPrefix,
    baseBranch,
    baseCommit,
  };
}

/**
 * Appends the harness ignore patterns to <git-common-dir>/info/exclude,
 * skipping lines already present (grep -qxF semantics). No-op when the
 * exclude directory does not exist.
 */
export function seedGitExclude(repoRoot: string, git: GitRunner = defaultGit): void {
  const commonDir = tryGit(git, ['rev-parse', '--git-common-dir'], repoRoot);
  if (!commonDir) return;
  const resolved = path.isAbsolute(commonDir) ? commonDir : path.resolve(repoRoot, commonDir);
  const excludeFile = path.join(resolved, 'info', 'exclude');
  if (!fs.existsSync(path.dirname(excludeFile))) return;

  const existing = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
  const lines = new Set(existing.split('\n'));
  let appended = '';
  for (const pattern of GIT_EXCLUDE_PATTERNS) {
    if (!lines.has(pattern)) appended += `${pattern}\n`;
  }
  if (!appended) return;
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(excludeFile, prefix + appended);
}

export interface ResumedSession {
  workDir: string;
  worktreeDir: string;
  branch: string;
  suffix: string;
  baseBranch: string;
  baseCommit: string;
  useWorktree: boolean;
  envFile: string;
}

export type ResumeResolution =
  | { ok: true; session: ResumedSession }
  | {
      ok: false;
      code: 'not-resumable' | 'missing-work-dir' | 'missing-env-file';
      message: string;
    };

/**
 * TS equivalent of har_resume_session_assignments: reads the slot registry,
 * validates resumability, work dir, and env file, and returns the typed
 * session state a resume launch continues from.
 */
export function resolveResumeSession(repoPath: string, agentId: number): ResumeResolution {
  const session = readSlotRegistry(repoPath, agentId);
  if (!isSlotResumable(session)) {
    const status = session?.status ?? 'none';
    return {
      ok: false,
      code: 'not-resumable',
      message: `slot ${agentId} is not resumable (status=${status}; need failed or starting).`,
    };
  }

  const workDir = session?.workDir ?? '';
  if (!workDir || !fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory()) {
    return {
      ok: false,
      code: 'missing-work-dir',
      message: 'resume requires work dir from registry (missing or not found).',
    };
  }

  const envFile = path.join(workDir, `.env.agent.${agentId}`);
  if (!fs.existsSync(envFile)) {
    return {
      ok: false,
      code: 'missing-env-file',
      message: `resume requires env file: ${envFile}`,
    };
  }

  return {
    ok: true,
    session: {
      workDir,
      worktreeDir: session?.worktreePath ?? '',
      branch: session?.branch ?? '',
      suffix: session?.suffix ?? '',
      baseBranch: session?.baseBranch ?? '',
      baseCommit: session?.baseCommit ?? '',
      useWorktree: session?.mode === 'worktree',
      envFile,
    },
  };
}

/** har_toolchain_ready: deps already installed before the failed launch step. */
export function isToolchainReady(workDir: string): boolean {
  if (
    fs.existsSync(path.join(workDir, 'package.json')) &&
    fs.existsSync(path.join(workDir, 'node_modules'))
  ) {
    return true;
  }
  return fs.existsSync(path.join(workDir, '.har', 'venv'));
}

export interface TeardownWorktreeOptions {
  repoRoot: string;
  agentId: number;
  /** From the slot registry; falls back to the legacy fixed path. */
  worktreePath?: string;
  /** Legacy fallback path component (teardown.sh's HARNESS_PROJECT_NAME). */
  projectName?: string;
  branch?: string;
  /** Branch is KEPT by default (teardown.sh --delete-branch). */
  deleteBranch?: boolean;
  homeDir?: string;
  git?: GitRunner;
}

export interface TeardownWorktreeResult {
  removedWorktree?: string;
  deletedBranch?: string;
  keptBranch?: string;
}

/**
 * Git parts of teardown.sh: remove the session worktree (falling back to
 * rm -rf when git refuses), prune stale worktree records, and keep or delete
 * the session branch. Per-agent env/ecosystem files inside the worktree are
 * removed first, as the script does.
 */
export function removeSessionWorktree(options: TeardownWorktreeOptions): TeardownWorktreeResult {
  const git = options.git ?? defaultGit;
  const homeDir = options.homeDir ?? os.homedir();
  const result: TeardownWorktreeResult = {};

  let worktreePath = options.worktreePath;
  if (!worktreePath && options.projectName) {
    worktreePath = path.join(homeDir, 'worktrees', `${options.projectName}-agent-${options.agentId}`);
  }

  if (worktreePath && fs.existsSync(worktreePath)) {
    for (const name of [
      `.env.agent.${options.agentId}`,
      `ecosystem.agent.${options.agentId}.config.cjs`,
    ]) {
      fs.rmSync(path.join(worktreePath, name), { force: true });
    }
    try {
      git(['worktree', 'remove', worktreePath, '--force'], options.repoRoot);
    } catch {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
    result.removedWorktree = worktreePath;
  }

  tryGit(git, ['worktree', 'prune'], options.repoRoot);

  if (options.branch) {
    if (options.deleteBranch) {
      tryGit(git, ['branch', '-D', options.branch], options.repoRoot);
      result.deletedBranch = options.branch;
    } else {
      result.keptBranch = options.branch;
    }
  }

  return result;
}
