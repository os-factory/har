import * as fs from 'fs';
import * as path from 'path';
import type { HarnessProfile } from './generator';
import { readHarnessEnv } from './env';
import {
  harnessFileForTemplate,
  isExpectedHarnessOnlyFile,
  templateFileForHarness,
} from './gitignore-template';
import {
  computeFileChecksum,
  getHarnessDir,
  readManifest,
} from './manifest';
import { detectAgentSlotEnvMismatch } from './stages';
import { composeProfileTemplateMap } from './profiles';

const CLI_EXPECTED_ABSENT = new Set([
  'ecosystem.agent.template.cjs',
  'env.template',
  'attach.sh',
]);

export interface HarnessDriftResult {
  missing: string[];
  checksumMismatch: string[];
  extra: string[];
  unchanged: string[];
  /** Port-allocation knobs from harness.env that the bundled template expects. */
  missingPortVars: string[];
  /** stages.json agentSlots disagree with HARNESS_AGENT_SLOT_* in harness.env. */
  agentSlotMismatch: {
    stages: { min: number; max: number };
    env: { min: number; max: number };
  } | null;
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

export function compareHarnessToTemplate(repoPath: string): HarnessDriftResult {
  const resolved = path.resolve(repoPath);
  const manifest = readManifest(resolved);
  const profile: HarnessProfile = manifest?.profile ?? 'default';
  const harnessDir = getHarnessDir(resolved);
  const projectName = path.basename(resolved).toLowerCase().replace(/[^a-z0-9]/g, '_');
  // Composed bundle set (shared kernel → runtime bundle → overlay). Drift keeps
  // comparing top-level files only, matching the pre-composition behavior.
  const composed = composeProfileTemplateMap(profile);
  const templateFiles = [...composed.keys()].filter((f) => !f.includes('/')).sort();

  const missing: string[] = [];
  const checksumMismatch: string[] = [];
  const extra: string[] = [];
  const unchanged: string[] = [];

  for (const file of templateFiles) {
    const harnessFile = harnessFileForTemplate(file);
    const templatePath = composed.get(file)!.sourcePath;
    const harnessPath = path.join(harnessDir, harnessFile);
    let templateContent = fs.readFileSync(templatePath, 'utf8');
    if (file === 'harness.env') {
      templateContent = substituteProjectName(templateContent, projectName);
    }

    if (!fs.existsSync(harnessPath)) {
      missing.push(harnessFile);
      continue;
    }

    const harnessChecksum = computeFileChecksum(fs.readFileSync(harnessPath, 'utf8'));
    const templateChecksum = computeFileChecksum(templateContent);
    if (harnessChecksum === templateChecksum) {
      unchanged.push(harnessFile);
    } else {
      checksumMismatch.push(harnessFile);
    }
  }

  if (fs.existsSync(harnessDir)) {
    for (const file of fs.readdirSync(harnessDir)) {
      const full = path.join(harnessDir, file);
      if (!fs.statSync(full).isFile()) continue;
      if (
        file === 'manifest.json' ||
        file === 'plugins.json' ||
        file.startsWith('ADAPT-PROMPT')
      ) {
        continue;
      }
      if (profile === 'cli' && CLI_EXPECTED_ABSENT.has(file)) {
        extra.push(file);
      } else if (isExpectedHarnessOnlyFile(file, templateFiles)) {
        continue;
      } else if (
        !templateFiles.includes(file) &&
        !templateFiles.includes(templateFileForHarness(file))
      ) {
        extra.push(file);
      }
    }
  }

  const harnessEnv = readHarnessEnv(resolved);
  const missingPortVars = missingPortDocumentationVars(profile, harnessEnv);
  const agentSlotMismatch = detectAgentSlotEnvMismatch(resolved);

  return {
    missing,
    checksumMismatch,
    extra,
    unchanged,
    missingPortVars,
    agentSlotMismatch,
  };
}
