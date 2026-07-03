import * as fs from 'fs';
import * as path from 'path';
import { writeFileSafe } from '../utils/file-ops';
import { resolveTemplateFile } from '../utils/paths';
import { getHarnessDir } from './manifest';
import type { HarnessProfile } from './generator';

export const ADAPTATION_PROMPT_FILE = 'ADAPT-PROMPT.md';

const PROFILE_HINTS: Record<HarnessProfile, string> = {
  default:
    'Web app profile — Docker Compose for shared infra (HARNESS_INFRA_SERVICES), PM2 for the primary application only, git worktree per agent slot by default. Identify the primary app agents modify; run supporting services shared. Adapt docker-compose, setup-infra, and ecosystem templates for this stack.',
  cli:
    'CLI/library profile — no PM2. Optional Docker Compose via the `HARNESS_INFRA_SERVICES` list in harness.env. Agents work in an isolated git worktree by default (`--no-worktree` to use the repo root). Remove any leftover PM2/ecosystem files; keep docker-compose when shared services are enabled.',
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
