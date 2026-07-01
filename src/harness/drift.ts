import * as fs from 'fs';
import * as path from 'path';
import type { HarnessProfile } from './generator';
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
      if (templateFiles.includes(file)) continue;
      if (profile === 'cli' && CLI_EXPECTED_ABSENT.has(file)) {
        extra.push(file);
      } else if (!templateFiles.includes(file)) {
        extra.push(file);
      }
    }
  }

  const installed = manifest?.generatorVersion;
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
  };
}
