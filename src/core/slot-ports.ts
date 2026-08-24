import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { readHarnessEnv } from '../harness/env';
import { resolveHarnessRoot } from '../harness/manifest';
import { parseHarnessEnvSource } from '../harness/schema';

export interface AllocatedAppPorts {
  frontend: number;
  api: number;
  debug: number;
  /** True when any port differed from the configured default for this slot. */
  allocated: boolean;
}

export interface PortAllocationError {
  error: string;
  /** Which lane was exhausted. */
  lane: 'frontend' | 'api' | 'debug';
  /** The scanned range — lets callers reproduce the bash message format. */
  range: { start: number; end: number };
}

/**
 * Persisted infra host ports from .har/state/infra.env (written by setup-infra.sh).
 * Mirrors bash har_load_infra_state: when the state file is absent under
 * harnessRoot (e.g. launching from a session worktree), fall back to the main
 * checkout resolved through `git rev-parse --git-common-dir`.
 */
export function loadInfraState(
  harnessRoot: string,
  repoRoot?: string,
): Record<string, string> {
  let statePath = path.join(harnessRoot, '.har', 'state', 'infra.env');
  if (!fs.existsSync(statePath) && repoRoot) {
    try {
      const commonDir = execSync('git rev-parse --git-common-dir', {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      if (commonDir) {
        statePath = path.join(
          path.dirname(path.resolve(repoRoot, commonDir)),
          '.har',
          'state',
          'infra.env',
        );
      }
    } catch {
      /* not a git checkout — keep the harnessRoot path */
    }
  }
  if (!fs.existsSync(statePath)) return {};
  return parseHarnessEnvSource(fs.readFileSync(statePath, 'utf8')).values;
}

export function portStep(env: Record<string, string>): number {
  return Number(env.HARNESS_PORT_STEP ?? 10);
}

export function defaultAppPort(base: number, agentId: number, step: number): number {
  return base + agentId * step;
}

export function slotPortLaneEnd(defaultPort: number, step: number): number {
  return defaultPort + step - 1;
}

/** Returns true when something is listening on the host port (TCP connect probe). */
export function isPortInUse(port: number, host = '127.0.0.1'): boolean {
  try {
    execSync(`bash -c 'exec 3<>/dev/tcp/${host}/${port}'`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function pickFreePort(start: number, end: number): number | undefined {
  for (let port = start; port <= end; port++) {
    if (!isPortInUse(port)) return port;
  }
  return undefined;
}

export function allocatePort(
  defaultPort: number,
  scanStart: number,
  scanEnd: number,
): number | undefined {
  if (!isPortInUse(defaultPort)) return defaultPort;
  return pickFreePort(scanStart, scanEnd);
}

export function allocateAppPorts(
  repoPath: string,
  agentId: number,
): AllocatedAppPorts | PortAllocationError {
  const harnessRoot = resolveHarnessRoot(repoPath);
  const env = readHarnessEnv(harnessRoot);
  const step = portStep(env);
  const feDefault = defaultAppPort(Number(env.HARNESS_FE_BASE_PORT ?? 3000), agentId, step);
  const apiDefault = defaultAppPort(Number(env.HARNESS_API_BASE_PORT ?? 8000), agentId, step);
  const debugDefault = 9200 + agentId * step;

  const frontend = allocatePort(feDefault, feDefault, slotPortLaneEnd(feDefault, step));
  const api = allocatePort(apiDefault, apiDefault, slotPortLaneEnd(apiDefault, step));
  const debug = allocatePort(debugDefault, debugDefault, debugDefault + step - 1);

  if (frontend === undefined) {
    return {
      error: `No free frontend port in range ${feDefault}-${slotPortLaneEnd(feDefault, step)}`,
      lane: 'frontend',
      range: { start: feDefault, end: slotPortLaneEnd(feDefault, step) },
    };
  }
  if (api === undefined) {
    return {
      error: `No free API port in range ${apiDefault}-${slotPortLaneEnd(apiDefault, step)}`,
      lane: 'api',
      range: { start: apiDefault, end: slotPortLaneEnd(apiDefault, step) },
    };
  }
  if (debug === undefined) {
    return {
      error: `No free debug port in range ${debugDefault}-${debugDefault + step - 1}`,
      lane: 'debug',
      range: { start: debugDefault, end: debugDefault + step - 1 },
    };
  }

  return {
    frontend,
    api,
    debug,
    allocated: frontend !== feDefault || api !== apiDefault || debug !== debugDefault,
  };
}

/** @deprecated Import from `../harness/capabilities` — re-exported for compatibility. */
export { harnessUsesPm2 } from '../harness/capabilities';
