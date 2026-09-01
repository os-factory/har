import * as fs from 'fs';
import * as path from 'path';
import { getHarnessDir } from './manifest';
import {
  HarnessEnvValidation,
  parseHarnessEnvSource,
  validateHarnessEnvSource,
} from './schema';

export function readHarnessEnv(repoPath: string): Record<string, string> {
  const envPath = path.join(getHarnessDir(repoPath), 'harness.env');
  if (!fs.existsSync(envPath)) return {};
  return parseHarnessEnvSource(fs.readFileSync(envPath, 'utf8')).values;
}

/**
 * Read harness.env through the 1.0 contract: pure KEY=value config validated
 * against HarnessEnvSchema. Returns null when the file does not exist.
 * Consumed by validation and `har env doctor` (#232).
 */
export function readValidatedHarnessEnv(repoPath: string): HarnessEnvValidation | null {
  const envPath = path.join(getHarnessDir(repoPath), 'harness.env');
  if (!fs.existsSync(envPath)) return null;
  return validateHarnessEnvSource(fs.readFileSync(envPath, 'utf8'));
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
