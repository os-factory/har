import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { copyTextToClipboard } from '../utils/clipboard';
import { writeFileSafe } from '../utils/file-ops';
import { info, success, warn } from '../utils/logging';
import { resolveTemplateFile } from '../utils/paths';
import { getHarnessDir } from './manifest';
import type { HarnessProfile } from './generator';
import {
  formatMaintainBundlePromptSection,
  type MaintainBundleReport,
} from './maintain-bundle';

export const ADAPTATION_PROMPT_FILE = 'ADAPT-PROMPT.md';

// Profile hints describe harness mechanics only — keep them independent of optional
// verification plugins (Playwright, Semgrep, RocketSim, etc.). Plugin choice belongs
// in plugin docs and repo-specific AGENTS.md, not in these init prompt hints.
const PROFILE_HINTS: Record<HarnessProfile, string> = {
  default:
    'Web app profile (SaaS/full-stack) — Docker Compose for shared infra (HARNESS_INFRA_SERVICES), PM2 for the primary application only, git worktree per agent slot by default. Launch provisions toolchain via harness.env (HARNESS_ECOSYSTEM, HARNESS_INSTALL_CMD) and writes paths to .env.agent.<id>. Identify the primary app agents modify; run supporting services shared.',
  cli:
    'CLI/library profile (typical SWE-bench) — no PM2. Optional Docker Compose via HARNESS_INFRA_SERVICES. Git worktree by default. Launch provisions toolchain declaratively (HARNESS_ECOSYSTEM auto-detects common ecosystems); verify must use resolved tool paths from .env.agent.<id>, never hardcoded interpreter or package-manager paths.',
  ios:
    'iOS mobile app profile — xcodebuild + iOS Simulator in an isolated git worktree. Set HARNESS_XCODE_SCHEME, workspace/project, HARNESS_SIMULATOR_NAME, HARNESS_BUNDLE_ID. Launch writes XCODEBUILD_BIN to .env.agent.<id>; verify uses it.',
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

function askYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    process.stderr.write(`${question} `);
    rl.once('line', (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed === '' || /^y(es)?$/i.test(trimmed));
    });
  });
}

export interface OfferClipboardCopyOptions {
  /** When true, copy without prompting (still requires a TTY for OSC 52 fallback). */
  autoYes?: boolean;
  /** Where the prompt was saved, for the skip/fallback messages. */
  fileLabel?: string;
}

/**
 * Offer to copy the adaptation prompt so the user can paste it into a coding agent.
 * Interactive TTY: prompt [Y/n]. With autoYes: copy immediately. Non-TTY: skip.
 */
export async function offerAdaptationPromptClipboard(
  content: string,
  options: OfferClipboardCopyOptions = {},
): Promise<boolean> {
  const fileLabel = options.fileLabel ?? `.har/${ADAPTATION_PROMPT_FILE}`;
  const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  if (!interactive && !options.autoYes) {
    info(`Prompt also saved to ${fileLabel} (open or copy from there)`);
    return false;
  }

  let shouldCopy = options.autoYes === true;
  if (!shouldCopy && interactive) {
    shouldCopy = await askYesNo('Copy adaptation prompt to clipboard for your coding agent? [Y/n]');
  }
  if (!shouldCopy) {
    info(`Skipped clipboard copy — prompt is in ${fileLabel}`);
    return false;
  }

  const result = copyTextToClipboard(content);
  if (result.ok) {
    success(
      result.method === 'osc52'
        ? 'Copied adaptation prompt to clipboard (terminal OSC 52) — paste into your coding agent'
        : 'Copied adaptation prompt to clipboard — paste into your coding agent',
    );
    return true;
  }

  warn(`Could not copy to clipboard: ${result.detail}`);
  info(`Open ${fileLabel} and paste that into your coding agent instead`);
  return false;
}
