import * as fs from 'fs';
import * as path from 'path';
import { copyDirRecursive } from '../utils/file-ops';
import { info, success } from '../utils/logging';
import { resolveTemplateFile } from '../utils/paths';
import { ensureRootGitignorePatterns } from '../core/gitignore';
import { HARNESS_GITIGNORE_TEMPLATE, writeHarnessGitignore } from './gitignore-template';
import { createManifest, writeManifest, DEFAULT_HAR_DIR, readManifest } from './manifest';
import { ensurePluginLedgerScaffold } from './plugin-ledger';
import {
  HarnessProfile,
  composeProfileTemplateMap,
  readProfileManifest,
  resolveProfileBundleDir,
} from './profiles';
import { syncAgentSlotsToHarnessEnv } from './stages';

export type { HarnessProfile };
export { HARNESS_PROFILES } from './profiles';

export { DEFAULT_HAR_DIR };

export interface ScaffoldOptions {
  force?: boolean;
  profile?: HarnessProfile;
}

export interface ScaffoldResult {
  harnessDir: string;
  projectName: string;
  bundles: string[];
}

/**
 * @deprecated CLAUDE.md is created by handleInstructionFiles when Claude is selected.
 * Kept for tests that assert the template still resolves.
 */
export function scaffoldClaudeMd(repoPath: string, projectName: string, force: boolean): void {
  const templatePath = resolveTemplateFile('CLAUDE.md.template');
  if (!templatePath) return;

  const dest = path.join(repoPath, 'CLAUDE.md');
  if (fs.existsSync(dest) && !force) return;

  const displayName = projectName.replace(/_/g, ' ');
  const content = fs
    .readFileSync(templatePath, 'utf8')
    .replace(/__PROJECT_DISPLAY_NAME__/g, displayName);
  fs.writeFileSync(dest, content);
}

/**
 * Scaffold `.har/` by composing ordered profile bundles (later overwrites earlier).
 * Profile manifests live under `templates/profiles/<id>/profile.manifest.json`.
 */
export function scaffoldHarnessBoilerplate(
  repoPath: string,
  options: ScaffoldOptions = {},
): ScaffoldResult {
  const harnessDir = path.join(repoPath, DEFAULT_HAR_DIR);
  const projectName = path.basename(repoPath).toLowerCase().replace(/[^a-z0-9]/g, '_');
  const profile = options.profile ?? 'default';
  const profileManifest = readProfileManifest(profile);
  const bundleIds = profileManifest.bundles.map((b) => b.id);

  if (fs.existsSync(harnessDir) && !options.force) {
    throw new Error(
      '.har/ already exists. Use --force to overwrite or run "har env maintain" to update in place.',
    );
  }

  if (options.force && fs.existsSync(harnessDir)) {
    fs.rmSync(harnessDir, { recursive: true, force: true });
  }

  fs.mkdirSync(harnessDir, { recursive: true });

  // Compose ordered bundles into .har/ (later layers win on file conflict)
  for (const bundle of profileManifest.bundles) {
    const bundleDir = resolveProfileBundleDir(bundle);
    copyDirRecursive(bundleDir, harnessDir);
  }

  const gitignoreSource = composeProfileTemplateMap(profile).get(HARNESS_GITIGNORE_TEMPLATE);
  if (gitignoreSource) {
    writeHarnessGitignore(harnessDir, path.dirname(gitignoreSource.sourcePath));
  }

  syncAgentSlotsToHarnessEnv(repoPath);

  const harnessEnvPath = path.join(harnessDir, 'harness.env');
  if (fs.existsSync(harnessEnvPath)) {
    let content = fs.readFileSync(harnessEnvPath, 'utf8');
    content = content
      .replace(/__PROJECT_NAME__/g, projectName)
      .replace(/template___PROJECT_NAME__/g, `template_${projectName}`);
    fs.writeFileSync(harnessEnvPath, content);
  }

  const manifest = createManifest(
    repoPath,
    profile === 'cli'
      ? 'CLI profile copied — adapt with your coding agent (see .har/ADAPT-PROMPT.md).'
      : profile === 'ios'
        ? 'iOS profile copied — adapt with your coding agent (see .har/ADAPT-PROMPT.md).'
        : 'Boilerplate copied — adapt with your coding agent (see .har/ADAPT-PROMPT.md).',
    undefined,
    profile,
  );
  writeManifest(repoPath, manifest);

  ensurePluginLedgerScaffold(repoPath, { profile, bundles: bundleIds });

  // CLAUDE.md / AGENTS.md are installed by handleInstructionFiles during init/onboard
  // (AGENTS.md always; CLAUDE.md only when Claude is a confirmed target).
  ensureRootGitignorePatterns(repoPath);

  success(`Copied harness boilerplate to .har/ (profile: ${profile})`);
  info(`Project name: ${projectName}`);
  info(`Bundles: ${bundleIds.join(' → ')}`);

  return { harnessDir, projectName, bundles: bundleIds };
}

export function finalizeHarness(
  repoPath: string,
  adaptationSummary: string,
  stack?: { language?: string; packageManager?: string; database?: string },
): void {
  const existing = readManifest(repoPath);
  const manifest = createManifest(repoPath, adaptationSummary, stack, existing?.profile);
  writeManifest(repoPath, manifest);
  success('Harness adaptation complete.');
}
