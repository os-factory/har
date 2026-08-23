import { parseVerificationResult } from './results';
import * as crypto from 'crypto';
import { localScriptExecutor } from './local-executor';
import { createRun, finishRun, resolveAgentWorkDir } from './runs';
import { listSlotRegistryEntries, readSlotRegistry } from './slot-registry';
import { checkLaunchGuard } from './slot-launch-guard';
import { formatPreflightReport, inspectSlotReadiness } from './slot-preflight';
import { recordValidation, resolveValidationCheckoutDir } from './validations';
import {
  bindValidationToAttempt,
  createWorkAttempt,
  decideWorkUnitOutcome,
  findWorkUnit,
  upsertWorkUnit,
} from './work-units';
import { resolveHarnessRoot } from '../harness/manifest';
import { runDoctor, summarizeDoctorReport } from '../harness/doctor';
import { resolveStage } from '../harness/stages';
import { collectEnvironmentStatus, renderEnvironmentStatusText } from './slot-status';
import { HarnessStage } from '../harness/schema';
import { validateAgentId } from '../utils/validation';
import { ensureTelemetryInfrastructure } from './telemetry-ensure';
import { isTelemetryEnabled } from './telemetry-config';
import {
  appendTelemetryEnvToFile,
  buildSessionKey,
} from './telemetry-env';
import * as path from 'path';
import {
  ArtifactEntry,
  EnvironmentRunResult,
  EnvironmentStatusRunResult,
  ExecutionContext,
  LaunchOptions,
  LogsOptions,
  PreflightOptions,
  PreflightResult,
  StageExecutor,
  StageRunOptions,
  VerificationRunResult,
} from './types';
import { StageResult, VerificationResult } from '../harness/schema';

function extractShellOutput(result: StageResult): { stdout: string; stderr: string; code: number } {
  const stdout =
    result.logs?.find((log) => log.stream === 'stdout')?.content ??
    result.logs?.find((log) => !log.stream)?.content ??
    '';
  const stderr = result.logs?.find((log) => log.stream === 'stderr')?.content ?? '';
  return { stdout, stderr, code: result.code ?? (result.status === 'pass' ? 0 : 1) };
}

function previewUrlsFromResult(result: StageResult): Record<string, string> | undefined {
  if (!result.urls?.length) return undefined;
  const urls: Record<string, string> = {};
  for (const entry of result.urls) {
    const label = entry.label ?? 'url';
    urls[label] = entry.url;
  }
  return Object.keys(urls).length > 0 ? urls : undefined;
}

function toEnvironmentRunResult(result: StageResult): EnvironmentRunResult {
  const { stdout, stderr, code } = extractShellOutput(result);
  return {
    code,
    stdout,
    stderr,
    previewUrls: previewUrlsFromResult(result),
  };
}

function resolveStageCommand(
  stage: HarnessStage,
  agentId?: number,
  args?: string[],
): string | undefined {
  if (stage.command) {
    let cmd = stage.command.replace(/\{agentId\}/g, agentId !== undefined ? String(agentId) : '{agentId}');
    if (args?.length) cmd += ` ${args.join(' ')}`;
    return cmd;
  }
  if (stage.script) return `./.har/${stage.script}`;
  return undefined;
}

export class RunService {
  constructor(private readonly executor: StageExecutor = localScriptExecutor) {}

  async runStage(options: StageRunOptions & { trigger?: ExecutionContext['trigger'] }): Promise<StageResult> {
    const activeSession =
      options.agentId !== undefined && options.kind !== 'launch'
        ? readSlotRegistry(resolveHarnessRoot(options.repoPath), options.agentId)
        : undefined;
    const ctx: ExecutionContext = {
      repoPath: options.repoPath,
      capture: options.capture,
      agentId: options.agentId,
      trigger: options.trigger,
      workUnitId: options.workUnitId ?? activeSession?.workUnitId,
      attemptId: options.attemptId ?? activeSession?.attemptId,
    };

    const stageLookup = options.stageId
      ? { id: options.stageId }
      : options.kind
        ? { kind: options.kind }
        : null;
    if (!stageLookup) {
      throw new Error('Provide stageId or kind');
    }

    const stage = resolveStage(options.repoPath, stageLookup);
    if (!stage) {
      const hint = options.stageId
        ? `Stage id "${options.stageId}" not found in .har/stages.json`
        : `No stage with kind "${options.kind}" found in .har/stages.json`;
      throw new Error(hint);
    }

    const run = createRun(ctx, {
      stageId: stage.id,
      kind: stage.kind,
      agentId: options.agentId,
      command: resolveStageCommand(stage, options.agentId, options.args),
    });

    const started = Date.now();
    try {
      const result = await this.executor.runStage(ctx, options);
      const durationMs = Date.now() - started;
      finishRun(options.repoPath, run.runId, {
        status: result.status,
        result,
        durationMs,
      });

      const data =
        typeof result.data === 'object' && result.data !== null && !Array.isArray(result.data)
          ? { ...(result.data as Record<string, unknown>), runId: run.runId }
          : { runId: run.runId };

      return { ...result, data };
    } catch (err: unknown) {
      const durationMs = Date.now() - started;
      finishRun(options.repoPath, run.runId, {
        status: 'error',
        durationMs,
      });
      throw err;
    }
  }

  listArtifacts(options: { repoPath: string; stageId?: string }): ArtifactEntry[] {
    return this.executor.listArtifacts({ repoPath: options.repoPath }, { stageId: options.stageId });
  }

  async preflightEnvironment(options: PreflightOptions): Promise<PreflightResult> {
    const readiness = inspectSlotReadiness(options.repoPath, options.agentId, {});
    const report = formatPreflightReport(options.agentId, readiness);
    return {
      code: readiness.canLaunch ? 0 : 1,
      stdout: report + '\n',
      stderr: readiness.canLaunch ? '' : report + '\n',
      readiness,
      blocked: !readiness.canLaunch,
    };
  }

  async launchEnvironment(options: LaunchOptions): Promise<EnvironmentRunResult> {
    const guard = checkLaunchGuard(options.repoPath, options.agentId, {
      resume: options.resume,
      worktree: options.worktree,
    });
    if (!guard.allowed) {
      const slot = guard.slot;
      return {
        code: 2,
        stdout: '',
        stderr: guard.reason ?? 'Launch blocked: slot is occupied.',
        blocked: true,
        occupiedSlot: slot
          ? {
              agentId: slot.agentId,
              workDir: slot.workDir,
              worktreePath: slot.worktreePath,
              branch: slot.branch,
              dirty: slot.dirty,
              sessionCreatedAt: slot.sessionCreatedAt,
            }
          : undefined,
      };
    }

    // Doctor contract validation runs before every launch (#232) so a broken
    // adaptation is caught here, not mid-session. Pre-1.0 harnesses degrade
    // contract findings to warnings inside runDoctor, so only real breakage
    // (corrupt stages.json, missing stage scripts, phantom ids) blocks.
    const doctor = runDoctor(resolveHarnessRoot(options.repoPath));
    if (!doctor.ok) {
      const errors = doctor.findings
        .filter((f) => f.severity === 'error')
        .map((f) => `${f.file ? `[${f.file}] ` : ''}${f.message}${f.remedy ? `\n  → ${f.remedy}` : ''}`);
      return {
        code: 2,
        stdout: '',
        stderr: `Launch blocked by harness doctor:\n${errors.join('\n')}\nRun \`har env doctor\` for the full report.\n`,
        blocked: true,
      };
    }

    // Readiness warnings are advisory, but a launch that passes the guard is the
    // moment they matter most — they must not be dropped with the guard result.
    let launchBanner = (guard.readiness?.warnings ?? [])
      .map((warning) => `WARN: ${warning}\n`)
      .join('');
    const doctorSummary = summarizeDoctorReport(doctor);
    if (doctorSummary) launchBanner += `WARN: ${doctorSummary}\n`;
    if (isTelemetryEnabled() && process.env.NODE_ENV !== 'test') {
      const ensured = await ensureTelemetryInfrastructure({ startIfNeeded: true });
      if (ensured.message) {
        launchBanner += `${ensured.message}\nUsage from Cursor / Claude / Codex (@osfactory/otel-hook) will appear under Worktrees. Disable: har telemetry off\n`;
      }
      if (ensured.warning) {
        launchBanner += `${ensured.warning}\n`;
      }
      try {
        const { ensureOtelHooks } = await import('./otel-hooks');
        const hooks = ensureOtelHooks({ setupAgents: true });
        if (hooks.message) launchBanner += `${hooks.message}\n`;
        if (hooks.warning) launchBanner += `${hooks.warning}\n`;
      } catch (err) {
        launchBanner += `@osfactory/otel-hook setup skipped: ${err instanceof Error ? err.message : String(err)}\n`;
      }
    }

    const harnessRoot = resolveHarnessRoot(options.repoPath);
    const resumableSession = options.resume
      ? readSlotRegistry(harnessRoot, options.agentId)
      : undefined;
    const workUnitId = options.workUnitId ?? resumableSession?.workUnitId;
    const attemptId = workUnitId
      ? resumableSession?.attemptId ?? crypto.randomUUID()
      : undefined;

    if (workUnitId && attemptId) {
      const conflictingSession = listSlotRegistryEntries(harnessRoot).find(
        (entry) =>
          entry.workUnitId === workUnitId &&
          !(entry.agentId === options.agentId && options.resume),
      );
      if (conflictingSession) {
        return {
          code: 2,
          stdout: '',
          stderr: `Work unit ${workUnitId} is already bound to slot ${conflictingSession.agentId} (attempt ${conflictingSession.attemptId ?? 'unknown'}).`,
          blocked: true,
        };
      }
      upsertWorkUnit(harnessRoot, {
        workUnitId,
        source: options.source,
        sourceUrl: options.sourceUrl,
        title: options.title,
        parentWorkUnitId: options.parentWorkUnitId,
        relatedLinks: options.relatedLinks,
      });
      createWorkAttempt(harnessRoot, {
        attemptId,
        workUnitId,
        agentId: options.agentId,
      });
    }

    const result = await this.runStage({
      repoPath: options.repoPath,
      kind: 'launch',
      agentId: options.agentId,
      workUnitId,
      attemptId,
      capture: options.capture ?? false,
      launchFlags: {
        worktree: options.worktree,
        claude: options.claude,
        resume: options.resume,
        workUnitId,
        attemptId,
      },
      trigger: options.trigger ?? 'cli',
    });
    const envResult = toEnvironmentRunResult(result);
    if (envResult.code === 0) {
      // The session registry written by launch.sh knows where the code lives —
      // surface it so agents make their edits in the right checkout.
      const session = readSlotRegistry(harnessRoot, options.agentId);
      if (session) {
        envResult.workDir = session.workDir;
        envResult.worktreePath = session.worktreePath;
        envResult.branch = session.branch;
        envResult.previewUrls = envResult.previewUrls ?? session.previewUrls;
        envResult.workUnitId = session.workUnitId;
        envResult.attemptId = session.attemptId;

        const sessionKey = buildSessionKey({
          branch: session.branch,
          agentId: options.agentId,
          suffix: session.suffix,
          createdAt: session.createdAt,
        });
        const envFile = path.join(session.workDir, `.env.agent.${options.agentId}`);
        try {
          appendTelemetryEnvToFile(envFile, {
            sessionKey,
            agentId: options.agentId,
            repoPath: path.resolve(options.repoPath),
            workDir: session.workDir,
            branch: session.branch,
            suffix: session.suffix,
            workUnitId: session.workUnitId,
            attemptId: session.attemptId,
          });
        } catch {
          // Env injection is best-effort; launch still succeeded.
        }
        if (session.workUnitId && session.attemptId) {
          createWorkAttempt(harnessRoot, {
            attemptId: session.attemptId,
            workUnitId: session.workUnitId,
            agentId: options.agentId,
            sessionKey,
            workDir: session.workDir,
            worktreePath: session.worktreePath,
            branch: session.branch,
            baseCommit: session.baseCommit,
            createdAt: session.createdAt,
          });
        }
      }
      if (launchBanner) {
        envResult.stderr = `${launchBanner}${envResult.stderr ?? ''}`;
      }
      // Structured copy of the readiness warnings so surfaces can render them
      // without scraping WARN: lines out of stderr.
      if (guard.readiness?.warnings?.length) {
        envResult.warnings = guard.readiness.warnings;
      }
    }
    return envResult;
  }

  async runVerification(options: {
    repoPath: string;
    agentId: number;
    full?: boolean;
    capture?: boolean;
    trigger?: ExecutionContext['trigger'];
  }): Promise<VerificationRunResult> {
    const args = options.full ? ['--full'] : undefined;
    const result = await this.runStage({
      repoPath: options.repoPath,
      kind: 'verify',
      agentId: options.agentId,
      args,
      capture: options.capture ?? true,
      trigger: options.trigger ?? 'cli',
    });
    const shell = extractShellOutput(result);
    let verification: VerificationResult | null = parseVerificationResult(shell.stdout);
    if (
      typeof result.data === 'object' &&
      result.data !== null &&
      !Array.isArray(result.data)
    ) {
      const data = result.data as { verification?: VerificationResult | null };
      if (data.verification !== undefined) {
        verification = data.verification;
      }
    }

    if (verification) {
      try {
        const harnessRoot = resolveHarnessRoot(options.repoPath);
        const session = readSlotRegistry(harnessRoot, options.agentId);
        const checkoutDir = resolveValidationCheckoutDir({
          worktreePath: session?.worktreePath,
          workDir: resolveAgentWorkDir(harnessRoot, options.agentId),
          harnessRoot,
        });
        const runId =
          typeof result.data === 'object' && result.data !== null && !Array.isArray(result.data)
            ? (result.data as { runId?: string }).runId
            : undefined;
        const validation = recordValidation({
          checkoutDir,
          harnessRoot,
          status: verification.status,
          full: options.full ?? false,
          runId,
          agentId: options.agentId,
        });
        if (session?.workUnitId && session.attemptId) {
          bindValidationToAttempt(harnessRoot, {
            workUnitId: session.workUnitId,
            attemptId: session.attemptId,
            validation,
          });
        }
        return {
          code: shell.code,
          stdout: shell.stdout,
          stderr: shell.stderr,
          verification,
          validation,
        };
      } catch {
        // hashing must never fail the verify (e.g. not a git checkout)
      }
    }

    return {
      code: shell.code,
      stdout: shell.stdout,
      stderr: shell.stderr,
      verification,
    };
  }

  async teardownEnvironment(options: {
    repoPath: string;
    agentId: number;
    deleteBranch?: boolean;
    capture?: boolean;
    trigger?: ExecutionContext['trigger'];
  }): Promise<EnvironmentRunResult> {
    // Captured before teardown clears the slot registry — the attempt binding
    // is gone afterwards.
    const harnessRoot = resolveHarnessRoot(options.repoPath);
    const session = readSlotRegistry(harnessRoot, options.agentId);

    const result = await this.runStage({
      repoPath: options.repoPath,
      kind: 'teardown',
      agentId: options.agentId,
      args: options.deleteBranch ? ['--delete-branch'] : undefined,
      capture: options.capture ?? false,
      trigger: options.trigger ?? 'cli',
    });
    const envResult = toEnvironmentRunResult(result);

    // Teardown is the only exit besides `complete`; close the open attempt so
    // work units don't linger as in-flight forever. `complete` records its
    // 'completed' outcome before tearing down, so an existing outcome wins.
    if (envResult.code === 0 && session?.workUnitId) {
      try {
        const workUnit = findWorkUnit(harnessRoot, session.workUnitId);
        if (workUnit && !workUnit.outcome) {
          decideWorkUnitOutcome(harnessRoot, session.workUnitId, {
            decision: 'abandoned',
            decidedAt: new Date().toISOString(),
            attemptId: session.attemptId,
            reason: 'Session torn down without completion.',
          });
        }
      } catch {
        // Outcome bookkeeping must not fail an otherwise successful teardown.
      }
    }
    return envResult;
  }

  /**
   * Finish a session: full verification (recorded as a validation keyed by the
   * worktree tree hash), then teardown. The session branch is kept so the user
   * can push it and open a PR.
   */
  async completeEnvironment(options: {
    repoPath: string;
    agentId: number;
    skipVerify?: boolean;
    capture?: boolean;
    trigger?: ExecutionContext['trigger'];
  }): Promise<EnvironmentRunResult & { verification?: VerificationResult | null }> {
    const harnessRoot = resolveHarnessRoot(options.repoPath);
    const session = readSlotRegistry(harnessRoot, options.agentId);
    if (!session) {
      return {
        code: 1,
        stdout: '',
        stderr: `No active session for agent ${options.agentId}. Run launch first.`,
      };
    }

    let verification: VerificationResult | null | undefined;
    let validation: import('../harness/schema').ValidationRecord | undefined;
    if (!options.skipVerify) {
      const verify = await this.runVerification({
        repoPath: options.repoPath,
        agentId: options.agentId,
        full: true,
        capture: options.capture ?? true,
        trigger: options.trigger,
      });
      verification = verify.verification;
      validation = verify.validation;
      if (verify.code !== 0 || verification?.status !== 'pass') {
        return {
          ...verify,
          stderr:
            verify.stderr +
            '\nVerification failed — session NOT completed. Fix the failures and rerun, or complete with skipVerify.',
        };
      }
    }

    if (
      session.workUnitId &&
      session.attemptId &&
      !options.skipVerify &&
      !validation
    ) {
      return {
        code: 1,
        stdout: '',
        stderr:
          'Full verification passed, but HAR could not record exact-tree validation proof. Session NOT completed.',
        verification,
      };
    }

    if (session.workUnitId && session.attemptId && validation) {
      decideWorkUnitOutcome(harnessRoot, session.workUnitId, {
        decision: 'completed',
        decidedAt: new Date().toISOString(),
        attemptId: session.attemptId,
        validationId: validation.validationId,
        treeHash: validation.treeHash,
      });
    }

    const teardown = await this.teardownEnvironment({
      repoPath: options.repoPath,
      agentId: options.agentId,
      capture: options.capture ?? true,
      trigger: options.trigger,
    });
    if (teardown.code !== 0) return { ...teardown, verification };

    const branchNote = session.branch
      ? `Branch kept: ${session.branch} — push it with: git push -u origin ${session.branch}\n`
      : '';
    return {
      ...teardown,
      stdout: teardown.stdout + branchNote,
      branch: session.branch,
      workDir: session.workDir,
      worktreePath: session.worktreePath,
      verification,
    };
  }

  /**
   * Status is a pure read with one implementation: the structured collector is
   * the source, text is rendered on top. No run records are written on any
   * surface (CLI text, CLI --json, MCP) — the policy is identical by design.
   */
  async getEnvironmentStatus(options: {
    repoPath: string;
    agentId?: number;
    capture?: boolean;
    trigger?: ExecutionContext['trigger'];
  }): Promise<EnvironmentStatusRunResult> {
    if (options.agentId !== undefined) {
      validateAgentId(options.agentId, options.repoPath);
    }

    const full = collectEnvironmentStatus(options.repoPath);
    const status =
      options.agentId !== undefined
        ? { ...full, slots: full.slots.filter((slot) => slot.agentId === options.agentId) }
        : full;

    return {
      code: 0,
      stdout: renderEnvironmentStatusText(status),
      stderr: '',
      status,
    };
  }

  async getEnvironmentLogs(options: LogsOptions & { trigger?: ExecutionContext['trigger'] }): Promise<EnvironmentRunResult> {
    validateAgentId(options.agentId, options.repoPath);
    const args = options.service ? [options.service] : undefined;
    const result = await this.runStage({
      repoPath: options.repoPath,
      stageId: 'logs',
      agentId: options.agentId,
      args,
      capture: true,
      trigger: options.trigger ?? 'cli',
    });
    return toEnvironmentRunResult(result);
  }
}

const defaultRunService = new RunService();

export function createRunService(executor: StageExecutor = localScriptExecutor): RunService {
  return new RunService(executor);
}

export const runStage = defaultRunService.runStage.bind(defaultRunService);
export const listArtifacts = defaultRunService.listArtifacts.bind(defaultRunService);
export const launchEnvironment = defaultRunService.launchEnvironment.bind(defaultRunService);
export const preflightEnvironment = defaultRunService.preflightEnvironment.bind(defaultRunService);
export const runVerification = defaultRunService.runVerification.bind(defaultRunService);
export const teardownEnvironment = defaultRunService.teardownEnvironment.bind(defaultRunService);
export const completeEnvironment = defaultRunService.completeEnvironment.bind(defaultRunService);
export const getEnvironmentStatus = defaultRunService.getEnvironmentStatus.bind(defaultRunService);
export const getEnvironmentLogs = defaultRunService.getEnvironmentLogs.bind(defaultRunService);

export { computePreviewUrls, readHarnessEnv } from './local-executor';

export type {
  ArtifactEntry,
  EnvironmentRunResult,
  EnvironmentStatusRunResult,
  LaunchOptions,
  LogsOptions,
  PreflightOptions,
  PreflightResult,
  StageRunOptions,
  VerificationRunResult,
} from './types';
