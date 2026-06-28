import * as fs from 'fs';
import * as path from 'path';
import { copyDirRecursive } from '../utils/file-ops';
import { info, success } from '../utils/logging';
import { resolveTemplatesDir } from '../utils/paths';
import { createManifest, writeManifest, DEFAULT_HAR_DIR } from './manifest';

export type HarnessProfile = 'default' | 'cli';

const PROFILE_DIRS: Record<HarnessProfile, string> = {
  default: 'har-boilerplate',
  cli: 'har-boilerplate-cli',
};

export { DEFAULT_HAR_DIR };

export interface ScaffoldOptions {
  force?: boolean;
  profile?: HarnessProfile;
}

export interface ScaffoldResult {
  harnessDir: string;
  projectName: string;
}

export function scaffoldHarnessBoilerplate(
  repoPath: string,
  options: ScaffoldOptions = {},
): ScaffoldResult {
  const harnessDir = path.join(repoPath, DEFAULT_HAR_DIR);
  const projectName = path.basename(repoPath).toLowerCase().replace(/[^a-z0-9]/g, '_');
  const profile = options.profile ?? 'default';
  const boilerplateDir = path.join(resolveTemplatesDir(), PROFILE_DIRS[profile]);

  if (fs.existsSync(harnessDir) && !options.force) {
    throw new Error(
      '.har/ already exists. Use --force to overwrite or run "har env maintain" to update in place.',
    );
  }

  if (!fs.existsSync(boilerplateDir)) {
    throw new Error(`Boilerplate template not found at ${boilerplateDir}`);
  }

  if (options.force && fs.existsSync(harnessDir)) {
    fs.rmSync(harnessDir, { recursive: true, force: true });
  }

  copyDirRecursive(boilerplateDir, harnessDir);

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
      ? 'CLI profile copied — no Docker/PM2. Customize verify.sh if npm scripts differ.'
      : 'Boilerplate copied — awaiting LLM adaptation.',
  );
  writeManifest(repoPath, manifest);

  success(`Copied harness boilerplate to .har/ (profile: ${profile})`);
  info(`Project name: ${projectName}`);

  return { harnessDir, projectName };
}

export function finalizeHarness(
  repoPath: string,
  adaptationSummary: string,
  stack?: { language?: string; packageManager?: string; database?: string },
): void {
  const manifest = createManifest(repoPath, adaptationSummary, stack);
  writeManifest(repoPath, manifest);
  success('Harness adaptation complete.');
}
