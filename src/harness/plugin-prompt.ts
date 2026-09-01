import * as fs from 'fs';
import * as path from 'path';
import { resolveTemplateFile } from '../utils/paths';
import { writeFileSafe } from '../utils/file-ops';
import { nodePackageManager } from '../runtime/node-pm';
import { getHarnessDir } from './manifest';
import { readHarnessEnv } from './env';
import type { ApplyPluginResult } from './plugins';

/** Per-plugin adaptation prompt, sibling of ADAPT-PROMPT.md / MIGRATE-PROMPT.md. */
export function pluginAdaptationPromptFile(pluginId: string): string {
  return `ADAPT-PROMPT-${pluginId}.md`;
}

function loadTemplate(): string {
  const filePath = resolveTemplateFile('adaptation-prompt-plugin.md');
  if (!filePath) {
    throw new Error(
      'Plugin adaptation prompt template not found: adaptation-prompt-plugin.md. Run npm run build.',
    );
  }
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * The install command this repo actually uses: an explicit HARNESS_INSTALL_CMD
 * wins, then the detected package manager (packageManager field / lockfile /
 * what is installed). Never hardcodes npm.
 */
export function resolveInstallCommand(repoPath: string): string {
  const env = readHarnessEnv(repoPath);
  if (env.HARNESS_INSTALL_CMD) return env.HARNESS_INSTALL_CMD;
  return `${nodePackageManager(repoPath, env)} install`;
}

/** A bare package-manager install line ("npm install", "pnpm install", …). */
const BARE_INSTALL_RE = /^(npm|pnpm|yarn|bun)\s+install$/;

/**
 * Build the post-install adaptation prompt for a plugin from its apply result.
 * package.json merge ≠ installed dependencies — when the plugin merged a
 * fragment, the prompt opens with the repo's real install command and the
 * manifest's own bare "<pm> install" next step is dropped as redundant.
 */
export function buildPluginAdaptationPrompt(
  repoPath: string,
  result: ApplyPluginResult,
): string {
  const mergedPackageJson = result.filesWritten.includes('package.json');
  const installCmd = resolveInstallCommand(repoPath);

  const packageMergeNote = mergedPackageJson
    ? [
        '## Dependencies: merged is NOT installed',
        '',
        'The plugin merged new `devDependencies` into `package.json` — it did **not**',
        'install them. Install first or every later step fails:',
        '',
        '```bash',
        installCmd,
        '```',
      ].join('\n')
    : '## Dependencies\n\nThis plugin merged no package.json fragment — no dependency install is required.';

  const setupSteps = result.nextSteps
    .filter((step) => !(mergedPackageJson && BARE_INSTALL_RE.test(step.trim())))
    .map((step, i) => `${i + 1}. \`${step}\``)
    .join('\n');

  const filesWritten = result.filesWritten
    .filter((f) => f !== 'package.json')
    .map((f) => `   - \`${f}\``)
    .join('\n');

  return loadTemplate()
    .replace(/\{\{PLUGIN_ID\}\}/g, result.pluginId)
    .replace(/\{\{STAGE_IDS\}\}/g, result.stageIds.map((id) => `\`${id}\``).join(', '))
    .replace(/\{\{DOCS_PATH\}\}/g, result.docsPath)
    .replace('{{PACKAGE_MERGE_NOTE}}', packageMergeNote)
    .replace('{{PLUGIN_SETUP_STEPS}}', setupSteps || '_No plugin-specific setup steps declared._')
    .replace('{{FILES_WRITTEN}}', filesWritten || '   - _(no scaffolded files)_');
}

/** Write the prompt to .har/ADAPT-PROMPT-<plugin>.md; returns the absolute path. */
export function writePluginAdaptationPrompt(
  repoPath: string,
  pluginId: string,
  content: string,
): string {
  const filePath = path.join(getHarnessDir(repoPath), pluginAdaptationPromptFile(pluginId));
  writeFileSafe(filePath, content);
  return filePath;
}
