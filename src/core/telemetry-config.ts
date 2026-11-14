import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * How much agent activity HAR records, from nothing to the full trajectory.
 * Each level includes everything below it. The level is the one stored
 * choice; every exporter switch (`TelemetrySignals`) is derived from it, so a
 * preference can never ask for prompts while disabling the channel that
 * carries them.
 */
export const TELEMETRY_LEVELS = ['off', 'usage', 'outline', 'full'] as const;
export type TelemetryLevel = (typeof TELEMETRY_LEVELS)[number];

export const DEFAULT_TELEMETRY_LEVEL: TelemetryLevel = 'full';

/**
 * Exporter switches, all derived from the level:
 * - `metrics`: the agent's own usage telemetry — Claude Code's native token /
 *   cost metrics and per-request `api_request` events (ADR 0003).
 * - `traces`: @osfactory/otel-hook spans — one per prompt, generation and tool call.
 * - `logs`: @osfactory/otel-hook event records (tool start/end, prompt
 *   submitted, generation end). They are the only channel that carries text.
 * - `prompts`: the text itself — prompts, agent replies, tool inputs and outputs.
 */
export interface TelemetrySignals {
  metrics: boolean;
  logs: boolean;
  prompts: boolean;
  traces: boolean;
}

export interface TelemetryPreference {
  enabled: boolean;
  level: TelemetryLevel;
  signals: TelemetrySignals;
  portalTrajectory?: boolean;
  updatedAt?: string;
}

const LEVEL_SIGNALS: Record<TelemetryLevel, TelemetrySignals> = {
  off: { metrics: false, traces: false, logs: false, prompts: false },
  usage: { metrics: true, traces: false, logs: false, prompts: false },
  outline: { metrics: true, traces: true, logs: true, prompts: false },
  full: { metrics: true, traces: true, logs: true, prompts: true },
};

export interface TelemetryLevelDescription {
  level: TelemetryLevel;
  label: string;
  summary: string;
  detail: string;
}

/** User-facing wording for each level, most detailed first — shared by onboarding and `har telemetry`. */
export const TELEMETRY_LEVEL_DESCRIPTIONS: readonly TelemetryLevelDescription[] = [
  {
    level: 'full',
    label: 'Full trajectory',
    summary: 'prompts, agent replies, tool inputs and outputs',
    detail:
      "Everything in Outline plus the text: your prompts, the agent's replies and each tool call's input and output.",
  },
  {
    level: 'outline',
    label: 'Outline',
    summary: 'every step and its timing, no text',
    detail:
      'Usage plus one row per prompt, generation and tool call with its timing and outcome — no prompt or tool text.',
  },
  {
    level: 'usage',
    label: 'Usage only',
    summary: 'tokens and cost',
    detail:
      "Tokens and cost per request from Claude Code's own telemetry, and from Claude / Codex session files at sync. Cursor reports usage only through the hook, so it needs Outline.",
  },
  {
    level: 'off',
    label: 'Off',
    summary: 'record nothing',
    detail: 'No agent telemetry is recorded. Runs, slots and verification still sync.',
  },
];

export function describeTelemetryLevel(level: TelemetryLevel): TelemetryLevelDescription {
  return TELEMETRY_LEVEL_DESCRIPTIONS.find((entry) => entry.level === level)!;
}

export function isTelemetryLevel(value: unknown): value is TelemetryLevel {
  return typeof value === 'string' && (TELEMETRY_LEVELS as readonly string[]).includes(value);
}

/** Exporter switches for a level. */
export function signalsForLevel(level: TelemetryLevel): TelemetrySignals {
  return { ...LEVEL_SIGNALS[level] };
}

/** True when `level` records at least as much as `minimum`. */
export function levelIncludes(level: TelemetryLevel, minimum: TelemetryLevel): boolean {
  return TELEMETRY_LEVELS.indexOf(level) >= TELEMETRY_LEVELS.indexOf(minimum);
}

/**
 * Accept a level, plus the spellings older flags used: `on` meant everything,
 * `on-no-prompts` meant everything but the text.
 */
export function parseTelemetryLevel(raw: unknown): TelemetryLevel | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  if (isTelemetryLevel(value)) return value;
  if (value === 'on') return 'full';
  if (value === 'on-no-prompts') return 'outline';
  return undefined;
}

/**
 * The level a pre-level preference file meant. Missing signals defaulted to on.
 * `prompts: true` always meant "record the text" — so a file that also turned
 * `logs` off (which silently dropped all text) is read as `full`.
 */
function levelFromLegacySignals(
  enabled: boolean,
  signals: Partial<TelemetrySignals> | undefined,
): TelemetryLevel {
  if (!enabled) return 'off';
  if (signals?.prompts !== false) return 'full';
  if (signals?.traces !== false || signals?.logs !== false) return 'outline';
  return signals?.metrics !== false ? 'usage' : 'off';
}

function getPreferencePath(): string {
  if (process.env.HAR_TELEMETRY_CONFIG_PATH) {
    return path.resolve(process.env.HAR_TELEMETRY_CONFIG_PATH);
  }
  return path.join(os.homedir(), '.har', 'telemetry.json');
}

function parseEnvOverride(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === '') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (['0', 'false', 'off', 'no', 'disabled'].includes(normalized)) return false;
  if (['1', 'true', 'on', 'yes', 'enabled'].includes(normalized)) return true;
  return undefined;
}

function preferenceFor(
  level: TelemetryLevel,
  rest: Pick<TelemetryPreference, 'portalTrajectory' | 'updatedAt'> = {},
): TelemetryPreference {
  return {
    enabled: level !== 'off',
    level,
    signals: signalsForLevel(level),
    ...(rest.portalTrajectory ? { portalTrajectory: true } : {}),
    ...(rest.updatedAt ? { updatedAt: rest.updatedAt } : {}),
  };
}

export function readTelemetryPreference(): TelemetryPreference {
  const preferencePath = getPreferencePath();
  try {
    if (!fs.existsSync(preferencePath)) return preferenceFor(DEFAULT_TELEMETRY_LEVEL);
    const parsed = JSON.parse(fs.readFileSync(preferencePath, 'utf8')) as {
      enabled?: unknown;
      level?: unknown;
      signals?: Partial<TelemetrySignals>;
      portalTrajectory?: unknown;
      updatedAt?: unknown;
    };
    const level = isTelemetryLevel(parsed.level)
      ? parsed.level
      : levelFromLegacySignals(parsed.enabled !== false, parsed.signals);
    return preferenceFor(level, {
      portalTrajectory: parsed.portalTrajectory === true,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
    });
  } catch {
    return preferenceFor(DEFAULT_TELEMETRY_LEVEL);
  }
}

function persist(preference: TelemetryPreference): TelemetryPreference {
  const preferencePath = getPreferencePath();
  fs.mkdirSync(path.dirname(preferencePath), { recursive: true });
  fs.writeFileSync(preferencePath, JSON.stringify(preference, null, 2) + '\n');
  return preference;
}

/**
 * Store a telemetry level. It replaces the previous choice outright — no
 * signal from an earlier preference survives, so `full` always means full.
 */
export function writeTelemetryLevel(level: TelemetryLevel): TelemetryPreference {
  const current = readTelemetryPreference();
  return persist(
    preferenceFor(level, {
      portalTrajectory: current.portalTrajectory,
      updatedAt: new Date().toISOString(),
    }),
  );
}

/**
 * Persist the default level when no preference file exists.
 * Does not overwrite an existing choice. Skips writing when HAR_TELEMETRY
 * explicitly disables telemetry.
 */
export function ensureDefaultTelemetryPreference(): TelemetryPreference {
  if (fs.existsSync(getPreferencePath())) return readTelemetryPreference();
  if (parseEnvOverride(process.env.HAR_TELEMETRY) === false) return preferenceFor('off');
  return writeTelemetryLevel(DEFAULT_TELEMETRY_LEVEL);
}

/** True when a preference file exists (the user, or onboarding, chose a level). */
export function hasTelemetryPreference(): boolean {
  return fs.existsSync(getPreferencePath());
}

/**
 * Effective level. `HAR_TELEMETRY` wins over ~/.har/telemetry.json: a level
 * name sets it, `0`/`off` turns it off, `1`/`on` re-enables a stored `off` as
 * the default level.
 */
export function getTelemetryLevel(): TelemetryLevel {
  const stored = readTelemetryPreference().level;
  const raw = process.env.HAR_TELEMETRY?.trim().toLowerCase();
  if (!raw) return stored;
  if (isTelemetryLevel(raw)) return raw;
  const toggle = parseEnvOverride(raw);
  if (toggle === false) return 'off';
  if (toggle === true) return stored === 'off' ? DEFAULT_TELEMETRY_LEVEL : stored;
  return stored;
}

/** Effective telemetry flag: anything above `off`. */
export function isTelemetryEnabled(): boolean {
  return getTelemetryLevel() !== 'off';
}

/** Effective exporter switches for the effective level. */
export function getTelemetrySignals(): TelemetrySignals {
  return signalsForLevel(getTelemetryLevel());
}

export function getTelemetryPreferencePath(): string {
  return getPreferencePath();
}

export function isPortalTrajectoryEnabled(): boolean {
  if (!isTelemetryEnabled()) return false;
  const envOverride = parseEnvOverride(process.env.HAR_PORTAL_TRAJECTORY);
  if (envOverride !== undefined) return envOverride;
  return readTelemetryPreference().portalTrajectory === true;
}

export function writePortalTrajectoryPreference(enabled: boolean): TelemetryPreference {
  const current = readTelemetryPreference();
  return persist(
    preferenceFor(current.level, {
      portalTrajectory: enabled,
      updatedAt: new Date().toISOString(),
    }),
  );
}
