import * as fs from 'fs';
import * as path from 'path';
import { writeFileSafe } from '../utils/file-ops';
import { resolveTemplateFile } from '../utils/paths';
import { getHarnessDir } from './manifest';
import type { HarnessProfile } from './generator';

export const ADAPTATION_PROMPT_FILE = 'ADAPT-PROMPT.md';

const PROFILE_HINTS: Record<HarnessProfile, string> = {
  default:
    'Web app profile — includes Docker, PM2, and full infra scripts. Adapt docker-compose, setup-infra, and ecosystem templates for this stack.',
  cli: 'CLI profile — no Docker/PM2. Focus on verify.sh, harness.env, and npm/script-based workflows. Remove or simplify infra files that do not apply.',
};

function loadTemplate(name: string): string {
  const filePath = resolveTemplateFile(name);
  if (!filePath) {
    throw new Error(`Adaptation prompt template not found: ${name}. Run npm run build.`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function applyProfilePlaceholders(content: string, profile: HarnessProfile): string {
  return content
    .replace(/\{\{PROFILE\}\}/g, profile)
    .replace(/\{\{PROFILE_HINT\}\}/g, PROFILE_HINTS[profile]);
}

export function buildInitAdaptationPrompt(_repoPath: string, profile: HarnessProfile): string {
  return applyProfilePlaceholders(loadTemplate('adaptation-prompt-init.md'), profile);
}

export function buildMaintainAdaptationPrompt(_repoPath: string): string {
  return loadTemplate('adaptation-prompt-maintain.md');
}

export function writeAdaptationPrompt(repoPath: string, content: string): string {
  const harnessDir = getHarnessDir(repoPath);
  const filePath = path.join(harnessDir, ADAPTATION_PROMPT_FILE);
  writeFileSafe(filePath, content);
  return filePath;
}

export function printAdaptationPrompt(content: string): void {
  const border = '─'.repeat(60);
  process.stderr.write('\n');
  process.stderr.write(`${border}\n`);
  for (const line of content.split('\n')) {
    process.stderr.write(`${line}\n`);
  }
  process.stderr.write(`${border}\n`);
  process.stderr.write('\n');
}
