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
import {
  quoteShellArg,
  runScriptCapture,
  runShellCommand,
  ShellResult,
} from '../utils/shell';
import { buildStageResult, parseVerificationResult } from './results';
import {
  ArtifactEntry,
  ExecutionContext,
  LaunchFlags,
  StageExecutor,
  StageRunOptions,
} from './types';
import { readSlotRegistry } from './slot-registry';
import {
  launchSession,
  runAgentOp,
  runSetupInfra,
  teardownSession,
  buildVerifyPlan,
  VerifyPlanError,
} from '../runtime';

/** Argv fragments forwarded to the launch pipeline for a launch stage. */
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

  // Pre-1.0 vendored lifecycle scripts remain until `--migrate` deletes them.
  // After #314, stages.json dispatches by kind and may have no command/script.
  const fallback =
    stage.kind === 'inspect' ? 'agent-cli.sh' : RUNTIME_SCRIPT_FOR_KIND[stage.kind];
  if (fallback) {
    const fallbackPath = path.join(harnessDir, fallback);
    if (fs.existsSync(fallbackPath)) return fallbackPath;
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

async function executePlan(
  plan: StageExecutionPlan,
  options: { capture: boolean; streamStdout?: boolean },
): Promise<ShellResult> {
  const spawnOptions = {
    cwd: plan.cwd,
    env: plan.env,
    stream: !options.capture,
    streamStdout: options.streamStdout,
  };

  if (plan.mode === 'shell' && plan.shellCommand) {
    return runShellCommand(plan.shellCommand, spawnOptions);
  }

  if (plan.scriptPath) {
    return runScriptCapture(plan.scriptPath, plan.args, spawnOptions);
  }

  throw new Error('Invalid stage execution plan');
}

/** Collects pipeline output for run records while optionally echoing it live. */
function makeSink(stream: NodeJS.WriteStream, live: boolean): { write: (line: string) => void; text: () => string } {
  const lines: string[] = [];
  return {
    write: (line: string) => {
      lines.push(line);
      if (live) stream.write(`${line}\n`);
    },
    text: () => (lines.length > 0 ? lines.join('\n') + '\n' : ''),
  };
}

/** Stage command tail after a leftover `./.har/agent-cli.sh {agentId}` command. */
function agentCliOp(stage: HarnessStage): string[] | undefined {
  const target = stage.command ?? stage.script ?? '';
  if (!/agent-cli\.sh/.test(target)) return undefined;
  const tokens = (stage.command ?? '').split(/\s+/).filter(Boolean);
  const scriptIndex = tokens.findIndex((token) => token.includes('agent-cli.sh'));
  if (scriptIndex < 0) return [];
  return tokens.slice(scriptIndex + 1).filter((token) => token !== '{agentId}');
}

/** Inspect stages dispatch by id (status, logs, …) when no custom command is set. */
function inspectOp(stage: HarnessStage): string[] | undefined {
  const fromShim = agentCliOp(stage);
  if (fromShim !== undefined) return fromShim;
  if (stage.kind === 'inspect' && !stage.command && !stage.script) {
    return [stage.id];
  }
  return undefined;
}

const RUNTIME_SCRIPT_FOR_KIND: Partial<Record<string, string>> = {
  launch: 'launch.sh',
  teardown: 'teardown.sh',
  setup: 'setup-infra.sh',
  verify: 'verify.sh',
};

/**
 * A pre-#234 harness still carries the full bash runtime in its generated
 * scripts (adapted, possibly customized). Until #241 migrates it, that script
 * stays authoritative — the package runtime takes over only when the script is
 * one of the thin `exec har env` delegates, or is absent entirely.
 */
function harnessScriptIsLegacy(repoPath: string, scriptName: string): boolean {
  const file = path.join(getHarnessDir(resolveHarnessRoot(repoPath)), scriptName);
  if (!fs.existsSync(file)) return false;
  return !fs.readFileSync(file, 'utf8').includes('exec har env');
}

/**
 * Kinds the package runtime owns (#234): launch, teardown, setup, verify, and
 * agent-cli inspect ops. Returns undefined for everything else (project stages,
 * custom commands, pre-1.0 harnesses with their own runtime bash) so they keep
 * running as scripts/shell.
 */
const warnedLegacyScripts = new Set<string>();

/**
 * Compat-window deprecation (#241): loud, once per script per process — the
 * vendored script keeps running (grandfathering, #234), never breaks.
 */
function warnLegacyRuntimeScript(repoPath: string, scriptName: string): void {
  const key = `${path.resolve(repoPath)}:${scriptName}`;
  if (warnedLegacyScripts.has(key)) return;
  warnedLegacyScripts.add(key);
  process.stderr.write(
    `DEPRECATED: .har/${scriptName} carries the pre-1.0 vendored runtime — it keeps working ` +
      'for now, but 1.0 runs the runtime from the package. Run `har env maintain` to generate ' +
      'the migration prompt (.har/MIGRATE-PROMPT.md).\n',
  );
}

async function runPackageRuntimeStage(
  repoPath: string,
  stage: HarnessStage,
  options: StageRunOptions,
  capture: boolean,
): Promise<StageResult | undefined> {
  const legacyScript = RUNTIME_SCRIPT_FOR_KIND[stage.kind];
  // A leftover vendored file is authoritative only while stages.json still
  // points at it. Kind-only entries (#314) dispatch through the package.
  if (
    legacyScript &&
    (stage.command || stage.script) &&
    harnessScriptIsLegacy(repoPath, legacyScript)
  ) {
    warnLegacyRuntimeScript(repoPath, legacyScript);
    return undefined;
  }
  const started = Date.now();
  const finish = (exitCode: number, stdout: string, stderr: string, previewUrls?: Record<string, string>) =>
    buildStageResult({
      stageId: stage.id,
      kind: stage.kind,
      agentId: options.agentId,
      exitCode,
      stdout,
      stderr,
      durationMs: Date.now() - started,
      previewUrls,
    });

  if (stage.kind === 'launch' && options.agentId !== undefined) {
    const out = makeSink(process.stderr, !capture);
    const flags = options.launchFlags ?? {};
    const result = await launchSession({
      repoPath,
      agentId: options.agentId,
      worktree: flags.worktree,
      claude: flags.claude,
      resume: flags.resume,
      workUnitId: flags.workUnitId,
      attemptId: flags.attemptId,
      log: out.write,
      error: out.write,
    });
    const previewUrls =
      result.code === 0
        ? result.previewUrls ?? computePreviewUrls(repoPath, options.agentId)
        : undefined;
    return finish(result.code, '', out.text(), previewUrls);
  }

  if (stage.kind === 'teardown' && options.agentId !== undefined) {
    const out = makeSink(process.stdout, !capture);
    const result = await teardownSession({
      repoPath,
      agentId: options.agentId,
      deleteBranch: options.args?.includes('--delete-branch'),
      out: out.write,
    });
    return finish(result.code, out.text(), '');
  }

  if (stage.kind === 'setup') {
    const out = makeSink(process.stderr, !capture);
    const result = await runSetupInfra({ repoPath, log: out.write });
    return finish(result.code, '', out.text());
  }

  if (stage.kind === 'verify' && options.agentId !== undefined) {
    let plan;
    try {
      plan = buildVerifyPlan(repoPath, options.agentId, options.args ?? [], {
        ...process.env,
        ...readHarnessEnv(resolveHarnessRoot(repoPath)),
        ...(stage.env ?? {}),
      });
    } catch (err) {
      if (err instanceof VerifyPlanError) {
        const stderr = [err.message, ...err.hint].join('\n') + '\n';
        if (!capture) process.stderr.write(stderr);
        return finish(1, '', stderr);
      }
      throw err;
    }
    const result = await runShellCommand(plan.shellCommand, {
      cwd: plan.cwd,
      env: plan.env,
      stream: !capture,
      streamStdout: false,
    });
    return buildStageResult({
      stageId: stage.id,
      kind: stage.kind,
      agentId: options.agentId,
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - started,
      verification: parseVerificationResult(result.stdout),
    });
  }

  const op = inspectOp(stage);
  if (
    op !== undefined &&
    (stage.command || stage.script) &&
    harnessScriptIsLegacy(repoPath, 'agent-cli.sh')
  ) {
    return undefined;
  }
  if (op !== undefined && options.agentId !== undefined) {
    const command = op[0] ?? options.args?.[0] ?? 'status';
    const args = op.length > 0 ? [...op.slice(1), ...(options.args ?? [])] : (options.args ?? []).slice(1);
    const out = makeSink(process.stdout, !capture);
    const result = await runAgentOp({
      repoPath,
      agentId: options.agentId,
      command,
      args,
      out: out.write,
    });
    return finish(result.code, out.text(), '');
  }

  return undefined;
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

    const capture = options.capture ?? ctx.capture ?? true;

    // The runtime kinds (#234 / #314) run in the package — dispatch by kind,
    // never through generated lifecycle wrappers.
    const runtimeResult = await runPackageRuntimeStage(repoPath, stage, options, capture);
    if (runtimeResult) return runtimeResult;

    const plan = buildExecutionPlan(repoPath, stage, options);
    const started = Date.now();
    // verify.sh writes a JSON contract to stdout and progress to stderr.
    // Stream progress only — echoing stdout duplicates the blob in CI/agent logs.
    const result = await executePlan(plan, {
      capture,
      streamStdout: stage.kind !== 'verify',
    });
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
