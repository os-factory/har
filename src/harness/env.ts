import * as fs from 'fs';
import * as path from 'path';
import { getHarnessDir } from './manifest';

/**
 * Parse `export KEY=value` lines out of harness.env content.
 *
 * A double-quoted value is unescaped the way the shell would, so callers read the
 * value the harness scripts actually see. Without it, a value written by
 * `applyHarnessEnvValues` and containing `$`, `"`, a backtick or a backslash would
 * be read back with its escaping still attached, and any comparison against it fails.
 */
export function parseHarnessEnvContent(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const match = line.match(/^export\s+([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    const raw = match[2];
    values[match[1]] =
      raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
        ? raw.slice(1, -1).replace(/\\([\\"$`])/g, '$1')
        : raw.replace(/^"|"$/g, '');
  }
  return values;
}

export function readHarnessEnv(repoPath: string): Record<string, string> {
  const envPath = path.join(getHarnessDir(repoPath), 'harness.env');
  if (!fs.existsSync(envPath)) return {};
  return parseHarnessEnvContent(fs.readFileSync(envPath, 'utf8'));
}

/** Escape a value for a double-quoted shell assignment. */
function escapeHarnessEnvValue(value: string): string {
  return value.replace(/([\\"$`])/g, '\\$1');
}

/**
 * Rewrite `export KEY="value"` lines in harness.env content.
 *
 * Pure on purpose: `init` applies the values before the manifest seals its
 * checksums, and drift replays the very same values onto the template before
 * comparing. Both paths must produce byte-identical output or a freshly generated
 * harness reports itself as drifted.
 *
 * Keys the template does not declare are skipped rather than appended — a stale
 * manifest must not resurrect an export a newer template deliberately removed.
 */
export function applyHarnessEnvValues(
  content: string,
  values: Record<string, string>,
): string {
  let out = content;
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    const pattern = new RegExp(`^export ${key}=.*$`, 'm');
    if (!pattern.test(out)) continue;
    const line = `export ${key}="${escapeHarnessEnvValue(value)}"`;
    out = out.replace(pattern, () => line);
  }
  return out;
}

export function parseHarnessEnvInt(
  env: Record<string, string>,
  key: string,
): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) return undefined;
  return value;
}
