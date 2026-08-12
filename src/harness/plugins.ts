import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { info, success, warn } from '../utils/logging';
import { resolveTemplatesDir } from '../utils/paths';
import { harnessExists } from './parser';
import { HarnessStageRegistry, HarnessStageSchema } from './schema';
import { readStageRegistry, writeStageRegistry } from './stages';

export const PLUGIN_IDS = ['playwright', 'rocketsim', 'kerno', 'gitleaks', 'trivy'] as const;
export type PluginId = (typeof PLUGIN_IDS)[number];

/** @deprecated Use PLUGIN_IDS */
export const STAGE_TEMPLATE_IDS = PLUGIN_IDS;
/** @deprecated Use PluginId */
export type StageTemplateId = PluginId;

const PluginManifestFileSchema = z.object({
  src: z.string().min(1),
  dest: z.string().min(1),
  executable: z.boolean().optional(),
  skipFlag: z.string().optional(),
});

export const PluginManifestSchema = z.object({
  id: z.enum(PLUGIN_IDS),
  stageId: z.string().min(1),
  verificationStages: z.array(z.string().min(1)).min(1),
  stage: z.record(z.unknown()),
  files: z.array(PluginManifestFileSchema).min(1),
  optionalFiles: z.array(PluginManifestFileSchema).optional(),
  merge: z.record(z.string()).optional(),
  nextSteps: z.array(z.string().min(1)).min(1),
  docsPath: z.string().min(1),
});

/** @deprecated Use PluginManifestSchema */
export const StageTemplateManifestSchema = PluginManifestSchema;

type PluginManifestFile = z.infer<typeof PluginManifestFileSchema>;
type PluginManifest = z.infer<typeof PluginManifestSchema>;

export interface ApplyPluginOptions {
  force?: boolean;
  skipCi?: boolean;
}

/** @deprecated Use ApplyPluginOptions */
export type ApplyStageTemplateOptions = ApplyPluginOptions;

export interface ApplyPluginResult {
  pluginId: PluginId;
  stageId: string;
  filesWritten: string[];
  warnings: string[];
  nextSteps: string[];
  docsPath: string;
}

/** @deprecated Use ApplyPluginResult — `templateId` mirrors `pluginId` */
export interface ApplyStageTemplateResult {
  templateId: PluginId;
  stageId: string;
  filesWritten: string[];
  warnings: string[];
  nextSteps: string[];
  docsPath: string;
}

function resolvePluginDir(pluginId: PluginId): string {
  const dir = path.join(resolveTemplatesDir(), 'plugins', pluginId);
  if (!fs.existsSync(dir)) {
    throw new Error(`Plugin not found: ${pluginId}. Run npm run build.`);
  }
  return dir;
}

export function readPluginManifest(pluginId: PluginId): PluginManifest {
  const manifestPath = path.join(resolvePluginDir(pluginId), 'template.manifest.json');
  const parsed = PluginManifestSchema.safeParse(
    JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
  );
  if (!parsed.success) {
    throw new Error(`Invalid plugin manifest for ${pluginId}: ${parsed.error.message}`);
  }
  if (parsed.data.id !== pluginId) {
    throw new Error(`Plugin manifest id mismatch: expected ${pluginId}, got ${parsed.data.id}`);
  }
  return parsed.data;
}

/** @deprecated Use readPluginManifest */
export function readTemplateManifest(pluginId: PluginId): PluginManifest {
  return readPluginManifest(pluginId);
}

function ensureParentDir(filePath: string): void {
  const parent = path.dirname(filePath);
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true });
  }
}

function copyPluginFile(
  pluginDir: string,
  file: PluginManifestFile,
  repoPath: string,
  force: boolean,
): { written: boolean; path: string } {
  const srcPath = path.join(pluginDir, file.src);
  const destPath = path.join(repoPath, file.dest);

  if (!fs.existsSync(srcPath)) {
    throw new Error(`Plugin file missing: ${file.src}`);
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
  pluginDir: string,
  fragmentRelPath: string,
  warnings: string[],
): void {
  const packagePath = path.join(repoPath, 'package.json');
  if (!fs.existsSync(packagePath)) {
    throw new Error('No package.json in repo root. Add one before applying this plugin.');
  }

  const fragmentPath = path.join(pluginDir, fragmentRelPath);
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
  manifest: PluginManifest,
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
  for (const id of manifest.verificationStages) {
    if (!verificationStages.includes(id)) {
      verificationStages.push(id);
    }
  }

  const verifyIdx = stages.findIndex((s) => s.id === 'verify');
  if (verifyIdx >= 0) {
    stages[verifyIdx] = {
      ...stages[verifyIdx],
      description: `Verification pipeline (quick smoke by default; --full runs the registry's verificationStages: ${verificationStages.join(', ')})`,
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

export function applyPlugin(
  repoPath: string,
  pluginId: PluginId,
  options: ApplyPluginOptions = {},
): ApplyPluginResult {
  const resolved = path.resolve(repoPath);
  const force = options.force ?? false;
  const warnings: string[] = [];
  const filesWritten: string[] = [];

  assertHarnessPresent(resolved);

  const manifest = readPluginManifest(pluginId);
  assertStageNotPresent(resolved, manifest.stageId, force);

  const pluginDir = resolvePluginDir(pluginId);

  for (const file of manifest.files) {
    const result = copyPluginFile(pluginDir, file, resolved, force);
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
      const result = copyPluginFile(pluginDir, file, resolved, force);
      if (result.written) {
        filesWritten.push(result.path);
      }
    }
  }

  if (manifest.merge) {
    for (const fragmentRel of Object.values(manifest.merge)) {
      mergePackageJson(resolved, pluginDir, fragmentRel, warnings);
      filesWritten.push('package.json');
    }
  }

  patchStageRegistry(resolved, manifest, force);

  success(`Applied plugin: ${pluginId}`);
  info(`Registered stage: ${manifest.stageId}`);
  for (const file of filesWritten) {
    info(`  + ${file}`);
  }
  for (const warning of warnings) {
    warn(`  ⚠ ${warning}`);
  }

  return {
    pluginId,
    stageId: manifest.stageId,
    filesWritten,
    warnings,
    nextSteps: manifest.nextSteps,
    docsPath: manifest.docsPath,
  };
}

/** @deprecated Use applyPlugin */
export function applyStageTemplate(
  repoPath: string,
  pluginId: PluginId,
  options: ApplyPluginOptions = {},
): ApplyStageTemplateResult {
  const result = applyPlugin(repoPath, pluginId, options);
  return {
    templateId: result.pluginId,
    stageId: result.stageId,
    filesWritten: result.filesWritten,
    warnings: result.warnings,
    nextSteps: result.nextSteps,
    docsPath: result.docsPath,
  };
}

export function listPluginIds(): PluginId[] {
  const root = path.join(resolveTemplatesDir(), 'plugins');
  if (!fs.existsSync(root)) return [...PLUGIN_IDS];

  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name): name is PluginId => (PLUGIN_IDS as readonly string[]).includes(name));
}

/** @deprecated Use listPluginIds */
export function listStageTemplateIds(): PluginId[] {
  return listPluginIds();
}
