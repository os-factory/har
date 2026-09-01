import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readHarnessEnv } from '../harness/env';
import { getHarnessDir, resolveHarnessRoot } from '../harness/manifest';
import { readSlotRegistry, removeSlotRegistry } from '../core/slot-registry';
import { defaultExec, ExecFn, LogFn } from './exec';
import { dropAgentDatabase, infraEnabled, infraPortDefault, removeMinioBucket, HttpRequestFn } from './infra';
import { deleteAgentProcesses } from './process';
import { pkgExec } from './node-pm';
import { realSystemOps, SystemOps } from './exec';
import { GitRunner, removeSessionWorktree } from './worktree';
import { detectProcessManager } from './launch';
import { releaseSimulator } from './xcode-sim';
import { loadInfraState } from '../core/slot-ports';
import { postHookFailureMode, runLifecycleHook } from './hooks';

export interface TeardownSessionOptions {
  repoPath: string;
  agentId: number;
  deleteBranch?: boolean;
  /** Sink for the script-parity stdout lines (`==> …`, `✓ …`). */
  out?: LogFn;
  exec?: ExecFn;
  ops?: SystemOps;
  git?: GitRunner;
  homeDir?: string;
  httpRequest?: HttpRequestFn;
}

/**
 * The package-side teardown pipeline (#234): stop the slot's processes, drop
 * per-agent infra resources, remove generated files and the session worktree
 * (branch kept unless deleteBranch), release the simulator claim (ios), and
 * clear the slot registry. Line-for-line with the retired teardown.sh scripts.
 */
export async function teardownSession(options: TeardownSessionOptions): Promise<{ code: number }> {
  const repoRoot = resolveHarnessRoot(options.repoPath);
  const harnessDir = getHarnessDir(repoRoot);
  const env = readHarnessEnv(repoRoot);
  const agentId = options.agentId;
  const pm = detectProcessManager(repoRoot);
  const exec = options.exec ?? defaultExec;
  const ops = options.ops ?? realSystemOps;
  const out = options.out ?? ((message: string) => process.stdout.write(`${message}\n`));
  const projectName = env.HARNESS_PROJECT_NAME ?? '';

  out(`==> Tearing down agent ${agentId}...`);

  const session = readSlotRegistry(repoRoot, agentId);
  const homeDir = options.homeDir ?? os.homedir();
  const worktreePath =
    session?.worktreePath || path.join(homeDir, 'worktrees', `${projectName}-agent-${agentId}`);
  const workDir = session?.workDir ?? '';
  const branch = session?.branch ?? '';

  // ── pre-teardown hook (#238) — session resources still exist ────────────────
  const preHook = runLifecycleHook('pre-teardown', {
    harnessDir,
    agentId,
    workDir: workDir || repoRoot,
    envFile: workDir ? path.join(workDir, `.env.agent.${agentId}`) : undefined,
    exec: options.exec,
    log: (message) => out(`==> ${message}`),
  });
  if (preHook.ran && preHook.code !== 0) {
    out(`ERROR: pre-teardown hook failed (exit ${preHook.code}): ${preHook.file}`);
    return { code: preHook.code || 1 };
  }

  if (pm === 'pm2') {
    deleteAgentProcesses({
      projectName,
      agentId,
      pkgExecPrefix: pkgExec(undefined, env, ops).split(' '),
      exec,
    });
    out('✓ Stopped PM2 processes');

    if (infraEnabled(env, 'db')) {
      const infraState = loadInfraState(repoRoot, repoRoot);
      const dbPort = Number(infraState.AGENT_DB_PORT ?? infraPortDefault(env, 'db', 15432));
      dropAgentDatabase(agentId, { env, dbPort, exec });
      out(`✓ Dropped database: agent_${agentId}`);
    }

    if (infraEnabled(env, 'minio')) {
      await removeMinioBucket(agentId, { env, httpRequest: options.httpRequest });
      out(`✓ Removed MinIO bucket: agent-${agentId}`);
    }
  }

  const generated = (dir: string) => [
    path.join(dir, `.env.agent.${agentId}`),
    ...(pm === 'pm2' ? [path.join(dir, `ecosystem.agent.${agentId}.config.cjs`)] : []),
  ];
  for (const dir of [repoRoot, workDir]) {
    if (!dir) continue;
    for (const file of generated(dir)) fs.rmSync(file, { force: true });
  }

  const removed = removeSessionWorktree({
    repoRoot,
    agentId,
    worktreePath,
    projectName,
    mode: session?.mode,
    branch: branch || undefined,
    deleteBranch: options.deleteBranch,
    homeDir: options.homeDir,
    git: options.git,
  });
  if (removed.removedWorktree) out(`✓ Removed worktree: ${removed.removedWorktree}`);
  if (removed.preservedWorktree) {
    out(`✓ Kept externally-owned worktree: ${removed.preservedWorktree} (HAR did not create it)`);
  }
  if (removed.deletedBranch) out(`✓ Deleted branch: ${removed.deletedBranch}`);
  if (removed.keptBranch) {
    out(`✓ Kept branch: ${removed.keptBranch} (push it or delete with: git branch -D ${removed.keptBranch})`);
  }

  if (pm === 'simulator') {
    releaseSimulator({ env, harnessDir, repoRoot, agentId }, out);
  }

  removeSlotRegistry(repoRoot, agentId);

  // ── post-teardown hook (#238) — everything is gone; failure policy is config ─
  const postHook = runLifecycleHook('post-teardown', {
    harnessDir,
    agentId,
    workDir: repoRoot,
    exec: options.exec,
    log: (message) => out(`==> ${message}`),
  });
  if (postHook.ran && postHook.code !== 0) {
    if (postHookFailureMode(env) === 'fail') {
      out(`ERROR: post-teardown hook failed (exit ${postHook.code}): ${postHook.file}`);
      return { code: postHook.code || 1 };
    }
    out(
      `WARN: post-teardown hook failed (exit ${postHook.code}): ${postHook.file} — continuing (HARNESS_HOOK_POST_FAILURE=warn)`,
    );
  }

  out(`✓ Agent ${agentId} torn down`);
  return { code: 0 };
}
