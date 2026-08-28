import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { ExecFn } from './exec';
import { parseHarnessEnvSource } from '../harness/schema';

/** HARNESS_* config from <harnessDir>/harness.env (empty when absent). */
function readHookHarnessEnv(harnessDir: string): Record<string, string> {
  const envPath = path.join(harnessDir, 'harness.env');
  if (!fs.existsSync(envPath)) return {};
  try {
    return parseHarnessEnvSource(fs.readFileSync(envPath, 'utf8')).values;
  } catch {
    return {};
  }
}

/**
 * Lifecycle hooks (#238): optional user-owned scripts in `.har/hooks/` the
 * runtime calls at fixed points. Hooks are the sanctioned place for custom
 * launch/verify/teardown behavior — never drift-checked against templates.
 */

export const LIFECYCLE_HOOKS = [
  'pre-launch',
  'post-launch',
  'pre-verify',
  'pre-teardown',
  'post-teardown',
] as const;

export type LifecycleHook = (typeof LIFECYCLE_HOOKS)[number];

/**
 * Version of the env contract hooks receive (HAR_HOOK_CONTRACT). Bump only
 * when an existing variable changes meaning — additions are backwards-safe.
 */
export const HOOK_CONTRACT_VERSION = '1';

export const HOOKS_DIR = 'hooks';

export function lifecycleHookPath(harnessDir: string, hook: LifecycleHook): string {
  return path.join(harnessDir, HOOKS_DIR, `${hook}.sh`);
}

export interface HookContext {
  harnessDir: string;
  agentId: number;
  /** Session work dir; the repo root for hooks that run before a session exists. */
  workDir?: string;
  /** The slot's .env.agent.<id> file, once generated. */
  envFile?: string;
  /** Per-slot app ports (exported as HAR_PORT_<NAME>). */
  ports?: Record<string, number | string>;
  /** Injectable runner (tests). Defaults to spawning bash with inherited output. */
  exec?: ExecFn;
  /** Progress sink, called only when a hook file actually exists. */
  log?: (message: string) => void;
}

export interface HookResult {
  /** False when no hook file exists (nothing was run). */
  ran: boolean;
  code: number;
  /** Path of the hook that ran, relative to the repo (for attribution). */
  file?: string;
}

/**
 * The env contract (v1) every hook receives:
 *   HAR_HOOK, HAR_HOOK_CONTRACT, AGENT_ID, HAR_HARNESS_DIR,
 *   WORK_DIR / ENV_FILE when the session has them,
 *   HAR_PORT_<NAME> for each allocated app port,
 *   every HARNESS_* key from harness.env (pure config in 1.0 — hooks lifted
 *   from the pre-1.0 scripts, which sourced it, keep reading their config).
 */
export function hookEnv(hook: LifecycleHook, context: HookContext): NodeJS.ProcessEnv {
  // harness.env wins over inherited process.env, matching the pre-1.0 scripts
  // (which sourced it last) — a hook of a nested harness must see its own
  // config, not values leaked from an enclosing harness's environment.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...readHookHarnessEnv(context.harnessDir),
    HAR_HOOK: hook,
    HAR_HOOK_CONTRACT: HOOK_CONTRACT_VERSION,
    AGENT_ID: String(context.agentId),
    HAR_HARNESS_DIR: context.harnessDir,
  };
  if (context.workDir) env.WORK_DIR = context.workDir;
  if (context.envFile) env.ENV_FILE = context.envFile;
  for (const [name, value] of Object.entries(context.ports ?? {})) {
    env[`HAR_PORT_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] = String(value);
  }
  return env;
}

/** Hook attribution string for failure messages: `.har/hooks/<hook>.sh`. */
export function hookDisplayPath(hook: LifecycleHook): string {
  return `.har/${HOOKS_DIR}/${hook}.sh`;
}

/**
 * Run a lifecycle hook if `.har/hooks/<hook>.sh` exists. Hooks run through
 * bash (executability is a doctor warning, not a runtime trap) from the work
 * dir, with output streaming to the user.
 */
export function runLifecycleHook(hook: LifecycleHook, context: HookContext): HookResult {
  const file = lifecycleHookPath(context.harnessDir, hook);
  if (!fs.existsSync(file)) return { ran: false, code: 0 };
  context.log?.(`Running ${hookDisplayPath(hook)}...`);
  const env = hookEnv(hook, context);
  const cwd = context.workDir ?? path.dirname(context.harnessDir);
  if (context.exec) {
    const result = context.exec('bash', [file], { cwd, env });
    return { ran: true, code: result.code, file: hookDisplayPath(hook) };
  }
  const result = spawnSync('bash', [file], {
    cwd,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  return { ran: true, code: result.status ?? 1, file: hookDisplayPath(hook) };
}

/**
 * post-* hook failure policy (HARNESS_HOOK_POST_FAILURE): 'warn' (default)
 * reports and continues; 'fail' fails the operation like a pre-* hook.
 */
export function postHookFailureMode(env: Record<string, string>): 'warn' | 'fail' {
  return env.HARNESS_HOOK_POST_FAILURE === 'fail' ? 'fail' : 'warn';
}
