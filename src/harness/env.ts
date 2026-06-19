import * as fs from 'fs';
import * as path from 'path';
import { getHarnessDir } from './manifest';

export function readHarnessEnv(repoPath: string): Record<string, string> {
  const envPath = path.join(getHarnessDir(repoPath), 'harness.env');
  if (!fs.existsSync(envPath)) return {};

  const values: Record<string, string> = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^export\s+([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return values;
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
