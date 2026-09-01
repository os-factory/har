import { z } from 'zod';

/**
 * harness.env contract (1.0): the file is pure `KEY=value` config — comments
 * and `export KEY=value` lines only. Shell functions live in .har/lib/.
 * This module is the single source of truth for its keys: parsing, schema
 * validation, and actionable error messages (consumed by env reads, the
 * generator, and `har env doctor`).
 */

export const HARNESS_ECOSYSTEMS = [
  'auto',
  'node',
  'python',
  'go',
  'rust',
  'java',
  'ruby',
  'ios',
  'none',
] as const;

export const HARNESS_NODE_PACKAGE_MANAGERS = ['npm', 'bun', 'pnpm', 'yarn'] as const;

/** One shared-infra port lane: default tried first, then the scan range. */
export const PortLaneSchema = z
  .object({
    default: z.number().int().min(1).max(65535),
    scanStart: z.number().int().min(1).max(65535),
    scanEnd: z.number().int().min(1).max(65535),
  })
  .refine((lane) => lane.scanStart <= lane.scanEnd, {
    message: 'scanStart must be <= scanEnd',
  });

export type PortLane = z.infer<typeof PortLaneSchema>;

const booleanString = z.enum(['true', 'false']).transform((v) => v === 'true');
const intString = z
  .string()
  .regex(/^\d+$/, 'must be an integer')
  .transform((v) => Number(v));
const portString = z
  .string()
  .regex(/^\d+$/, 'must be a port number')
  .transform((v) => Number(v))
  .pipe(z.number().int().min(1).max(65535));

/**
 * Typed view of harness.env. Keys map 1:1 to HARNESS_* vars; every field is
 * optional except the project name — profiles ship different subsets.
 */
export const HarnessEnvSchema = z.object({
  HARNESS_PROJECT_NAME: z.string().min(1, 'HARNESS_PROJECT_NAME must not be empty'),
  HARNESS_USE_WORKTREE: booleanString.optional(),
  HARNESS_PRIMARY_APP: z.string().optional(),
  HARNESS_TEMPLATE_DB: z.string().optional(),
  HARNESS_TEMPLATE_DBS: z.string().optional(),

  // Per-slot app port lanes
  HARNESS_FE_BASE_PORT: portString.optional(),
  HARNESS_API_BASE_PORT: portString.optional(),
  HARNESS_PORT_STEP: intString.optional(),
  HARNESS_HEALTH_CHECK_PATH: z.string().optional(),

  // Shared infra port lanes: "db=15432:15432-15499 minio=19000:19000-19099"
  HARNESS_INFRA_PORT_LANES: z.string().optional(),

  HARNESS_AGENT_SLOT_MIN: intString.optional(),
  HARNESS_AGENT_SLOT_MAX: intString.optional(),

  // Lifecycle hooks (#238): what a failing post-* hook does ('warn' default)
  HARNESS_HOOK_POST_FAILURE: z.enum(['warn', 'fail']).optional(),

  HARNESS_ECOSYSTEM: z.enum(HARNESS_ECOSYSTEMS).optional(),
  HARNESS_INSTALL_CMD: z.string().optional(),
  HARNESS_NODE_PACKAGE_MANAGER: z.enum(HARNESS_NODE_PACKAGE_MANAGERS).optional(),
  HARNESS_PYTHON_VENV_DIR: z.string().optional(),

  HARNESS_INFRA_SERVICES: z.string().optional(),
  HARNESS_DB_MIGRATE_CMD: z.string().optional(),
  HARNESS_DB_SEED_CMD: z.string().optional(),
  HARNESS_DB_MINIMAL_BOOTSTRAP_CMD: z.string().optional(),
  HARNESS_READINESS_CMD: z.string().optional(),

  // Security-stage knobs (semgrep/trivy plugins)
  HARNESS_SEMGREP_CONFIG: z.string().optional(),
  HARNESS_TRIVY_SCANNERS: z.string().optional(),
  HARNESS_TRIVY_SEVERITY: z.string().optional(),
  HARNESS_SCRUB_DIRS: z.string().optional(),

  // Xcode / iOS Simulator
  HARNESS_XCODE_WORKSPACE: z.string().optional(),
  HARNESS_XCODE_PROJECT: z.string().optional(),
  HARNESS_XCODE_SCHEME: z.string().optional(),
  HARNESS_SIMULATOR_NAME: z.string().optional(),
  HARNESS_BUNDLE_ID: z.string().optional(),
  HARNESS_SIMULATOR_FAMILY: z.enum(['auto', 'iPhone', 'iPad']).optional(),
  HARNESS_SIMULATOR_UDID: z.string().optional(),
  HARNESS_SIMULATOR_SHARED: booleanString.optional(),
  HARNESS_IOS_DESTINATION: z.string().optional(),
  HARNESS_SWIFTLINT_CMD: z.string().optional(),
});

export type HarnessEnvConfig = z.infer<typeof HarnessEnvSchema>;

export const HARNESS_ENV_KNOWN_KEYS = Object.keys(HarnessEnvSchema.shape) as readonly string[];

/** Pre-1.0 per-service port triplets, still accepted (deprecated) as a lane fallback. */
export const LEGACY_PORT_TRIPLET_PATTERN =
  /^HARNESS_[A-Z0-9_]+_PORT_(DEFAULT|SCAN_START|SCAN_END)$/;

export interface HarnessEnvIssue {
  severity: 'error' | 'warning';
  message: string;
  /** 1-indexed line in harness.env when the issue is tied to a line. */
  line?: number;
  key?: string;
}

export interface ParsedHarnessEnv {
  /** Raw KEY=value pairs, quotes stripped. */
  values: Record<string, string>;
  issues: HarnessEnvIssue[];
}

const ASSIGNMENT_RE = /^(?:export\s+)([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const BARE_ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

function stripQuotes(raw: string): string {
  const trimmed = raw.trim();
  // Quoted value (possibly followed by a trailing comment) — keep the quoted
  // content verbatim, including any # inside the quotes.
  const quoted = trimmed.match(/^"([^"]*)"\s*(?:#.*)?$/) ?? trimmed.match(/^'([^']*)'\s*(?:#.*)?$/);
  if (quoted) return quoted[1];
  return trimmed.replace(/\s+#.*$/, '').trim();
}

/**
 * Parse harness.env text under the pure-config contract. Comments and blank
 * lines are ignored; `export KEY=value` (or `KEY=value`) lines become values;
 * anything else — function definitions, control flow, sourcing — is flagged.
 */
export function parseHarnessEnvSource(text: string): ParsedHarnessEnv {
  const values: Record<string, string> = {};
  const issues: HarnessEnvIssue[] = [];
  let shellDepth = 0;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    if (shellDepth > 0) {
      // Inside a flagged function/compound block — track braces, don't re-flag.
      shellDepth += (trimmed.match(/{/g) ?? []).length;
      shellDepth -= (trimmed.match(/}/g) ?? []).length;
      if (shellDepth < 0) shellDepth = 0;
      continue;
    }

    const match = trimmed.match(ASSIGNMENT_RE) ?? trimmed.match(BARE_ASSIGNMENT_RE);
    if (match) {
      const value = stripQuotes(match[2]);
      if (/[`$(]/.test(match[2]) && /\$\{?[A-Za-z_]/.test(match[2])) {
        issues.push({
          severity: 'warning',
          line: i + 1,
          key: match[1],
          message: `${match[1]} uses shell interpolation — harness.env is pure config; compute derived values in the runtime (.har/lib/) instead`,
        });
      }
      values[match[1]] = value;
      continue;
    }

    if (/^[A-Za-z_][A-Za-z0-9_]*\s*\(\)\s*\{?/.test(trimmed)) {
      issues.push({
        severity: 'error',
        line: i + 1,
        message: `harness.env must be pure KEY=value config — move the function \`${trimmed.split('(')[0].trim()}()\` into .har/lib/ (shipped helpers live in lib/infra.sh and lib/node-pm.sh)`,
      });
      shellDepth = (trimmed.match(/{/g) ?? []).length - (trimmed.match(/}/g) ?? []).length;
      if (shellDepth < 0) shellDepth = 0;
      continue;
    }

    issues.push({
      severity: 'error',
      line: i + 1,
      message: `harness.env must be pure KEY=value config — unexpected shell code: \`${trimmed.slice(0, 60)}\``,
    });
  }

  return { values, issues };
}

/** Parse a HARNESS_INFRA_PORT_LANES declaration into structured lanes. */
export function parsePortLanes(raw: string): {
  lanes: Record<string, PortLane>;
  issues: HarnessEnvIssue[];
} {
  const lanes: Record<string, PortLane> = {};
  const issues: HarnessEnvIssue[] = [];

  for (const entry of raw.trim().split(/\s+/).filter(Boolean)) {
    const match = entry.match(/^([a-z0-9][a-z0-9-]*)=(\d+):(\d+)-(\d+)$/);
    if (!match) {
      issues.push({
        severity: 'error',
        key: 'HARNESS_INFRA_PORT_LANES',
        message: `Malformed port lane \`${entry}\` — expected <lane>=<default>:<scan_start>-<scan_end>, e.g. db=15432:15432-15499`,
      });
      continue;
    }
    const [, lane, def, start, end] = match;
    const parsed = PortLaneSchema.safeParse({
      default: Number(def),
      scanStart: Number(start),
      scanEnd: Number(end),
    });
    if (!parsed.success) {
      issues.push({
        severity: 'error',
        key: 'HARNESS_INFRA_PORT_LANES',
        message: `Invalid port lane \`${entry}\`: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      });
      continue;
    }
    if (lanes[lane]) {
      issues.push({
        severity: 'error',
        key: 'HARNESS_INFRA_PORT_LANES',
        message: `Duplicate port lane \`${lane}\``,
      });
      continue;
    }
    lanes[lane] = parsed.data;
  }

  // Overlap check — lanes must not share scan ranges.
  const names = Object.keys(lanes);
  for (let a = 0; a < names.length; a++) {
    for (let b = a + 1; b < names.length; b++) {
      const la = lanes[names[a]];
      const lb = lanes[names[b]];
      if (la.scanStart <= lb.scanEnd && lb.scanStart <= la.scanEnd) {
        issues.push({
          severity: 'warning',
          key: 'HARNESS_INFRA_PORT_LANES',
          message: `Port lanes \`${names[a]}\` (${la.scanStart}-${la.scanEnd}) and \`${names[b]}\` (${lb.scanStart}-${lb.scanEnd}) overlap — scans may collide`,
        });
      }
    }
  }

  return { lanes, issues };
}

function suggestKey(unknown: string): string | undefined {
  const target = unknown.toUpperCase();
  let best: string | undefined;
  let bestScore = 0;
  for (const known of HARNESS_ENV_KNOWN_KEYS) {
    let score = 0;
    const max = Math.min(target.length, known.length);
    while (score < max && target[score] === known[score]) score++;
    if (score > bestScore) {
      bestScore = score;
      best = known;
    }
  }
  return bestScore >= 10 ? best : undefined;
}

export interface HarnessEnvValidation {
  /** Typed config when schema validation passed (errors may still exist for other keys). */
  config: HarnessEnvConfig | null;
  /** Structured infra port lanes (from HARNESS_INFRA_PORT_LANES). */
  portLanes: Record<string, PortLane>;
  issues: HarnessEnvIssue[];
  /** True when no error-severity issues exist. */
  ok: boolean;
}

/**
 * Validate raw harness.env values against the schema. Unknown HARNESS_* keys
 * and malformed values produce actionable errors; legacy port triplets and
 * non-HARNESS custom exports are tolerated with warnings.
 */
export function validateHarnessEnv(values: Record<string, string>): HarnessEnvValidation {
  const issues: HarnessEnvIssue[] = [];
  const known: Record<string, string> = {};

  for (const [key, value] of Object.entries(values)) {
    if ((HARNESS_ENV_KNOWN_KEYS as string[]).includes(key)) {
      known[key] = value;
    } else if (LEGACY_PORT_TRIPLET_PATTERN.test(key)) {
      issues.push({
        severity: 'warning',
        key,
        message: `${key} is a pre-1.0 port triplet — declare the lane in HARNESS_INFRA_PORT_LANES instead (e.g. db=15432:15432-15499)`,
      });
    } else if (key.startsWith('HARNESS_')) {
      const suggestion = suggestKey(key);
      issues.push({
        severity: 'error',
        key,
        message: `Unknown key ${key}${suggestion ? ` — did you mean ${suggestion}?` : ` — not a harness.env schema key (see @har/schemas HarnessEnvSchema)`}`,
      });
    } else {
      issues.push({
        severity: 'warning',
        key,
        message: `${key} is not a HARNESS_* key — harness.env is for harness config; app env belongs in .env.agent templates`,
      });
    }
  }

  if (!('HARNESS_PROJECT_NAME' in known)) {
    issues.push({
      severity: 'error',
      key: 'HARNESS_PROJECT_NAME',
      message: 'Missing required key HARNESS_PROJECT_NAME — run `har env maintain` to regenerate harness.env',
    });
  }

  const parsed = HarnessEnvSchema.safeParse(known);
  let config: HarnessEnvConfig | null = null;
  if (parsed.success) {
    config = parsed.data;
  } else {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? '');
      issues.push({
        severity: 'error',
        key,
        message: `${key}: ${issue.message}${key && values[key] !== undefined ? ` (got \`${values[key]}\`)` : ''}`,
      });
    }
  }

  let portLanes: Record<string, PortLane> = {};
  if (known.HARNESS_INFRA_PORT_LANES) {
    const laneResult = parsePortLanes(known.HARNESS_INFRA_PORT_LANES);
    portLanes = laneResult.lanes;
    issues.push(...laneResult.issues);
  }

  // Cross-field checks
  if (config?.HARNESS_AGENT_SLOT_MIN !== undefined && config?.HARNESS_AGENT_SLOT_MAX !== undefined) {
    if (config.HARNESS_AGENT_SLOT_MAX < config.HARNESS_AGENT_SLOT_MIN) {
      issues.push({
        severity: 'error',
        key: 'HARNESS_AGENT_SLOT_MAX',
        message: 'HARNESS_AGENT_SLOT_MAX must be >= HARNESS_AGENT_SLOT_MIN',
      });
    }
  }

  const services = (known.HARNESS_INFRA_SERVICES ?? '').trim().split(/\s+/).filter(Boolean);
  for (const service of services) {
    const hasLane =
      service in portLanes ||
      // compose service "headless-browser" is served by the "browser" lane
      (service === 'headless-browser' && 'browser' in portLanes) ||
      (service === 'mailpit' && 'mailpit-web' in portLanes) ||
      Object.keys(values).some((k) =>
        k.startsWith(`HARNESS_${service.toUpperCase().replace(/-/g, '_')}_PORT_`),
      );
    if (!hasLane && known.HARNESS_INFRA_PORT_LANES !== undefined) {
      issues.push({
        severity: 'warning',
        key: 'HARNESS_INFRA_SERVICES',
        message: `Infra service \`${service}\` has no port lane in HARNESS_INFRA_PORT_LANES — setup-infra.sh will fall back to built-in defaults`,
      });
    }
  }

  return {
    config,
    portLanes,
    issues,
    ok: !issues.some((i) => i.severity === 'error'),
  };
}

/** Parse + validate harness.env text in one call (the doctor entry point). */
export function validateHarnessEnvSource(text: string): HarnessEnvValidation {
  const parsed = parseHarnessEnvSource(text);
  const validation = validateHarnessEnv(parsed.values);
  return {
    ...validation,
    issues: [...parsed.issues, ...validation.issues],
    ok:
      !parsed.issues.some((i) => i.severity === 'error') &&
      !validation.issues.some((i) => i.severity === 'error'),
  };
}
