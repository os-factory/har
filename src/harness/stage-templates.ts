import * as fs from 'fs';
import * as path from 'path';
import { info, success, warn } from '../utils/logging';
import { resolveTemplatesDir } from '../utils/paths';
import { harnessExists } from './parser';
import { HarnessStageRegistry, HarnessStageSchema } from './schema';
import { readStageRegistry, writeStageRegistry } from './stages';

export const STAGE_TEMPLATE_IDS = ['playwright'] as const;
export type StageTemplateId = (typeof STAGE_TEMPLATE_IDS)[number];

interface TemplateManifestFile {
  src: string;
  dest: string;
  executable?: boolean;
  skipFlag?: string;
}

interface TemplateManifest {
  id: StageTemplateId;
  stageId: string;
  verificationStageId?: string;
  verificationStages?: string[];
  stage: Record<string, unknown>;
  files: TemplateManifestFile[];
  optionalFiles?: TemplateManifestFile[];
  merge?: Record<string, string>;
}

export interface ApplyStageTemplateOptions {
  force?: boolean;
  skipCi?: boolean;
}

export interface ApplyStageTemplateResult {
  templateId: StageTemplateId;
  stageId: string;
  filesWritten: string[];
  warnings: string[];
  nextSteps: string[];
}

function resolveTemplateDir(templateId: StageTemplateId): string {
  const dir = path.join(resolveTemplatesDir(), 'stage-templates', templateId);
  if (!fs.existsSync(dir)) {
    throw new Error(`Stage template not found: ${templateId}. Run npm run build.`);
  }
  return dir;
}

function readTemplateManifest(templateId: StageTemplateId): TemplateManifest {
  const manifestPath = path.join(resolveTemplateDir(templateId), 'template.manifest.json');
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as TemplateManifest;
  if (raw.id !== templateId) {
    throw new Error(`Template manifest id mismatch: expected ${templateId}, got ${raw.id}`);
  }
  return raw;
}

function ensureParentDir(filePath: string): void {
  const parent = path.dirname(filePath);
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true });
  }
}

function copyTemplateFile(
  templateDir: string,
  file: TemplateManifestFile,
  repoPath: string,
  force: boolean,
): { written: boolean; path: string } {
  const srcPath = path.join(templateDir, file.src);
  const destPath = path.join(repoPath, file.dest);

  if (!fs.existsSync(srcPath)) {
    throw new Error(`Template file missing: ${file.src}`);
  }

  if (fs.existsSync(destPath) && !force) {
    throw new Error(
      `File already exists: ${file.dest}. Use --force to overwrite or remove it first.`,
    );
  }

  ensureParentDir(destPath);
  fs.copyFileSync(srcPath, destPath);
  if (file.executable) {
    fs.chmodSync(destPath, 0o755);
  }

  return { written: true, path: file.dest };
}

function mergePackageJson(
  repoPath: string,
  templateDir: string,
  fragmentRelPath: string,
  warnings: string[],
): void {
  const packagePath = path.join(repoPath, 'package.json');
  if (!fs.existsSync(packagePath)) {
    throw new Error('No package.json in repo root. Add one before applying the Playwright template.');
  }

  const fragmentPath = path.join(templateDir, fragmentRelPath);
  if (!fs.existsSync(fragmentPath)) {
    throw new Error(`Package fragment missing: ${fragmentRelPath}`);
  }

  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as Record<string, unknown>;
  const fragment = JSON.parse(fs.readFileSync(fragmentPath, 'utf8')) as Record<string, unknown>;

  for (const section of ['scripts', 'devDependencies'] as const) {
    const existing = (pkg[section] ?? {}) as Record<string, string>;
    const incoming = (fragment[section] ?? {}) as Record<string, string>;
    for (const [key, value] of Object.entries(incoming)) {
      if (existing[key] !== undefined && existing[key] !== value) {
        warnings.push(`package.json ${section}.${key} already set — kept existing value`);
        continue;
      }
      existing[key] = value;
    }
    pkg[section] = existing;
  }

  fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
}

function patchStageRegistry(
  repoPath: string,
  manifest: TemplateManifest,
  force: boolean,
): void {
  const registry = readStageRegistry(repoPath);
  const stage = HarnessStageSchema.parse(manifest.stage);
  const existing = registry.stages.find((s) => s.id === stage.id);

  if (existing && !force) {
    throw new Error(
      `Stage "${stage.id}" already registered in .har/stages.json. Use --force to replace.`,
    );
  }

  const stages = existing
    ? registry.stages.map((s) => (s.id === stage.id ? stage : s))
    : [...registry.stages, stage];

  const verificationStages = [...(registry.verificationStages ?? [])];
  const toAdd =
    manifest.verificationStages ??
    (manifest.verificationStageId ? [manifest.verificationStageId] : [manifest.stageId]);
  for (const id of toAdd) {
    if (!verificationStages.includes(id)) {
      verificationStages.push(id);
    }
  }

  const verifyIdx = stages.findIndex((s) => s.id === 'verify');
  if (verifyIdx >= 0) {
    stages[verifyIdx] = {
      ...stages[verifyIdx],
      description:
        'Verification pipeline (quick by default; --full adds lint and browser-e2e when installed)',
      acceptsArgs: ['--full'],
    };
  }

  const updated: HarnessStageRegistry = {
    ...registry,
    stages,
    verificationStages,
  };

  writeStageRegistry(repoPath, updated);
}

function assertHarnessPresent(repoPath: string): void {
  if (!harnessExists(repoPath)) {
    throw new Error('No .har/ harness found. Run "har env init" first.');
  }
}

function assertStageNotPresent(repoPath: string, stageId: string, force?: boolean): void {
  if (force) return;

  const scriptPath = path.join(repoPath, '.har', 'stages', `${stageId}.sh`);
  if (fs.existsSync(scriptPath)) {
    throw new Error(
      `Stage script already exists: .har/stages/${stageId}.sh. Use --force to overwrite.`,
    );
  }

  const registry = readStageRegistry(repoPath);
  if (registry.stages.some((s) => s.id === stageId)) {
    throw new Error(
      `Stage "${stageId}" already registered in .har/stages.json. Use --force to replace.`,
    );
  }
}

export function applyStageTemplate(
  repoPath: string,
  templateId: StageTemplateId,
  options: ApplyStageTemplateOptions = {},
): ApplyStageTemplateResult {
  const resolved = path.resolve(repoPath);
  const force = options.force ?? false;
  const warnings: string[] = [];
  const filesWritten: string[] = [];

  assertHarnessPresent(resolved);

  const manifest = readTemplateManifest(templateId);
  assertStageNotPresent(resolved, manifest.stageId, force);

  const templateDir = resolveTemplateDir(templateId);

  for (const file of manifest.files) {
    const result = copyTemplateFile(templateDir, file, resolved, force);
    if (result.written) {
      filesWritten.push(result.path);
    }
  }

  if (manifest.optionalFiles) {
    for (const file of manifest.optionalFiles) {
      if (file.skipFlag === 'skipCi' && options.skipCi) {
        continue;
      }
      if (fs.existsSync(path.join(resolved, file.dest)) && !force) {
        warnings.push(`Skipped optional file (exists): ${file.dest}`);
        continue;
      }
      const result = copyTemplateFile(templateDir, file, resolved, force);
      if (result.written) {
        filesWritten.push(result.path);
      }
    }
  }

  if (manifest.merge) {
    for (const fragmentRel of Object.values(manifest.merge)) {
      mergePackageJson(resolved, templateDir, fragmentRel, warnings);
      filesWritten.push('package.json');
    }
  }

  patchStageRegistry(resolved, manifest, force);

  success(`Applied stage template: ${templateId}`);
  info(`Registered stage: ${manifest.stageId}`);
  for (const file of filesWritten) {
    info(`  + ${file}`);
  }
  for (const warning of warnings) {
    warn(`  ⚠ ${warning}`);
  }

  const nextSteps = [
    'npm install',
    'npx playwright install',
    './.har/launch.sh 1',
    `./.har/stages/${manifest.stageId}.sh 1`,
    'npx playwright show-report .har/artifacts/browser-e2e/playwright-report',
  ];

  return {
    templateId,
    stageId: manifest.stageId,
    filesWritten,
    warnings,
    nextSteps,
  };
}

export function listStageTemplateIds(): StageTemplateId[] {
  const root = path.join(resolveTemplatesDir(), 'stage-templates');
  if (!fs.existsSync(root)) return [...STAGE_TEMPLATE_IDS];

  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name): name is StageTemplateId =>
      (STAGE_TEMPLATE_IDS as readonly string[]).includes(name),
    );
}
