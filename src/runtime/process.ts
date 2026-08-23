import * as fs from 'fs';
import * as path from 'path';
import { defaultExec, ExecFn, LogFn, SleepFn, realSleep } from './exec';

/**
 * Package-side PM2 process runtime (#234) — the TS home of launch.sh's
 * ecosystem generation / process start / health check and teardown.sh's pm2
 * cleanup. Naming formulas and log lines are byte-compatible with the scripts.
 */

// ── Project-scoped PM2 names (agent-slot.sh) ─────────────────────────────────
// Pattern: har-<project>-agent-<id>-<service> (machine-global PM2 namespace).

export function pm2SlotPrefix(projectName: string, agentId: number): string {
  return `har-${projectName}-agent-${agentId}`;
}

export function pm2DeleteRegex(projectName: string, agentId: number): string {
  return `/^har-${projectName}-agent-${agentId}-/`;
}

export function tmuxSessionName(projectName: string, agentId: number): string {
  return `har-${projectName}-agent-${agentId}`;
}

// ── Template rendering (envsubst equivalent) ─────────────────────────────────

/**
 * envsubst with an allowlist: substitute only ${VAR} / $VAR for the listed
 * keys, leaving every other dollar expression intact (the ecosystem template
 * is JavaScript full of untouched `${...}` template literals).
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (match, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare ?? '';
      return name in vars ? vars[name] : match;
    },
  );
}

export interface EcosystemConfigOptions {
  workDir: string;
  agentId: number;
  projectName: string;
  fePort: number;
  debugPort: number;
  /** .har/ecosystem.agent.template.cjs */
  templatePath: string;
}

/**
 * launch.sh: render ecosystem.agent.<id>.config.cjs from the template.
 * Exactly the four launch.sh envsubst variables are substituted.
 */
export function generateEcosystemConfig(options: EcosystemConfigOptions): string {
  const template = fs.readFileSync(options.templatePath, 'utf8');
  const rendered = renderTemplate(template, {
    AGENT_ID: String(options.agentId),
    HARNESS_PROJECT_NAME: options.projectName,
    FE_PORT: String(options.fePort),
    DEBUG_PORT: String(options.debugPort),
  });
  const configPath = path.join(options.workDir, `ecosystem.agent.${options.agentId}.config.cjs`);
  fs.writeFileSync(configPath, rendered);
  return configPath;
}

// ── PM2 lifecycle ─────────────────────────────────────────────────────────────

export interface Pm2Options {
  projectName: string;
  agentId: number;
  /** har_pkg_exec prefix, e.g. ["npx"]. */
  pkgExecPrefix?: string[];
  exec?: ExecFn;
}

function pm2(args: string[], options: Pm2Options, cwd?: string) {
  const [cmd, ...prefixArgs] = options.pkgExecPrefix ?? ['npx'];
  return (options.exec ?? defaultExec)(cmd, [...prefixArgs, 'pm2', ...args], { cwd });
}

/** launch.sh/teardown.sh: stop this slot's processes (project-scoped — never other harnesses). */
export function deleteAgentProcesses(options: Pm2Options): void {
  pm2(['delete', pm2DeleteRegex(options.projectName, options.agentId)], options);
}

/** launch.sh: delete stale processes, start the ecosystem, persist the dump. */
export function startAgentProcesses(options: Pm2Options & { workDir: string; ecosystemFile: string }): void {
  deleteAgentProcesses(options);
  const start = pm2(['start', options.ecosystemFile], options, options.workDir);
  if (start.code !== 0) {
    throw new Error(`pm2 start failed for ${options.ecosystemFile}`);
  }
  pm2(['save', '--force'], options, options.workDir);
}

// ── Health check (launch.sh) ──────────────────────────────────────────────────

export type HttpStatusFn = (url: string) => Promise<number>;

const defaultHttpStatus: HttpStatusFn = async (url) => {
  try {
    return (await fetch(url)).status;
  } catch {
    return 0;
  }
};

export interface HealthCheckOptions {
  apiPort: number;
  /** HARNESS_HEALTH_CHECK_PATH; the check is skipped when unset/empty. */
  healthCheckPath?: string;
  agentId: number;
  timeoutSeconds?: number;
  intervalSeconds?: number;
  log?: LogFn;
  httpStatus?: HttpStatusFn;
  sleep?: SleepFn;
}

/**
 * launch.sh health-check loop: poll until HTTP 200 or timeout (60s, every 2s).
 * Returns true when healthy; a timeout only warns — same as the script.
 */
export async function waitForHealthCheck(options: HealthCheckOptions): Promise<boolean> {
  const healthPath = options.healthCheckPath ?? '';
  if (!healthPath) return true;
  const {
    apiPort,
    agentId,
    timeoutSeconds = 60,
    intervalSeconds = 2,
    httpStatus = defaultHttpStatus,
    sleep = realSleep,
  } = options;
  const log =
    options.log ?? ((message: string) => process.stderr.write(`==> [agent-${agentId}] ${message}\n`));

  const healthUrl = `http://localhost:${apiPort}${healthPath}`;
  log(`Waiting for health check at ${healthUrl}...`);
  let elapsed = 0;
  while (elapsed < timeoutSeconds) {
    if ((await httpStatus(healthUrl)) === 200) {
      log('Health check passed!');
      return true;
    }
    await sleep(intervalSeconds);
    elapsed += intervalSeconds;
  }
  log(`Warning: Health check did not pass within ${timeoutSeconds}s.`);
  log(`Check logs: ./.har/agent-cli.sh ${agentId} logs`);
  return false;
}

// ── Readiness smoke (agent-slot.sh run_readiness_if_configured) ──────────────

/**
 * Optional project-owned "agent usable" smoke beyond health. Substitutes
 * {agentId} in HARNESS_READINESS_CMD and runs it through bash.
 */
export function runReadinessIfConfigured(
  env: Record<string, string>,
  agentId: number,
  options: { cwd?: string; exec?: ExecFn; log?: (message: string) => void } = {},
): number {
  const cmd = env.HARNESS_READINESS_CMD;
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  if (!cmd) {
    log('No HARNESS_READINESS_CMD configured; skipping readiness smoke.');
    return 0;
  }
  const substituted = cmd.replace(/\{agentId\}/g, String(agentId));
  return (options.exec ?? defaultExec)('bash', ['-c', substituted], { cwd: options.cwd }).code;
}
