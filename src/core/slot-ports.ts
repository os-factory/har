import { execSync } from 'child_process';
import { readHarnessEnv } from '../harness/env';
import { resolveHarnessRoot } from '../harness/manifest';

export interface AllocatedAppPorts {
  frontend: number;
  api: number;
  debug: number;
  /** True when any port differed from the configured default for this slot. */
  allocated: boolean;
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
): AllocatedAppPorts | { error: string } {
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
    return { error: `No free frontend port in range ${feDefault}-${slotPortLaneEnd(feDefault, step)}` };
  }
  if (api === undefined) {
    return { error: `No free API port in range ${apiDefault}-${slotPortLaneEnd(apiDefault, step)}` };
  }
  if (debug === undefined) {
    return { error: `No free debug port in range ${debugDefault}-${debugDefault + step - 1}` };
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
