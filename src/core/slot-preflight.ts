import { execSync } from 'child_process';
import * as path from 'path';
import { readHarnessEnv } from '../harness/env';
import { resolveHarnessRoot } from '../harness/manifest';
import type { SlotReadiness } from '../harness/schema';
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
import { readSlotRegistry } from './slot-registry';

export interface PreflightOptions extends LaunchGuardOptions {
  /** When true, include port allocation in the result (default true for PM2 harnesses). */
  allocatePorts?: boolean;
  /**
   * Precomputed occupied state — pass from collectSlotStatus to avoid recursion
   * through collectEnvironmentStatus.
   */
  occupied?: { active: boolean; dirty?: boolean };
}

interface Pm2Process {
  name?: string;
  pm2_env?: { pm_cwd?: string; cwd?: string; status?: string };
}

interface DockerRow {
  name: string;
  ports: string;
}

function listPm2Processes(): Pm2Process[] | undefined {
  try {
    const raw = execSync('npx --yes pm2 jlist', {
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

function listDockerContainers(): DockerRow[] {
  try {
    const raw = execSync('docker ps --format {{.Names}}\\t{{.Ports}}', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 3000,
    });
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t');
        if (tab === -1) return { name: line, ports: '' };
        return { name: line.slice(0, tab), ports: line.slice(tab + 1) };
      });
  } catch {
    return [];
  }
}

function dockerOnPort(containers: DockerRow[], port: number): DockerRow | undefined {
  const re = new RegExp(`:${port}->|:${port}/`);
  return containers.find((c) => re.test(c.ports));
}

function controlContainerOnPort(containers: DockerRow[], port: number): DockerRow | undefined {
  return containers.find(
    (c) =>
      /control/i.test(c.name) &&
      (new RegExp(`:${port}->|:${port}/`).test(c.ports) || c.ports.includes(`0.0.0.0:${port}`)),
  );
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
  const usesPm2 = harnessUsesPm2(repoPath);
  const blockers: SlotReadiness['blockers'] = [];
  const remediations: string[] = [];
  const ports: Record<string, number> = {};

  const guard =
    options.occupied !== undefined
      ? options.occupied.active
        ? !options.confirmReplace
          ? {
              allowed: false,
              blocked: true,
              reason: `Slot ${agentId} is already in use.`,
            }
          : options.occupied.dirty && !options.force
            ? {
                allowed: false,
                blocked: true,
                reason: `Slot ${agentId} worktree has uncommitted changes.`,
              }
            : { allowed: true }
        : { allowed: true }
      : checkOccupiedSlotGuard(repoPath, agentId, options);
  if (!guard.allowed) {
    blockers.push({
      code: options.occupied?.dirty ? 'slot_dirty' : 'slot_occupied',
      message: guard.reason ?? `Slot ${agentId} is occupied.`,
      remediation: guard.slot?.dirty
        ? 'Commit changes in the worktree, or pass --force after explicit user approval.'
        : 'Pass --replace (CLI), confirmReplace=true (MCP), or answer y at the launch prompt.',
    });
    remediations.push(
      guard.slot?.dirty
        ? 'har env preflight <id> --replace --force'
        : 'har env preflight <id> --replace',
    );
  }

  const pm2Procs = usesPm2 ? listPm2Processes() : undefined;
  const foreign = usesPm2 ? detectForeignPm2(projectName, agentId, pm2Procs) : undefined;
  if (foreign) {
    const names = foreign.processes.map((p) => p.name).join(', ');
    blockers.push({
      code: 'foreign_pm2',
      message: `Foreign PM2 processes match agent ${agentId}: ${names}`,
      remediation:
        'Stop the other harness session (./.har/teardown.sh in that repo) or use a different agent slot.',
      details: { processes: foreign.processes },
    });
    remediations.push('Inspect with: npx pm2 jlist | grep agent-' + agentId);
  }

  const session = readSlotRegistry(harnessRoot, agentId);
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
        remediation: 'Teardown the stale session and relaunch with --replace.',
      });
    }
  }

  let allocatedPorts = false;
  if (usesPm2 && (options.allocatePorts ?? true)) {
    const alloc = allocateAppPorts(repoPath, agentId);
    if ('error' in alloc) {
      blockers.push({
        code: 'ports_exhausted',
        message: alloc.error,
        remediation: 'Free a port in the slot lane or stop the process/container using it.',
      });
    } else {
      ports.frontend = alloc.frontend;
      ports.api = alloc.api;
      ports.debug = alloc.debug;
      allocatedPorts = alloc.allocated;

      const containers = listDockerContainers();
      for (const [label, port] of Object.entries({ frontend: alloc.frontend, api: alloc.api })) {
        const control = controlContainerOnPort(containers, port);
        if (control) {
          blockers.push({
            code: 'control_port_conflict',
            message: `Mission Control container "${control.name}" occupies port ${port} (${label}).`,
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
      const occupant = dockerOnPort(listDockerContainers(), dbCheck.port);
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

  const canLaunch = blockers.length === 0;
  return {
    canLaunch,
    verdict: canLaunch ? 'ready' : 'blocked',
    blockers,
    remediations: [...new Set(remediations)],
    ports: Object.keys(ports).length > 0 ? ports : undefined,
    allocatedPorts: allocatedPorts || undefined,
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
      if (readiness.allocatedPorts) {
        lines.push('  (alternate ports selected — defaults were busy)');
      }
    }
    return lines.join('\n');
  }

  lines.push(`Slot ${agentId}: launch blocked.`);
  for (const b of readiness.blockers) {
    lines.push(`  [${b.code}] ${b.message}`);
    if (b.remediation) lines.push(`    → ${b.remediation}`);
  }
  return lines.join('\n');
}

/** Whether this harness expects per-slot app ports (PM2 / web profile). */
export function harnessExpectsAppPorts(repoPath: string): boolean {
  return harnessUsesPm2(repoPath);
}

export { defaultAppPort, portStep, slotPortLaneEnd };
