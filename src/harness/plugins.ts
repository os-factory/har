import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { info, success, warn } from '../utils/logging';
import { resolveTemplatesDir } from '../utils/paths';
import { harnessExists } from './parser';
import {
  cleanupResolvedPlugin,
  listBundledPluginIds,
  resolvePluginSource,
  type PluginSourceKind,
} from './plugin-resolve';
import { upsertPluginLedgerEntry } from './plugin-ledger';
import { buildPluginAdaptationPrompt, writePluginAdaptationPrompt } from './plugin-prompt';
import { HarnessStageRegistry, HarnessStageSchema } from './schema';
import { readStageRegistry, writeStageRegistry } from './stages';

/** Plugin id is a free-form slug discovered from manifests (no closed enum). */
export type PluginId = string;

/**
 * @deprecated Prefer `listPluginIds()` — snapshot of historically shipped ids for docs/tests.
 * Discovery is filesystem-based; this array is not authoritative.
 */
export const PLUGIN_IDS = [
  'playwright',
  'rocketsim',
  'kerno',
  'gitleaks',
  'trivy',
  'semgrep',
] as const;

/** @deprecated Use PLUGIN_IDS / listPluginIds() */
export const STAGE_TEMPLATE_IDS = PLUGIN_IDS;
/** @deprecated Use PluginId */
export type StageTemplateId = PluginId;

const PluginManifestFileSchema = z.object({
  src: z.string().min(1),
  dest: z.string().min(1),
  executable: z.boolean().optional(),
  skipFlag: z.string().optional(),
});

const PluginIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, 'Plugin id must be a slug (letters, digits, ._-)');

/**
 * Manifest for a HAR file-bundle plugin.
 * Prefer `stages` (one or more). Legacy single-stage form: `stage` + `stageId`.
 */
export const PluginManifestSchema = z
  .object({
    id: PluginIdSchema,
    /** @deprecated Prefer `stages` — primary stage id for single-stage plugins. */
    stageId: z.string().min(1).optional(),
    verificationStages: z.array(z.string().min(1)).min(1),
    /** @deprecated Prefer `stages` — single stage object. */
    stage: z.record(z.unknown()).optional(),
    /** One or more stages registered by this plugin. */
    stages: z.array(z.record(z.unknown())).optional(),
    files: z.array(PluginManifestFileSchema).min(1),
    optionalFiles: z.array(PluginManifestFileSchema).optional(),
    merge: z.record(z.string()).optional(),
    nextSteps: z.array(z.string().min(1)).min(1),
    docsPath: z.string().min(1),
  })
  .superRefine((data, ctx) => {
    const hasStages = Array.isArray(data.stages) && data.stages.length > 0;
    const hasLegacy = data.stage !== undefined && data.stageId !== undefined;
    if (!hasStages && !hasLegacy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Plugin manifest requires `stages` (preferred) or legacy `stage` + `stageId`',
      });
    }
  });

/** @deprecated Use PluginManifestSchema */
export const StageTemplateManifestSchema = PluginManifestSchema;

type PluginManifestFile = z.infer<typeof PluginManifestFileSchema>;
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export interface ApplyPluginOptions {
  force?: boolean;
  skipCi?: boolean;
  /**
   * Install spec when different from the resolved plugin id
   * (path, npm package, git URL). Defaults to plugin id / bundled.
   */
  spec?: string;
}

/** @deprecated Use ApplyPluginOptions */
export type ApplyStageTemplateOptions = ApplyPluginOptions;

export interface ApplyPluginResult {
  pluginId: PluginId;
  /** Primary stage id (first registered). */
  stageId: string;
  /** All stage ids registered by this plugin. */
  stageIds: string[];
  filesWritten: string[];
  warnings: string[];
  nextSteps: string[];
  docsPath: string;
  source: PluginSourceKind;
  /** Repo-relative path of the generated adaptation prompt (#195). */
  adaptPromptPath: string;
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

export function normalizePluginStages(manifest: PluginManifest): Array<z.infer<typeof HarnessStageSchema>> {
  if (manifest.stages && manifest.stages.length > 0) {
    return manifest.stages.map((s) => HarnessStageSchema.parse(s));
  }
  if (manifest.stage) {
    return [HarnessStageSchema.parse(manifest.stage)];
  }
  throw new Error(`Plugin ${manifest.id} has no stages`);
}

export function primaryStageId(manifest: PluginManifest): string {
  const stages = normalizePluginStages(manifest);
  return manifest.stageId ?? stages[0].id;
}

function resolveBundledPluginDir(pluginId: PluginId): string {
  const dir = path.join(resolveTemplatesDir(), 'plugins', pluginId);
  if (!fs.existsSync(dir)) {
    throw new Error(`Plugin not found: ${pluginId}. Run npm run build.`);
  }
  return dir;
}

export function readPluginManifestFromDir(pluginDir: string, expectedId?: string): PluginManifest {
  const manifestPath = path.join(pluginDir, 'template.manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No template.manifest.json in ${pluginDir}`);
  }
  const parsed = PluginManifestSchema.safeParse(
    JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
  );
  if (!parsed.success) {
    throw new Error(`Invalid plugin manifest: ${parsed.error.message}`);
  }
  if (expectedId && parsed.data.id !== expectedId) {
    throw new Error(`Plugin manifest id mismatch: expected ${expectedId}, got ${parsed.data.id}`);
  }
  return parsed.data;
}

export function readPluginManifest(pluginId: PluginId): PluginManifest {
  return readPluginManifestFromDir(resolveBundledPluginDir(pluginId), pluginId);
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
  stages: Array<z.infer<typeof HarnessStageSchema>>,
  verificationStageIds: string[],
  force: boolean,
): void {
  const registry = readStageRegistry(repoPath);
  let nextStages = [...registry.stages];

  for (const stage of stages) {
    const existing = nextStages.find((s) => s.id === stage.id);
    if (existing && !force) {
      throw new Error(
        `Stage "${stage.id}" already registered in .har/stages.json. Use --force to replace.`,
      );
    }
    nextStages = existing
      ? nextStages.map((s) => (s.id === stage.id ? stage : s))
      : [...nextStages, stage];
  }

  const verificationStages = [...(registry.verificationStages ?? [])];
  for (const id of verificationStageIds) {
    if (!verificationStages.includes(id)) {
      verificationStages.push(id);
    }
  }

  const updated: HarnessStageRegistry = {
    ...registry,
    stages: nextStages,
    verificationStages,
  };

  writeStageRegistry(repoPath, updated);
}

function assertHarnessPresent(repoPath: string): void {
  if (!harnessExists(repoPath)) {
    throw new Error('No .har/ harness found. Run "har env init" first.');
  }
}

function assertStagesNotPresent(repoPath: string, stageIds: string[], force?: boolean): void {
  if (force) return;

  const registry = readStageRegistry(repoPath);
  for (const stageId of stageIds) {
    const scriptPath = path.join(repoPath, '.har', 'stages', `${stageId}.sh`);
    if (fs.existsSync(scriptPath)) {
      throw new Error(
        `Stage script already exists: .har/stages/${stageId}.sh. Use --force to overwrite.`,
      );
    }
    if (registry.stages.some((s) => s.id === stageId)) {
      throw new Error(
        `Stage "${stageId}" already registered in .har/stages.json. Use --force to replace.`,
      );
    }
  }
}

function applyPluginFromDir(
  repoPath: string,
  pluginDir: string,
  options: ApplyPluginOptions,
  meta: { source: PluginSourceKind; spec: string; version?: string },
): ApplyPluginResult {
  const resolved = path.resolve(repoPath);
  const force = options.force ?? false;
  const warnings: string[] = [];
  const filesWritten: string[] = [];

  assertHarnessPresent(resolved);

  const manifest = readPluginManifestFromDir(pluginDir);
  const stages = normalizePluginStages(manifest);
  const stageIds = stages.map((s) => s.id);
  assertStagesNotPresent(resolved, stageIds, force);

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

  patchStageRegistry(resolved, stages, manifest.verificationStages, force);

  upsertPluginLedgerEntry(resolved, {
    id: manifest.id,
    source: meta.source,
    spec: meta.spec,
    version: meta.version,
    stageIds,
    installedAt: new Date().toISOString(),
  });

  const primary = primaryStageId(manifest);

  // #195: the install is scaffolding only — leave the agent a structured
  // adaptation prompt (sibling of ADAPT-PROMPT.md), written only on success.
  const partialResult = {
    pluginId: manifest.id,
    stageId: primary,
    stageIds,
    filesWritten,
    warnings,
    nextSteps: manifest.nextSteps,
    docsPath: manifest.docsPath,
    source: meta.source,
  };
  const promptContent = buildPluginAdaptationPrompt(resolved, {
    ...partialResult,
    adaptPromptPath: '',
  });
  const promptAbsPath = writePluginAdaptationPrompt(resolved, manifest.id, promptContent);
  const adaptPromptPath = path.relative(resolved, promptAbsPath);

  success(`Applied plugin: ${manifest.id}`);
  info(`Registered stage(s): ${stageIds.join(', ')}`);
  for (const file of filesWritten) {
    info(`  + ${file}`);
  }
  info(`  + ${adaptPromptPath} (adaptation prompt for your coding agent)`);
  for (const warning of warnings) {
    warn(`  ⚠ ${warning}`);
  }

  return { ...partialResult, adaptPromptPath };
}

/**
 * Install a plugin by id (bundled), path, npm package, or git URL.
 */
export function applyPlugin(
  repoPath: string,
  pluginSpec: PluginId,
  options: ApplyPluginOptions = {},
): ApplyPluginResult {
  const spec = options.spec ?? pluginSpec;
  const source = resolvePluginSource(spec, repoPath);
  try {
    return applyPluginFromDir(repoPath, source.dir, options, {
      source: source.kind,
      spec: source.spec,
      version: source.version,
    });
  } finally {
    cleanupResolvedPlugin(source);
  }
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

/** Discover bundled plugin ids from templates/plugins/<id>/template.manifest.json */
export function listPluginIds(): PluginId[] {
  return listBundledPluginIds();
}

/** @deprecated Use listPluginIds */
export function listStageTemplateIds(): PluginId[] {
  return listPluginIds();
}

/** Whether `spec` is a known bundled plugin id (not path/npm/git). */
export function isBundledPluginId(spec: string): boolean {
  return listPluginIds().includes(spec);
}
