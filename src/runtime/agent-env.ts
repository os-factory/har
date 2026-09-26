import * as fs from 'fs';
import * as path from 'path';
import {
  appendTelemetryEnvToFile,
  buildSessionKey,
  TelemetrySessionAttrs,
} from '../core/telemetry-env';
import { readSlotRegistry } from '../core/slot-registry';

/**
 * Package-side agent env-file generation (#234) — ports
 * har_regenerate_agent_env_file: envsubst over .har/env.template restricted to
 * the launch-time variables, plus the `har telemetry write-env` follow-up.
 */

/** The only variables launch.sh substitutes (envsubst SHELL-FORMAT list). */
export const AGENT_ENV_TEMPLATE_VARS = [
  'AGENT_ID',
  'API_PORT',
  'FE_PORT',
  'DEBUG_PORT',
  'DB_PORT',
  'MINIO_PORT',
  'BROWSER_PORT',
  'REPO_ROOT',
] as const;

export type AgentEnvTemplateVar = (typeof AGENT_ENV_TEMPLATE_VARS)[number];

/**
 * envsubst-equivalent substitution: `$VAR` and `${VAR}` references to the
 * listed names are replaced (missing values become ''); every other `$…`
 * sequence is left byte-for-byte untouched.
 */
export function substituteEnvTemplate(
  template: string,
  values: Partial<Record<AgentEnvTemplateVar, string | number>>,
): string {
  const allowed = new Set<string>(AGENT_ENV_TEMPLATE_VARS);
  return template.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (match, braced?: string, bare?: string) => {
      const name = braced ?? bare ?? '';
      if (!allowed.has(name)) return match;
      const value = values[name as AgentEnvTemplateVar];
      return value === undefined ? '' : String(value);
    },
  );
}

export type UnsubstitutedReason =
  /** `$NAME` / `${NAME}` outside AGENT_ENV_TEMPLATE_VARS. */
  | 'not-substituted'
  /** `${NAME<modifier>}` (`:-`, `:?`, `#`, `%`, …): envsubst expands none of it. */
  | 'parameter-syntax';

export interface UnsubstitutedTemplateVar {
  name: string;
  reason: UnsubstitutedReason;
  /** 1-indexed lines where the reference appears (comments excluded). */
  lines: number[];
}

/**
 * References in an env.template that `substituteEnvTemplate` (like envsubst)
 * writes literally to `.env.agent.<id>`: names outside AGENT_ENV_TEMPLATE_VARS,
 * and any `${NAME…}` with shell parameter syntax — even for launch-time names.
 * Comment lines are ignored. `\$` is not an escape (envsubst keeps the
 * backslash), so it is reported like any other reference. Used by
 * `har env doctor` (#361) to catch these before launch.
 */
export function findUnsubstitutedTemplateVars(template: string): UnsubstitutedTemplateVar[] {
  const allowed = new Set<string>(AGENT_ENV_TEMPLATE_VARS);
  const found = new Map<string, UnsubstitutedTemplateVar>();
  template.split('\n').forEach((line, idx) => {
    if (/^\s*#/.test(line)) return;
    const re = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)(\}?)|([A-Za-z_][A-Za-z0-9_]*))/g;
    for (let m = re.exec(line); m !== null; m = re.exec(line)) {
      const braced = m[1] !== undefined;
      const name = braced ? m[1] : m[4];
      const plain = !braced || (m[2] === '' && m[3] === '}');
      const reason: UnsubstitutedReason = plain ? 'not-substituted' : 'parameter-syntax';
      if (plain && allowed.has(name)) continue;
      const key = `${reason}:${name}`;
      const entry = found.get(key) ?? { name, reason, lines: [] };
      if (!entry.lines.includes(idx + 1)) entry.lines.push(idx + 1);
      found.set(key, entry);
    }
  });
  return [...found.values()];
}

export interface AgentEnvValues {
  agentId: number;
  apiPort: string | number;
  fePort: string | number;
  debugPort: string | number;
  dbPort: string | number;
  minioPort: string | number;
  browserPort: string | number;
  /** launch.sh exports REPO_ROOT="$work_dir" for the substitution. */
  repoRoot: string;
}

export interface GenerateAgentEnvFileOptions {
  /** .har directory holding env.template. */
  harnessDir: string;
  /** Destination `<workDir>/.env.agent.<id>`. */
  envFile: string;
  values: AgentEnvValues;
  /** Overrides `<harnessDir>/env.template` (tests). */
  templatePath?: string;
}

/**
 * Renders env.template → envFile. Returns false (no-op) when the template is
 * absent, matching the bash `[ ! -f "$template" ] && return 0`.
 */
export function generateAgentEnvFile(options: GenerateAgentEnvFileOptions): boolean {
  const templatePath = options.templatePath ?? path.join(options.harnessDir, 'env.template');
  if (!fs.existsSync(templatePath)) return false;

  const template = fs.readFileSync(templatePath, 'utf8');
  const v = options.values;
  const rendered = substituteEnvTemplate(template, {
    AGENT_ID: v.agentId,
    API_PORT: v.apiPort,
    FE_PORT: v.fePort,
    DEBUG_PORT: v.debugPort,
    DB_PORT: v.dbPort,
    MINIO_PORT: v.minioPort,
    BROWSER_PORT: v.browserPort,
    REPO_ROOT: v.repoRoot,
  });

  fs.mkdirSync(path.dirname(options.envFile), { recursive: true });
  fs.writeFileSync(options.envFile, rendered);
  return true;
}

export interface SessionTelemetryOptions {
  agentId: number;
  /** Harness repo root (write-env's --repo, resolved). */
  repoPath: string;
  envFile?: string;
  workDir?: string;
  branch?: string;
  suffix?: string;
  sessionKey?: string;
  workUnitId?: string;
  attemptId?: string;
}

/**
 * The `har telemetry write-env` follow-up launch.sh runs after rendering the
 * env file: appends the HAR session-attribution block. Same resolution order
 * as the CLI handler — explicit args, then the slot registry, then defaults.
 */
export function appendSessionTelemetry(options: SessionTelemetryOptions): string {
  const session = readSlotRegistry(options.repoPath, options.agentId);
  const workDir = options.workDir ?? session?.workDir ?? options.repoPath;
  const branch = options.branch ?? session?.branch;
  const suffix = options.suffix ?? session?.suffix;
  const sessionKey =
    options.sessionKey ??
    buildSessionKey({
      branch,
      agentId: options.agentId,
      suffix,
      createdAt: session?.createdAt,
    });
  const envFile = options.envFile ?? path.join(workDir, `.env.agent.${options.agentId}`);

  const attrs: TelemetrySessionAttrs = {
    sessionKey,
    agentId: options.agentId,
    repoPath: options.repoPath,
    workDir,
    branch,
    suffix,
    workUnitId: options.workUnitId,
    attemptId: options.attemptId,
  };
  appendTelemetryEnvToFile(envFile, attrs);
  return envFile;
}
