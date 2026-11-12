import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getControlApiUrl } from './control-config';

/**
 * Claude Code's own OpenTelemetry metrics → Mission Control.
 *
 * Claude Code reports tokens and cost to no hook (otel-hook
 * docs/claude-code-usage-contract.md), but its native telemetry does:
 * `claude_code.token.usage` / `claude_code.cost.usage`, with `session.id` and
 * `model` on every point. Mission Control joins those points to the hook spans
 * of the same session, so the cost lands on the slot the spans were attributed
 * to — live, without reading transcripts.
 *
 * - Metrics only. Claude's native logs carry prompts and per-request events
 *   that Mission Control does not model yet.
 * - Cumulative temporality: Mission Control max-merges usage counters, which is
 *   only correct for cumulative series (Claude's default is delta).
 * - `http/json`: decoded by every Mission Control version.
 *
 * Written to the `env` block of `~/.claude/settings.json`. A key the user set
 * to a different value is left alone; `har telemetry off` removes only the keys
 * HAR wrote, as recorded in `~/.har/otel-hooks/claude-env.json`.
 */

export const CLAUDE_METRIC_EXPORT_INTERVAL_MS = 10_000;

export function buildClaudeNativeTelemetryEnv(apiUrl = getControlApiUrl()): Record<string, string> {
  const base = apiUrl.replace(/\/$/, '');
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${base}/api/otel/v1/metrics`,
    OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'cumulative',
    OTEL_METRIC_EXPORT_INTERVAL: String(CLAUDE_METRIC_EXPORT_INTERVAL_MS),
  };
}

export function claudeSettingsPath(home = os.homedir()): string {
  return path.join(home, '.claude', 'settings.json');
}

function managedKeysPath(hooksHome: string): string {
  return path.join(hooksHome, 'claude-env.json');
}

function readJson(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function readManaged(hooksHome: string): Record<string, string> {
  try {
    const data = readJson(managedKeysPath(hooksHome));
    const env = data?.env;
    return env && typeof env === 'object' ? (env as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export interface ClaudeNativeTelemetryResult {
  settingsPath: string;
  written: string[];
  /** Keys the user already set to another value — left as they were. */
  skipped: string[];
}

export function enableClaudeNativeTelemetry(options: {
  apiUrl?: string;
  settingsPath?: string;
  hooksHome: string;
}): ClaudeNativeTelemetryResult {
  const settingsPath = options.settingsPath ?? claudeSettingsPath();
  const desired = buildClaudeNativeTelemetryEnv(options.apiUrl);
  const managed = readManaged(options.hooksHome);
  const settings = readJson(settingsPath) ?? {};
  const env = { ...((settings.env as Record<string, string> | undefined) ?? {}) };

  const written: string[] = [];
  const skipped: string[] = [];
  const nowManaged: Record<string, string> = {};
  for (const [key, value] of Object.entries(desired)) {
    const current = env[key];
    const ours = current === undefined || current === value || current === managed[key];
    if (!ours) {
      skipped.push(key);
      continue;
    }
    if (current !== value) written.push(key);
    env[key] = value;
    nowManaged[key] = value;
  }

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify({ ...settings, env }, null, 2)}\n`);
  const keysPath = managedKeysPath(options.hooksHome);
  fs.mkdirSync(path.dirname(keysPath), { recursive: true });
  fs.writeFileSync(keysPath, `${JSON.stringify({ env: nowManaged }, null, 2)}\n`);
  return { settingsPath, written, skipped };
}

export function disableClaudeNativeTelemetry(options: {
  settingsPath?: string;
  hooksHome: string;
}): string[] {
  const settingsPath = options.settingsPath ?? claudeSettingsPath();
  const managed = readManaged(options.hooksHome);
  const settings = readJson(settingsPath);
  if (!settings || !settings.env || typeof settings.env !== 'object') return [];
  const env = { ...(settings.env as Record<string, string>) };
  const removed: string[] = [];
  for (const [key, value] of Object.entries(managed)) {
    if (env[key] === value) {
      delete env[key];
      removed.push(key);
    }
  }
  if (removed.length === 0) return [];
  const next: Record<string, unknown> = { ...settings };
  if (Object.keys(env).length > 0) next.env = env;
  else delete next.env;
  fs.writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  fs.rmSync(managedKeysPath(options.hooksHome), { force: true });
  return removed;
}
