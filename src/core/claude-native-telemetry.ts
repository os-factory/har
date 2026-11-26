import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Cleanup of Claude Code's native telemetry settings written by HAR before 2.0.
 *
 * HAR 1.x and the first 2.0.0-next releases pointed Claude Code's own
 * OpenTelemetry exporter at Mission Control (`CLAUDE_CODE_ENABLE_TELEMETRY`,
 * `OTEL_*` keys in the `env` block of `~/.claude/settings.json`) and recorded
 * the keys and values it wrote in `~/.har/otel-hooks/claude-env.json`.
 *
 * Claude Code usage and trajectory now come from @osfactory/otel-hook only
 * (ADR 0005 section 5): HAR never writes those keys any more, and removes the
 * ones it wrote. A key whose value differs from what HAR recorded was changed
 * by the user and is left alone, as is every key HAR never wrote.
 */

export function claudeSettingsPath(home = os.homedir()): string {
  return path.join(home, '.claude', 'settings.json');
}

/** The record of what an earlier HAR wrote into the Claude settings `env` block. */
export function claudeManagedKeysPath(hooksHome: string): string {
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
    const data = readJson(claudeManagedKeysPath(hooksHome));
    const env = data?.env;
    return env && typeof env === 'object' ? (env as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * Remove the Claude Code native telemetry keys an earlier HAR wrote, and the
 * record of them. Returns the keys removed from the settings file. Idempotent:
 * without a record there is nothing HAR owns, and nothing is touched.
 */
export function removeClaudeNativeTelemetry(options: {
  settingsPath?: string;
  hooksHome: string;
}): string[] {
  const settingsPath = options.settingsPath ?? claudeSettingsPath();
  const keysPath = claudeManagedKeysPath(options.hooksHome);
  if (!fs.existsSync(keysPath)) return [];
  const managed = readManaged(options.hooksHome);
  const settings = readJson(settingsPath);
  const removed: string[] = [];
  if (settings && settings.env && typeof settings.env === 'object') {
    const env = { ...(settings.env as Record<string, string>) };
    for (const [key, value] of Object.entries(managed)) {
      if (env[key] === value) {
        delete env[key];
        removed.push(key);
      }
    }
    if (removed.length > 0) {
      const next: Record<string, unknown> = { ...settings };
      if (Object.keys(env).length > 0) next.env = env;
      else delete next.env;
      fs.writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
    }
  }
  fs.rmSync(keysPath, { force: true });
  return removed;
}
