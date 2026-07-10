import * as fs from 'fs';
import * as path from 'path';
import { writeFileSafe } from '../utils/file-ops';
import { resolveTemplateFile } from '../utils/paths';
import { getHarnessDir } from './manifest';
import type { HarnessProfile } from './generator';
import {
  formatMaintainBundlePromptSection,
  type MaintainBundleReport,
} from './maintain-bundle';

export const ADAPTATION_PROMPT_FILE = 'ADAPT-PROMPT.md';

const PROFILE_HINTS: Record<HarnessProfile, string> = {
  default:
    'Web app profile (SaaS/full-stack) — Docker Compose for shared infra (HARNESS_INFRA_SERVICES), PM2 for the primary application only, git worktree per agent slot by default. Launch provisions toolchain via harness.env (HARNESS_ECOSYSTEM, HARNESS_INSTALL_CMD) and writes paths to .env.agent.<id>. Identify the primary app agents modify; run supporting services shared.',
  cli:
    'CLI/library profile (typical SWE-bench) — no PM2. Optional Docker Compose via HARNESS_INFRA_SERVICES. Git worktree by default. Launch provisions toolchain declaratively (HARNESS_ECOSYSTEM auto-detects common ecosystems); verify must use resolved tool paths from .env.agent.<id>, never hardcoded interpreter or package-manager paths.',
  ios:
    'iOS mobile app profile — xcodebuild + iOS Simulator in an isolated git worktree. Set HARNESS_XCODE_SCHEME, workspace/project, HARNESS_SIMULATOR_NAME, HARNESS_BUNDLE_ID. Launch writes XCODEBUILD_BIN to .env.agent.<id>; verify uses it. Install RocketSim stage (har env add-stage rocketsim) for user-flow validation.',
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

export function buildMaintainAdaptationPrompt(
  _repoPath: string,
  bundleReport?: MaintainBundleReport,
): string {
  const template = loadTemplate('adaptation-prompt-maintain.md');
  const section = bundleReport
    ? formatMaintainBundlePromptSection(bundleReport)
    : [
        '## Step 0 — Read the maintenance bundle',
        '',
        'Open `.har/maintain/README.md` and `.har/maintain/drift-report.json`.',
        'All reference templates are under `.har/maintain/templates/`.',
        'Do **not** read files from the globally installed har package.',
        '',
      ].join('\n');
  return template.replace('{{MAINTAIN_BUNDLE_SECTION}}', section);
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
