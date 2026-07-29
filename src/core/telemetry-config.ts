import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface TelemetrySignals {
  metrics: boolean;
  logs: boolean;
  prompts: boolean;
  traces: boolean;
}

export interface TelemetryPreference {
  enabled: boolean;
  signals: TelemetrySignals;
  updatedAt?: string;
}

const DEFAULT_SIGNALS_ON: TelemetrySignals = {
  metrics: true,
  logs: true,
  prompts: true,
  /** Hooks are traces-first; usage metrics are derived from span gen_ai.usage.* in Mission Control. */
  traces: true,
};

const DEFAULT_SIGNALS_OFF: TelemetrySignals = {
  metrics: false,
  logs: false,
  prompts: false,
  traces: false,
};

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

function normalizeSignals(
  enabled: boolean,
  raw: Partial<TelemetrySignals> | undefined,
): TelemetrySignals {
  if (!enabled) return { ...DEFAULT_SIGNALS_OFF };
  return {
    metrics: raw?.metrics !== false,
    logs: raw?.logs !== false,
    prompts: raw?.prompts !== false,
    traces: raw?.traces !== false,
  };
}

export function readTelemetryPreference(): TelemetryPreference {
  const preferencePath = getPreferencePath();
  try {
    if (!fs.existsSync(preferencePath)) {
      return { enabled: true, signals: { ...DEFAULT_SIGNALS_ON } };
    }
    const parsed = JSON.parse(fs.readFileSync(preferencePath, 'utf8')) as Partial<TelemetryPreference> & {
      signals?: Partial<TelemetrySignals>;
    };
    const enabled = parsed.enabled !== false;
    return {
      enabled,
      signals: normalizeSignals(enabled, parsed.signals),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
    };
  } catch {
    return { enabled: true, signals: { ...DEFAULT_SIGNALS_ON } };
  }
}

export function writeTelemetryPreference(
  enabled: boolean,
  signals?: Partial<TelemetrySignals>,
): TelemetryPreference {
  const current = readTelemetryPreference();
  const nextSignals = normalizeSignals(enabled, {
    ...current.signals,
    ...signals,
  });
  const preference: TelemetryPreference = {
    enabled,
    signals: enabled ? nextSignals : { ...DEFAULT_SIGNALS_OFF },
    updatedAt: new Date().toISOString(),
  };
  const preferencePath = getPreferencePath();
  fs.mkdirSync(path.dirname(preferencePath), { recursive: true });
  fs.writeFileSync(preferencePath, JSON.stringify(preference, null, 2) + '\n');
  return preference;
}

/**
 * Persist full default telemetry (including prompts) when no preference file exists.
 * Does not overwrite an existing choice (e.g. prior `har telemetry off` or prompts=false).
 * Skips writing when HAR_TELEMETRY explicitly disables telemetry.
 */
export function ensureDefaultTelemetryPreference(): TelemetryPreference {
  const preferencePath = getPreferencePath();
  if (fs.existsSync(preferencePath)) {
    return readTelemetryPreference();
  }
  if (parseEnvOverride(process.env.HAR_TELEMETRY) === false) {
    return { enabled: false, signals: { ...DEFAULT_SIGNALS_OFF } };
  }
  return writeTelemetryPreference(true, { ...DEFAULT_SIGNALS_ON });
}

/** Effective telemetry flag: HAR_TELEMETRY env wins over ~/.har/telemetry.json; default on. */
export function isTelemetryEnabled(): boolean {
  const envOverride = parseEnvOverride(process.env.HAR_TELEMETRY);
  if (envOverride !== undefined) return envOverride;
  return readTelemetryPreference().enabled;
}

/** Effective signal flags (all false when telemetry is off). */
export function getTelemetrySignals(): TelemetrySignals {
  if (!isTelemetryEnabled()) return { ...DEFAULT_SIGNALS_OFF };
  return readTelemetryPreference().signals;
}

export function getTelemetryPreferencePath(): string {
  return getPreferencePath();
}

export const TELEMETRY_SIGNALS = [
  'Traces (default): Cursor / Claude / Codex activity via @osfactory/otel-hook → Mission Control',
  'Logs/events (default): hook lifecycle logs without prompt bodies',
  'Metrics (default): token usage derived from span gen_ai.usage.* attributes',
  'Prompts (default): user prompt text via otel-hook contentMode=raw (also fills Mission Control purpose); disable with har telemetry on --no-prompts',
  'Fallback: har control sync harvests local Claude/Codex session files when hooks telemetry is missing',
] as const;
