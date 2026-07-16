import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface TelemetryPreference {
  enabled: boolean;
  updatedAt?: string;
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

export function readTelemetryPreference(): TelemetryPreference {
  const preferencePath = getPreferencePath();
  try {
    if (!fs.existsSync(preferencePath)) {
      return { enabled: true };
    }
    const parsed = JSON.parse(fs.readFileSync(preferencePath, 'utf8')) as Partial<TelemetryPreference>;
    return {
      enabled: parsed.enabled !== false,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
    };
  } catch {
    return { enabled: true };
  }
}

export function writeTelemetryPreference(enabled: boolean): TelemetryPreference {
  const preference: TelemetryPreference = {
    enabled,
    updatedAt: new Date().toISOString(),
  };
  const preferencePath = getPreferencePath();
  fs.mkdirSync(path.dirname(preferencePath), { recursive: true });
  fs.writeFileSync(preferencePath, JSON.stringify(preference, null, 2) + '\n');
  return preference;
}

/** Effective telemetry flag: HAR_TELEMETRY env wins over ~/.har/telemetry.json; default on. */
export function isTelemetryEnabled(): boolean {
  const envOverride = parseEnvOverride(process.env.HAR_TELEMETRY);
  if (envOverride !== undefined) return envOverride;
  return readTelemetryPreference().enabled;
}

export function getTelemetryPreferencePath(): string {
  return getPreferencePath();
}

export const TELEMETRY_SIGNALS = [
  'Claude Code: tokens (input/output/cache) and estimated USD cost via OTEL metrics',
  'Codex CLI: token usage via OTEL metrics (no native USD; harvest fills gaps)',
  'Fallback: har control sync harvests local Claude/Codex session files when OTEL is missing',
] as const;
