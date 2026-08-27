import * as fs from 'fs';
import * as path from 'path';
import { copyDirRecursive } from '../utils/file-ops';
import { info, success } from '../utils/logging';
import { ensureRootGitignorePatterns } from '../core/gitignore';
import { HARNESS_GITIGNORE_TEMPLATE, writeHarnessGitignore } from './gitignore-template';
import { computeTemplateChecksums } from './drift';
import { createManifest, writeManifest, DEFAULT_HAR_DIR, readManifest } from './manifest';
import { ensurePluginLedgerScaffold } from './plugin-ledger';
import {
  HarnessProfile,
  composeProfileTemplateMap,
  readProfileManifest,
  renderProfileDoc,
  resolveProfileBundleDir,
} from './profiles';
import { validateHarnessEnvSource } from './schema';
import { syncAgentSlotsToHarnessEnv } from './stages';
import { MANAGED_SHIM_FILES, substituteTemplateTokens } from './template-tokens';

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

  // Assembled docs (#236): README.md is rendered from
  // shared sections + profile blocks, not copied from a bundle.
  for (const docName of Object.keys(profileManifest.docs)) {
    fs.writeFileSync(path.join(harnessDir, docName), renderProfileDoc(profile, docName));
  }

  const gitignoreSource = composeProfileTemplateMap(profile).get(HARNESS_GITIGNORE_TEMPLATE);
  if (gitignoreSource) {
    writeHarnessGitignore(harnessDir, path.dirname(gitignoreSource.sourcePath));
  }

  syncAgentSlotsToHarnessEnv(repoPath);

  // Render template tokens into the generated files: harness.env gets the
  // project name; the runtime shims get the pinned package version (#235).
  for (const shim of MANAGED_SHIM_FILES) {
    const shimPath = path.join(harnessDir, shim);
    if (!fs.existsSync(shimPath)) continue;
    const rendered = substituteTemplateTokens(fs.readFileSync(shimPath, 'utf8'), projectName);
    fs.writeFileSync(shimPath, rendered);
  }

  const harnessEnvPath = path.join(harnessDir, 'harness.env');
  if (fs.existsSync(harnessEnvPath)) {
    let content = fs.readFileSync(harnessEnvPath, 'utf8');
    content = substituteTemplateTokens(content, projectName);
    fs.writeFileSync(harnessEnvPath, content);

    // The generated file must honor the 1.0 contract: pure KEY=value config
    // that validates against HarnessEnvSchema. A failure here is template
    // drift in the package itself, not a user error.
    const validation = validateHarnessEnvSource(content);
    if (!validation.ok) {
      const details = validation.issues
        .filter((i) => i.severity === 'error')
        .map((i) => (i.line !== undefined ? `line ${i.line}: ${i.message}` : i.message))
        .join('\n  ');
      throw new Error(`Generated harness.env violates HarnessEnvSchema:\n  ${details}`);
    }
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
    computeTemplateChecksums(repoPath, profile),
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
  const profile = existing?.profile ?? 'default';
  const manifest = createManifest(
    repoPath,
    adaptationSummary,
    stack,
    existing?.profile,
    computeTemplateChecksums(repoPath, profile),
  );
  writeManifest(repoPath, manifest);
  success('Harness adaptation complete.');
}
