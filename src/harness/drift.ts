import * as fs from 'fs';
import * as path from 'path';
import type { HarnessProfile } from './generator';
import { readHarnessEnv } from './env';
import {
  computeFileChecksum,
  GENERATOR_VERSION,
  getHarnessDir,
  readManifest,
} from './manifest';
import { resolveTemplatesDir } from '../utils/paths';

const PROFILE_DIRS: Record<HarnessProfile, string> = {
  default: 'har-boilerplate',
  cli: 'har-boilerplate-cli',
  ios: 'har-boilerplate-ios',
};

const CLI_EXPECTED_ABSENT = new Set([
  'ecosystem.agent.template.cjs',
  'env.template',
  'attach.sh',
]);

export interface HarnessDriftResult {
  generatorVersion: {
    installed?: string;
    bundled: string;
    outdated: boolean;
  };
  missing: string[];
  checksumMismatch: string[];
  extra: string[];
  unchanged: string[];
  /** Port-allocation knobs from harness.env that the bundled template expects. */
  missingPortVars: string[];
}

const APP_PORT_VARS = [
  'HARNESS_FE_BASE_PORT',
  'HARNESS_API_BASE_PORT',
  'HARNESS_PORT_STEP',
] as const;

const INFRA_PORT_VARS_BY_SERVICE: Record<string, readonly string[]> = {
  db: [
    'HARNESS_DB_PORT_DEFAULT',
    'HARNESS_DB_PORT_SCAN_START',
    'HARNESS_DB_PORT_SCAN_END',
  ],
  minio: [
    'HARNESS_MINIO_PORT_DEFAULT',
    'HARNESS_MINIO_PORT_SCAN_START',
    'HARNESS_MINIO_PORT_SCAN_END',
    'HARNESS_MINIO_CONSOLE_PORT_DEFAULT',
    'HARNESS_MINIO_CONSOLE_PORT_SCAN_START',
    'HARNESS_MINIO_CONSOLE_PORT_SCAN_END',
  ],
  mailpit: [
    'HARNESS_MAILPIT_WEB_PORT_DEFAULT',
    'HARNESS_MAILPIT_WEB_PORT_SCAN_START',
    'HARNESS_MAILPIT_WEB_PORT_SCAN_END',
    'HARNESS_MAILPIT_SMTP_PORT_DEFAULT',
    'HARNESS_MAILPIT_SMTP_PORT_SCAN_START',
    'HARNESS_MAILPIT_SMTP_PORT_SCAN_END',
  ],
  'headless-browser': [
    'HARNESS_BROWSER_PORT_DEFAULT',
    'HARNESS_BROWSER_PORT_SCAN_START',
    'HARNESS_BROWSER_PORT_SCAN_END',
  ],
};

/** Returns harness.env export names missing for the profile and enabled infra services. */
export function missingPortDocumentationVars(
  profile: HarnessProfile,
  env: Record<string, string>,
): string[] {
  const missing: string[] = [];

  if (profile === 'default') {
    for (const key of APP_PORT_VARS) {
      if (!(key in env)) missing.push(key);
    }
  }

  if (profile === 'cli' && !('HARNESS_PORT_STEP' in env)) {
    missing.push('HARNESS_PORT_STEP');
  }

  const services = (env.HARNESS_INFRA_SERVICES ?? '').trim().split(/\s+/).filter(Boolean);
  for (const service of services) {
    const vars = INFRA_PORT_VARS_BY_SERVICE[service];
    if (!vars) continue;
    for (const key of vars) {
      if (!(key in env)) missing.push(key);
    }
  }

  return [...new Set(missing)];
}

function substituteProjectName(content: string, projectName: string): string {
  return content
    .replace(/__PROJECT_NAME__/g, projectName)
    .replace(/template___PROJECT_NAME__/g, `template_${projectName}`);
}

function listBoilerplateFiles(boilerplateDir: string): string[] {
  if (!fs.existsSync(boilerplateDir)) return [];
  return fs
    .readdirSync(boilerplateDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

export function compareHarnessToTemplate(repoPath: string): HarnessDriftResult {
  const resolved = path.resolve(repoPath);
  const manifest = readManifest(resolved);
  const profile: HarnessProfile = manifest?.profile ?? 'default';
  const harnessDir = getHarnessDir(resolved);
  const projectName = path.basename(resolved).toLowerCase().replace(/[^a-z0-9]/g, '_');
  const boilerplateDir = path.join(resolveTemplatesDir(), PROFILE_DIRS[profile]);
  const templateFiles = listBoilerplateFiles(boilerplateDir);

  const missing: string[] = [];
  const checksumMismatch: string[] = [];
  const extra: string[] = [];
  const unchanged: string[] = [];

  for (const file of templateFiles) {
    const templatePath = path.join(boilerplateDir, file);
    const harnessPath = path.join(harnessDir, file);
    let templateContent = fs.readFileSync(templatePath, 'utf8');
    if (file === 'harness.env') {
      templateContent = substituteProjectName(templateContent, projectName);
    }

    if (!fs.existsSync(harnessPath)) {
      missing.push(file);
      continue;
    }

    const harnessChecksum = computeFileChecksum(fs.readFileSync(harnessPath, 'utf8'));
    const templateChecksum = computeFileChecksum(templateContent);
    if (harnessChecksum === templateChecksum) {
      unchanged.push(file);
    } else {
      checksumMismatch.push(file);
    }
  }

  if (fs.existsSync(harnessDir)) {
    for (const file of fs.readdirSync(harnessDir)) {
      const full = path.join(harnessDir, file);
      if (!fs.statSync(full).isFile()) continue;
      if (file === 'manifest.json' || file.startsWith('ADAPT-PROMPT')) continue;
      if (profile === 'cli' && CLI_EXPECTED_ABSENT.has(file)) {
        extra.push(file);
      } else if (!templateFiles.includes(file)) {
        extra.push(file);
      }
    }
  }

  const installed = manifest?.generatorVersion;
  const harnessEnv = readHarnessEnv(resolved);
  const missingPortVars = missingPortDocumentationVars(profile, harnessEnv);

  return {
    generatorVersion: {
      installed,
      bundled: GENERATOR_VERSION,
      outdated: installed !== undefined && installed !== GENERATOR_VERSION,
    },
    missing,
    checksumMismatch,
    extra,
    unchanged,
    missingPortVars,
  };
}
