import * as path from 'path';
import { readHarnessEnv } from '../harness/env';
import { resolveHarnessRoot } from '../harness/manifest';
import type { SlotReadiness } from '../harness/schema';
import {
  controlContainerOnPort,
  controlDefaultPortWarnings,
  formatControlPortBlocker,
  listDockerContainers,
  dockerOnPort,
  type DockerRow,
} from './control-port';
import { checkLaunchGuard as checkOccupiedSlotGuard } from './slot-launch-guard-occupied';
import type { LaunchGuardOptions } from './slot-launch-guard-occupied';
import {
  allocateAppPorts,
  harnessUsesPm2,
  isPortInUse,
  pickFreePort,
  portStep,
  defaultAppPort,
  slotPortLaneEnd,
} from './slot-ports';
import { harnessAllocatesAppPorts } from '../harness/capabilities';
import { readSlotRegistry, isSlotResumable } from './slot-registry';
import {
  formatUntrackedWorktreeWarning,
  listUntrackedAbsentFromWorktree,
  worktreeCheckEnabled,
} from './worktree-untracked';
import { execSync } from 'child_process';
import { packageRunner } from '../utils/package-runner';

export interface PreflightOptions extends LaunchGuardOptions {
  allocatePorts?: boolean;
  /**
   * Whether this harness runs per-slot PM2 app processes. Defaults to the
   * file-presence check (ecosystem.agent.template.cjs) — #236 will supply this
   * from the profile capability manifest instead.
   */
  usesPm2?: boolean;
  /**
   * Precomputed occupied state — pass from collectSlotStatus to avoid recursion
   * through collectEnvironmentStatus.
   */
  occupied?: { active: boolean; dirty?: boolean };
  /** Test hook: override docker ps results. */
  dockerContainers?: DockerRow[];
  /** Test hook: override PM2 process list (pass [] to skip live pm2 jlist). */
  pm2Processes?: Pm2Process[];
  /** Test hook: override the untracked-path scan (pass [] to skip the git call). */
  untrackedPaths?: string[];
  /** False for a `--no-worktree` launch — the slot runs in the repo root. */
  worktree?: boolean;
}

interface Pm2Process {
  name?: string;
  pm2_env?: { pm_cwd?: string; cwd?: string; status?: string };
}

function listPm2Processes(): Pm2Process[] | undefined {
  try {
    const raw = execSync(`${packageRunner()} pm2 jlist`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 3000,
    });
    const procs = JSON.parse(raw) as Pm2Process[];
    return Array.isArray(procs) ? procs : undefined;
  } catch {
    return undefined;
  }
}

function detectForeignPm2(
  projectName: string,
  agentId: number,
  procs: Pm2Process[] | undefined,
): { processes: Array<{ name: string; cwd?: string }> } | undefined {
  if (!procs) return undefined;

  const slotPrefix = `har-${projectName}-agent-${agentId}-`;
  const legacyPrefix = `agent-${agentId}-`;
  const foreign = procs.filter(
    (p) =>
      p.name &&
      ((p.name.startsWith('har-') &&
        p.name.includes(`-agent-${agentId}-`) &&
        !p.name.startsWith(slotPrefix)) ||
        (p.name.startsWith(legacyPrefix) && !p.name.startsWith('har-'))),
  );

  if (foreign.length === 0) return undefined;
  return {
    processes: foreign.map((p) => ({
      name: p.name!,
      cwd: p.pm2_env?.pm_cwd ?? p.pm2_env?.cwd,
    })),
  };
}

function infraEnabled(env: Record<string, string>, service: string): boolean {
  return ` ${env.HARNESS_INFRA_SERVICES ?? ''} `.includes(` ${service} `);
}

function checkInfraPort(
  env: Record<string, string>,
  varName: string,
  defaultPort: number,
  scanStart: number,
  scanEnd: number,
): { port?: number; error?: string } {
  const current = env[varName] ? Number(env[varName]) : undefined;
  if (current !== undefined && !isPortInUse(current)) {
    return { port: current };
  }
  if (current !== undefined && isPortInUse(current)) {
    const alt = pickFreePort(scanStart, scanEnd);
    if (alt !== undefined) return { port: alt };
    return { error: `No free ${varName} port in range ${scanStart}-${scanEnd}` };
  }
  const port = pickFreePort(defaultPort, scanEnd) ?? pickFreePort(scanStart, scanEnd);
  if (port === undefined) {
    return { error: `No free ${varName} port in range ${scanStart}-${scanEnd}` };
  }
  return { port };
}

/**
 * Repo-wide untracked-path scan. Identical for every slot — callers inspecting
 * several slots should call this once and pass the result back through
 * `PreflightOptions.untrackedPaths`.
 */
export function scanUntrackedWorktreePaths(
  repoPath: string,
  env: Record<string, string>,
): string[] {
  if (!worktreeCheckEnabled(env, undefined)) return [];
  return listUntrackedAbsentFromWorktree(repoPath);
}

/**
 * Readiness gate for launch: machine/slot checks with an explicit verdict.
 * Shared by `har env preflight`, `har env status --json` (readiness block), and launch guard.
 */
export function inspectSlotReadiness(
  repoPath: string,
  agentId: number,
  options: PreflightOptions = {},
): SlotReadiness {
  const harnessRoot = resolveHarnessRoot(repoPath);
  const env = readHarnessEnv(harnessRoot);
  const projectName = env.HARNESS_PROJECT_NAME ?? path.basename(harnessRoot);
  const usesPm2 = options.usesPm2 ?? harnessUsesPm2(repoPath);
  const blockers: SlotReadiness['blockers'] = [];
  const remediations: string[] = [];
  const warnings: string[] = [];
  const ports: Record<string, number> = {};
  const session = readSlotRegistry(harnessRoot, agentId);

  const guard =
    options.occupied !== undefined
      ? options.occupied.active
        ? options.resume && isSlotResumable(session)
          ? { allowed: true }
          : {
              allowed: false,
              blocked: true,
              reason: `Slot ${agentId} is already in use.`,
            }
        : { allowed: true }
      : checkOccupiedSlotGuard(repoPath, agentId, options);
  if (!guard.allowed) {
    const resumable = isSlotResumable(session);
    blockers.push({
      code: options.occupied?.dirty ? 'slot_dirty' : resumable ? 'slot_resumable' : 'slot_occupied',
      message: guard.reason ?? `Slot ${agentId} is occupied.`,
      remediation: resumable
        ? `Resume the partial launch: har env launch ${agentId} --resume (or har env recover ${agentId})`
        : `Free the slot: har env teardown ${agentId} (or complete ${agentId}), then har env launch ${agentId}.`,
    });
    remediations.push(
      resumable
        ? `har env launch ${agentId} --resume`
        : `har env teardown ${agentId}`,
    );
  }

  const pm2Procs = usesPm2
    ? options.pm2Processes !== undefined
      ? options.pm2Processes
      : listPm2Processes()
    : undefined;
  const foreign = usesPm2 ? detectForeignPm2(projectName, agentId, pm2Procs) : undefined;
  if (foreign) {
    const names = foreign.processes.map((p) => p.name).join(', ');
    blockers.push({
      code: 'foreign_pm2',
      message: `Foreign PM2 processes match agent ${agentId}: ${names}`,
      remediation:
        'Stop the other harness session (`har env teardown` in that repo) or use a different agent slot.',
      details: { processes: foreign.processes },
    });
    remediations.push(`Inspect with: ${packageRunner()} pm2 jlist | grep agent-${agentId}`);
  }

  if (usesPm2 && pm2Procs) {
    const slotPrefix = `har-${projectName}-agent-${agentId}-`;
    const owned = pm2Procs.filter((p) => p.name?.startsWith(slotPrefix));
    if (owned.length > 0 && !session) {
      blockers.push({
        code: 'registry_missing',
        message: `PM2 processes exist for ${projectName} agent ${agentId} but the slot registry is missing.`,
        remediation: 'Run teardown in this harness or delete PM2 processes manually, then relaunch.',
      });
    }
    if (owned.length > 0 && session?.projectName && session.projectName !== projectName) {
      blockers.push({
        code: 'project_mismatch',
        message: `Slot registry projectName=${session.projectName} does not match harness ${projectName}.`,
        remediation: 'Teardown the stale session, then relaunch.',
      });
    }
  }

  let allocatedPorts = false;
  let portChoiceExplained = false;
  if (usesPm2 && (options.allocatePorts ?? true)) {
    const alloc = allocateAppPorts(repoPath, agentId);
    if ('error' in alloc) {
      blockers.push({
        code: 'ports_exhausted',
        message: alloc.error,
        remediation: 'Free a port in the slot lane or stop the process/container using it.',
        details: { lane: alloc.lane, range: alloc.range },
      });
    } else {
      ports.frontend = alloc.frontend;
      ports.api = alloc.api;
      ports.debug = alloc.debug;
      allocatedPorts = alloc.allocated;

      const containers = options.dockerContainers ?? listDockerContainers();
      const feDefault = defaultAppPort(
        Number(env.HARNESS_FE_BASE_PORT ?? 3000),
        agentId,
        portStep(env),
      );
      const portWarnings = controlDefaultPortWarnings(containers, feDefault, alloc.frontend);
      portChoiceExplained = portWarnings.length > 0;
      warnings.push(...portWarnings);

      for (const [label, port] of Object.entries({ frontend: alloc.frontend, api: alloc.api })) {
        const control = controlContainerOnPort(containers, port);
        if (control) {
          blockers.push({
            code: 'control_port_conflict',
            message: formatControlPortBlocker(control.name, port, label),
            remediation: 'Run: har control down — or launch a different slot id.',
            details: { container: control.name, port, label },
          });
          remediations.push('har control down');
        } else {
          const occupant = dockerOnPort(containers, port);
          if (occupant && !occupant.name.startsWith(`har-${projectName}-`)) {
            blockers.push({
              code: 'docker_port_conflict',
              message: `Docker container "${occupant.name}" binds port ${port} (${label}).`,
              remediation: `Stop the container: docker stop ${occupant.name}`,
              details: { container: occupant.name, port, label },
            });
          }
        }
      }
    }
  }

  if (infraEnabled(env, 'db')) {
    const dbDefault = Number(env.HARNESS_DB_PORT_DEFAULT ?? 15432);
    const dbStart = Number(env.HARNESS_DB_PORT_SCAN_START ?? dbDefault);
    const dbEnd = Number(env.HARNESS_DB_PORT_SCAN_END ?? dbDefault + 67);
    const dbCheck = checkInfraPort(env, 'AGENT_DB_PORT', dbDefault, dbStart, dbEnd);
    if (dbCheck.error) {
      blockers.push({
        code: 'db_port_exhausted',
        message: dbCheck.error,
        remediation: `Free a port in ${dbStart}-${dbEnd} or stop har-*-db-1 containers from other projects.`,
      });
    } else if (dbCheck.port !== undefined) {
      ports.db = dbCheck.port;
      const occupant = dockerOnPort(
        options.dockerContainers ?? listDockerContainers(),
        dbCheck.port,
      );
      if (
        occupant &&
        !occupant.name.startsWith(`har-${projectName}-`) &&
        !occupant.name.includes('-db-')
      ) {
        blockers.push({
          code: 'db_port_conflict',
          message: `Port ${dbCheck.port} (database) is held by "${occupant.name}".`,
          remediation: `Stop the container or pick another slot.`,
          details: { container: occupant.name, port: dbCheck.port },
        });
      }
    }
  }

  if (worktreeCheckEnabled(env, options.worktree)) {
    const untracked =
      options.untrackedPaths ?? scanUntrackedWorktreePaths(repoPath, env);
    const untrackedWarning = formatUntrackedWorktreeWarning(untracked);
    if (untrackedWarning) warnings.push(untrackedWarning);
  }

  const canLaunch = blockers.length === 0;
  return {
    canLaunch,
    verdict: canLaunch ? 'ready' : 'blocked',
    blockers,
    remediations: [...new Set(remediations)],
    ports: Object.keys(ports).length > 0 ? ports : undefined,
    allocatedPorts: allocatedPorts || undefined,
    portChoiceExplained: portChoiceExplained || undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export function formatPreflightReport(agentId: number, readiness: SlotReadiness): string {
  const lines: string[] = [];
  if (readiness.canLaunch) {
    lines.push(`Slot ${agentId}: ready to launch.`);
    if (readiness.ports) {
      const p = readiness.ports;
      const parts = [
        p.frontend !== undefined ? `frontend=${p.frontend}` : undefined,
        p.api !== undefined ? `api=${p.api}` : undefined,
        p.debug !== undefined ? `debug=${p.debug}` : undefined,
        p.db !== undefined ? `db=${p.db}` : undefined,
      ].filter(Boolean);
      if (parts.length) lines.push(`  Ports: ${parts.join(' ')}`);
      // Skip the generic note only when a warning already explains the chosen port.
      if (readiness.allocatedPorts && !readiness.portChoiceExplained) {
        lines.push('  (alternate ports selected — defaults were busy)');
      }
    }
    if (readiness.warnings?.length) {
      for (const w of readiness.warnings) {
        lines.push(`  WARN: ${w}`);
      }
    }
    return lines.join('\n');
  }

  lines.push(`Slot ${agentId}: launch blocked.`);
  for (const b of readiness.blockers) {
    lines.push(`  [${b.code}] ${b.message}`);
    if (b.remediation) lines.push(`    → ${b.remediation}`);
  }
  // Warnings are independent of the verdict — a blocked slot must not hide them.
  for (const w of readiness.warnings ?? []) {
    lines.push(`  WARN: ${w}`);
  }
  return lines.join('\n');
}

/** Whether this harness expects per-slot app ports (capability-based, not profile enum). */
export function harnessExpectsAppPorts(repoPath: string): boolean {
  return harnessAllocatesAppPorts(repoPath);
}

// ── Launch preflight (bash har_launch_preflight parity, #234) ─────────────────

export type LaunchPreflightStatus = 'ok' | 'occupied' | 'blocked';

export interface LaunchPreflightResult {
  status: LaunchPreflightStatus;
  /** Bash-parity exit code: 0 ready, 2 occupied / not resumable, 1 machine blockers. */
  exitCode: 0 | 1 | 2;
  readiness: SlotReadiness;
  /** Allocated app ports — only when the harness runs per-slot PM2 processes. */
  ports?: { frontend: number; api: number; debug: number };
  /** stderr-parity error lines, in the order bash would print them. */
  errors: string[];
  /** Non-blocking warning lines (untracked paths, control default port, …). */
  warnings: string[];
  /** Informational lines (e.g. the resume banner). */
  notes: string[];
}

function bashBlockerLines(agentId: number, b: SlotReadiness['blockers'][number]): string[] {
  const details = (b.details ?? {}) as Record<string, unknown>;
  switch (b.code) {
    case 'foreign_pm2': {
      const procs = (details.processes ?? []) as Array<{ name: string; cwd?: string }>;
      return [
        `ERROR: foreign PM2 processes match agent ${agentId}:`,
        ...procs.map((p) => `  ${p.name}  cwd=${p.cwd ?? 'unknown'}`),
        '  Stop the other harness session or use a different slot.',
      ];
    }
    case 'control_port_conflict':
      return [
        `ERROR: har control up (container "${details.container}") occupies port ${details.port}.`,
        '  Run: har control down — or use a different agent slot.',
      ];
    case 'docker_port_conflict':
      return [
        `ERROR: Docker container "${details.container}" binds port ${details.port}.`,
        `  Stop it with: docker stop ${details.container}`,
      ];
    case 'ports_exhausted': {
      const range = details.range as { start: number; end: number } | undefined;
      if (range) return [`Error: no free port in range ${range.start}-${range.end}`];
      return [b.message];
    }
    default:
      return [b.message, ...(b.remediation ? [`  ${b.remediation}`] : [])];
  }
}

export interface LaunchPreflightOptions extends PreflightOptions {
  repoPath: string;
  agentId: number;
}

/**
 * Single package-side entry point for the pre-launch readiness gate — the TS
 * replacement for bash har_launch_preflight. Occupied / not-resumable slots
 * short-circuit with exit code 2 (bash parity: no PM2 or port checks run);
 * machine blockers map to exit code 1 with bash-format error lines.
 */
export function runLaunchPreflight(options: LaunchPreflightOptions): LaunchPreflightResult {
  const { repoPath, agentId, ...preflightOptions } = options;
  const harnessRoot = resolveHarnessRoot(repoPath);
  const session = readSlotRegistry(harnessRoot, agentId);
  const notes: string[] = [];

  if (options.resume) {
    if (!isSlotResumable(session)) {
      const status = session?.status ?? 'none';
      const errors = [
        `ERROR: slot ${agentId} is not resumable (status=${status}; need failed or starting).`,
        `  Free the slot first: har env teardown ${agentId} (or complete ${agentId}), then har env launch ${agentId}.`,
      ];
      return {
        status: 'occupied',
        exitCode: 2,
        readiness: {
          canLaunch: false,
          verdict: 'blocked',
          blockers: [
            {
              code: 'slot_not_resumable',
              message: errors[0],
              remediation: `har env teardown ${agentId} (or complete ${agentId}), then har env launch ${agentId}.`,
            },
          ],
          remediations: [`har env teardown ${agentId}`],
        },
        errors,
        warnings: [],
        notes,
      };
    }
    notes.push(`==> [agent-${agentId}] Resuming partial launch (worktree and deps preserved)...`);
  }

  const readiness = inspectSlotReadiness(repoPath, agentId, preflightOptions);
  const warnings = [...(readiness.warnings ?? [])];

  const occupiedBlocker = readiness.blockers.find(
    (b) => b.code === 'slot_occupied' || b.code === 'slot_dirty' || b.code === 'slot_resumable',
  );
  if (occupiedBlocker && !options.resume) {
    // Bash parity: an occupied slot returns before PM2/port checks are reported.
    return {
      status: 'occupied',
      exitCode: 2,
      readiness,
      errors: [
        `ERROR: slot ${agentId} is occupied.`,
        `  Free it first: har env teardown ${agentId} (or complete ${agentId}), then har env launch ${agentId}.`,
      ],
      warnings,
      notes,
    };
  }

  const machineBlockers = readiness.blockers.filter((b) => b !== occupiedBlocker);
  if (machineBlockers.length > 0) {
    return {
      status: 'blocked',
      exitCode: 1,
      readiness,
      errors: machineBlockers.flatMap((b) => bashBlockerLines(agentId, b)),
      warnings,
      notes,
    };
  }

  const ports =
    readiness.ports?.frontend !== undefined &&
    readiness.ports?.api !== undefined &&
    readiness.ports?.debug !== undefined
      ? {
          frontend: readiness.ports.frontend,
          api: readiness.ports.api,
          debug: readiness.ports.debug,
        }
      : undefined;

  return { status: 'ok', exitCode: 0, readiness, ports, errors: [], warnings, notes };
}

export { defaultAppPort, portStep, slotPortLaneEnd };
