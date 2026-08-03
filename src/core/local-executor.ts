import * as fs from 'fs';
import * as path from 'path';
import { getHarnessDir, resolveHarnessRoot } from '../harness/manifest';
import { readHarnessEnv } from '../harness/env';
import {
  getArtifactsDir,
  resolveStage,
  stageRequiresAgentId,
} from '../harness/stages';
import { HarnessStage, StageResult } from '../harness/schema';
import { validateAgentId } from '../utils/validation';
import { runScript, runScriptCapture, runShellCommand, ShellResult } from '../utils/shell';
import { buildStageResult, parseVerificationResult } from './results';
import {
  ArtifactEntry,
  ExecutionContext,
  LaunchFlags,
  StageExecutor,
  StageRunOptions,
} from './types';
import { readSlotRegistry } from './slot-registry';

/** Quote a single argv token for `bash -lc` when it needs shell metacharacters. */
export function quoteShellArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Argv fragments forwarded to launch.sh for a launch stage. */
export function buildLaunchFlagArgs(flags: LaunchFlags): string[] {
  const args: string[] = [];
  if (flags.worktree === false) args.push('--no-worktree');
  if (flags.claude) args.push('--claude');
  if (flags.resume) args.push('--resume');
  if (flags.workUnitId) args.push(`--work-id=${flags.workUnitId}`);
  if (flags.attemptId) args.push(`--attempt-id=${flags.attemptId}`);
  return args;
}

function resolveRepoPath(repoPath: string): string {
  return path.resolve(repoPath);
}

function buildPreviewUrlsFromPorts(
  ports: Record<string, number>,
  env: Record<string, string>,
): Record<string, string> {
  const urls: Record<string, string> = {};
  if (ports.frontend) urls.frontend = `http://localhost:${ports.frontend}`;
  if (ports.api) {
    urls.api = `http://localhost:${ports.api}`;
    if (env.HARNESS_HEALTH_CHECK_PATH) {
      urls.health = `http://localhost:${ports.api}${env.HARNESS_HEALTH_CHECK_PATH}`;
    }
  }
  if (ports.browser) urls.browser = `http://localhost:${ports.browser}`;
  if (ports.mailpit) urls.mailpit = `http://localhost:${ports.mailpit}`;
  return urls;
}

export { readHarnessEnv } from '../harness/env';

export function computePreviewUrls(repoPath: string, agentId: number): Record<string, string> {
  const harnessRoot = resolveHarnessRoot(repoPath);
  const session = readSlotRegistry(harnessRoot, agentId);
  if (session?.previewUrls && Object.keys(session.previewUrls).length > 0) {
    return session.previewUrls;
  }

  const env = readHarnessEnv(harnessRoot);
  if (session?.ports && Object.keys(session.ports).length > 0) {
    return buildPreviewUrlsFromPorts(session.ports, env);
  }

  const step = Number(env.HARNESS_PORT_STEP ?? 10);
  const feBase = Number(env.HARNESS_FE_BASE_PORT ?? 3000);
  const apiBase = Number(env.HARNESS_API_BASE_PORT ?? 8000);
  const fePort = feBase + agentId * step;
  const apiPort = apiBase + agentId * step;

  const urls: Record<string, string> = {
    frontend: `http://localhost:${fePort}`,
    api: `http://localhost:${apiPort}`,
  };

  if (env.HARNESS_HEALTH_CHECK_PATH) {
    urls.health = `http://localhost:${apiPort}${env.HARNESS_HEALTH_CHECK_PATH}`;
  }
  if (env.HARNESS_INFRA_BROWSER === 'true') {
    urls.browser = `http://localhost:${env.HARNESS_BROWSER_PORT_DEFAULT ?? 13001}`;
  }
  if (env.HARNESS_INFRA_MAILPIT === 'true') {
    urls.mailpit = `http://localhost:${env.HARNESS_MAILPIT_WEB_PORT_DEFAULT ?? 18025}`;
  }

  return urls;
}

interface StageExecutionPlan {
  mode: 'script' | 'shell';
  scriptPath?: string;
  shellCommand?: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function substituteAgentId(value: string, agentId?: number): string {
  if (agentId === undefined) return value;
  return value.replace(/\{agentId\}/g, String(agentId));
}

function resolveStageScriptPath(repoPath: string, stage: HarnessStage): string {
  const harnessDir = getHarnessDir(repoPath);

  if (stage.script) {
    return path.join(harnessDir, stage.script);
  }

  if (stage.command) {
    const scriptName = stage.command
      .split(/\s+/)[0]
      .replace(/^\.\/\.har\//, '')
      .replace(/^\.\//, '');
    return path.join(harnessDir, scriptName);
  }

  const stageScript = path.join(harnessDir, 'stages', `${stage.id}.sh`);
  if (fs.existsSync(stageScript)) {
    return stageScript;
  }

  throw new Error(
    `Stage "${stage.id}" has no runnable script. Add script to stages.json, create .har/stages/${stage.id}.sh, or run verification via har_run_verification.`,
  );
}

function buildExecutionPlan(
  repoPath: string,
  stage: HarnessStage,
  options: StageRunOptions,
): StageExecutionPlan {
  const resolvedRepo = resolveRepoPath(repoPath);
  const harnessEnv = readHarnessEnv(resolvedRepo);
  const mergedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...harnessEnv,
    ...(stage.env ?? {}),
  };
  const cwd = stage.cwd ? path.resolve(resolvedRepo, stage.cwd) : resolvedRepo;
  const extraArgs = options.args ?? [];

  const launchFlagArgs =
    stage.kind === 'launch' && options.launchFlags
      ? buildLaunchFlagArgs(options.launchFlags)
      : [];

  if (stage.command) {
    let shellCommand = substituteAgentId(stage.command, options.agentId);
    for (const extra of [...extraArgs, ...launchFlagArgs]) {
      shellCommand = `${shellCommand} ${quoteShellArg(extra)}`;
    }
    return { mode: 'shell', shellCommand, args: [], cwd, env: mergedEnv };
  }

  const args: string[] = [];
  if (stageRequiresAgentId(stage) && options.agentId !== undefined) {
    args.push(String(options.agentId));
  }
  args.push(...extraArgs, ...launchFlagArgs);

  return {
    mode: 'script',
    scriptPath: resolveStageScriptPath(resolvedRepo, stage),
    args,
    cwd,
    env: mergedEnv,
  };
}

async function executePlan(plan: StageExecutionPlan, capture: boolean): Promise<ShellResult> {
  const spawnOptions = { cwd: plan.cwd, env: plan.env };

  if (plan.mode === 'shell' && plan.shellCommand) {
    return runShellCommand(plan.shellCommand, { ...spawnOptions, stream: !capture });
  }

  if (plan.scriptPath) {
    if (capture) {
      return runScriptCapture(plan.scriptPath, plan.args, spawnOptions);
    }
    return runScript(plan.scriptPath, plan.args, spawnOptions);
  }

  throw new Error('Invalid stage execution plan');
}

export class LocalScriptExecutor implements StageExecutor {
  async runStage(ctx: ExecutionContext, options: StageRunOptions): Promise<StageResult> {
    const repoPath = resolveRepoPath(options.repoPath ?? ctx.repoPath);
    const stage = resolveStage(repoPath, { id: options.stageId, kind: options.kind });
    if (!stage) {
      const hint = options.stageId
        ? `Stage id "${options.stageId}" not found in .har/stages.json`
        : options.kind
          ? `No stage with kind "${options.kind}" found in .har/stages.json`
          : 'Provide stageId or kind';
      throw new Error(hint);
    }

    if (stageRequiresAgentId(stage)) {
      validateAgentId(options.agentId, repoPath);
    }

    const plan = buildExecutionPlan(repoPath, stage, options);
    const capture = options.capture ?? ctx.capture ?? true;
    const started = Date.now();
    const result = await executePlan(plan, capture);
    const durationMs = Date.now() - started;

    const verification =
      stage.kind === 'verify' ? parseVerificationResult(result.stdout) : undefined;

    const previewUrls =
      stage.kind === 'launch' && result.code === 0 && options.agentId !== undefined
        ? computePreviewUrls(repoPath, options.agentId)
        : undefined;

    return buildStageResult({
      stageId: stage.id,
      kind: stage.kind,
      agentId: options.agentId,
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs,
      verification,
      previewUrls,
    });
  }

  listArtifacts(ctx: ExecutionContext, filter?: { stageId?: string }): ArtifactEntry[] {
    const repoPath = resolveRepoPath(ctx.repoPath);
    const harnessDir = getHarnessDir(repoPath);
    const artifactsDirName = getArtifactsDir(repoPath);
    const artifactsDir = path.join(harnessDir, artifactsDirName);

    if (!fs.existsSync(artifactsDir)) return [];

    const entries: ArtifactEntry[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const relative = path.join(prefix, entry.name);
        if (entry.isDirectory()) {
          walk(full, relative);
          continue;
        }
        if (filter?.stageId && !relative.includes(filter.stageId)) continue;
        const stat = fs.statSync(full);
        entries.push({
          path: full,
          relativePath: relative,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        });
      }
    };

    walk(artifactsDir, artifactsDirName);
    return entries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }
}

export const localScriptExecutor = new LocalScriptExecutor();
