import * as fs from 'fs';
import * as path from 'path';
import { computeFileChecksum } from './manifest';
import { PLUGIN_IDS, PluginId, readPluginManifest } from './plugins';
import { readStageRegistry } from './stages';
import { resolveTemplatesDir } from '../utils/paths';

export interface PluginDriftResult {
  pluginId: PluginId;
  stageId: string;
  missing: string[];
  checksumMismatch: string[];
  unchanged: string[];
}

export interface PluginDriftAction {
  pluginId: PluginId;
  file: string;
  kind: 'missing' | 'drift';
  template: string;
  installed?: string;
  diff?: string;
  hint: string;
}

const PACKAGE_SECTIONS = ['scripts', 'devDependencies'] as const;

/** Detect shipped plugins whose stage id is registered in stages.json. */
export function detectInstalledPlugins(repoPath: string): PluginId[] {
  const resolved = path.resolve(repoPath);
  const registryPath = path.join(resolved, '.har', 'stages.json');
  if (!fs.existsSync(registryPath)) return [];

  const registry = readStageRegistry(resolved);
  const stageIds = new Set(registry.stages.map((stage) => stage.id));
  const installed: PluginId[] = [];

  for (const pluginId of PLUGIN_IDS) {
    const manifest = readPluginManifest(pluginId);
    if (stageIds.has(manifest.stageId)) {
      installed.push(pluginId);
    }
  }

  return installed;
}

function pluginTemplatePath(pluginId: PluginId, srcRel: string): string {
  return path.join(resolveTemplatesDir(), 'plugins', pluginId, srcRel);
}

function readBundledPluginFile(pluginId: PluginId, srcRel: string): string {
  return fs.readFileSync(pluginTemplatePath(pluginId, srcRel), 'utf8');
}

function listPluginDestPaths(pluginId: PluginId, repoPath: string): string[] {
  const manifest = readPluginManifest(pluginId);
  const paths = manifest.files.map((file) => file.dest);

  if (manifest.optionalFiles) {
    for (const file of manifest.optionalFiles) {
      if (fs.existsSync(path.join(repoPath, file.dest))) {
        paths.push(file.dest);
      }
    }
  }

  if (manifest.merge) {
    for (const dest of Object.keys(manifest.merge)) {
      if (!paths.includes(dest)) paths.push(dest);
    }
  }

  return paths.sort();
}

function manifestEntryForDest(pluginId: PluginId, dest: string) {
  const manifest = readPluginManifest(pluginId);
  return [...manifest.files, ...(manifest.optionalFiles ?? [])].find((file) => file.dest === dest);
}

function extractPackageFragment(pkgContent: string, fragmentContent: string): string {
  const pkg = JSON.parse(pkgContent) as Record<string, Record<string, string>>;
  const fragment = JSON.parse(fragmentContent) as Record<string, Record<string, string>>;
  const extracted: Record<string, Record<string, string>> = {};

  for (const section of PACKAGE_SECTIONS) {
    const incoming = fragment[section] ?? {};
    const existing = pkg[section] ?? {};
    const picked: Record<string, string> = {};
    for (const key of Object.keys(incoming)) {
      if (existing[key] !== undefined) picked[key] = existing[key];
    }
    if (Object.keys(picked).length > 0) extracted[section] = picked;
  }

  return `${JSON.stringify(extracted, null, 2)}\n`;
}

function pluginKeysMatch(installedContent: string, fragmentContent: string): boolean {
  const pkg = JSON.parse(installedContent) as Record<string, Record<string, string>>;
  const fragment = JSON.parse(fragmentContent) as Record<string, Record<string, string>>;

  for (const section of PACKAGE_SECTIONS) {
    const incoming = fragment[section] ?? {};
    const existing = pkg[section] ?? {};
    for (const [key, value] of Object.entries(incoming)) {
      if (existing[key] !== value) return false;
    }
  }

  return true;
}

export function readTemplatePluginFile(pluginId: PluginId, dest: string): string | null {
  const entry = manifestEntryForDest(pluginId, dest);
  if (entry) {
    return readBundledPluginFile(pluginId, entry.src);
  }

  const manifest = readPluginManifest(pluginId);
  const fragmentRel = manifest.merge?.[dest];
  if (fragmentRel) {
    const fragment = JSON.parse(readBundledPluginFile(pluginId, fragmentRel)) as Record<
      string,
      unknown
    >;
    return `${JSON.stringify(fragment, null, 2)}\n`;
  }

  return null;
}

export function readInstalledPluginFile(repoPath: string, pluginId: PluginId, dest: string): string | null {
  const installedPath = path.join(path.resolve(repoPath), dest);
  if (!fs.existsSync(installedPath)) return null;

  const content = fs.readFileSync(installedPath, 'utf8');
  const manifest = readPluginManifest(pluginId);
  const fragmentRel = manifest.merge?.[dest];
  if (fragmentRel) {
    return extractPackageFragment(content, readBundledPluginFile(pluginId, fragmentRel));
  }

  return content;
}

function pluginActionHint(pluginId: PluginId, dest: string, kind: 'missing' | 'drift'): string {
  if (kind === 'missing') {
    return `Copy/adapt from maintain/plugins/${pluginId}/templates/${dest} or run: har env add-plugin ${pluginId} --force`;
  }
  if (dest === 'package.json') {
    return `Merge plugin script/devDependency keys from maintain/plugins/${pluginId}/diffs/${dest}.diff or run: har env add-plugin ${pluginId} --force`;
  }
  return `Merge maintain/plugins/${pluginId}/diffs/${dest}.diff or run: har env add-plugin ${pluginId} --force`;
}

export function comparePluginToTemplate(repoPath: string, pluginId: PluginId): PluginDriftResult {
  const manifest = readPluginManifest(pluginId);
  const resolved = path.resolve(repoPath);
  const destPaths = listPluginDestPaths(pluginId, resolved);

  const missing: string[] = [];
  const checksumMismatch: string[] = [];
  const unchanged: string[] = [];

  for (const dest of destPaths) {
    const templateContent = readTemplatePluginFile(pluginId, dest);
    if (templateContent === null) continue;

    const installedContent = readInstalledPluginFile(resolved, pluginId, dest);
    if (installedContent === null) {
      missing.push(dest);
      continue;
    }

    if (dest === 'package.json') {
      const fragmentRel = manifest.merge?.[dest];
      const installedPath = path.join(resolved, dest);
      const installedRaw = fs.readFileSync(installedPath, 'utf8');
      if (
        fragmentRel &&
        pluginKeysMatch(installedRaw, readBundledPluginFile(pluginId, fragmentRel))
      ) {
        unchanged.push(dest);
      } else if (
        computeFileChecksum(installedContent) === computeFileChecksum(templateContent)
      ) {
        unchanged.push(dest);
      } else {
        checksumMismatch.push(dest);
      }
      continue;
    }

    if (computeFileChecksum(installedContent) === computeFileChecksum(templateContent)) {
      unchanged.push(dest);
    } else {
      checksumMismatch.push(dest);
    }
  }

  return {
    pluginId,
    stageId: manifest.stageId,
    missing,
    checksumMismatch,
    unchanged,
  };
}

export function compareInstalledPluginsToTemplate(repoPath: string): PluginDriftResult[] {
  return detectInstalledPlugins(repoPath).map((pluginId) =>
    comparePluginToTemplate(repoPath, pluginId),
  );
}

export function buildPluginDriftActions(
  repoPath: string,
  pluginDrift: PluginDriftResult[],
): PluginDriftAction[] {
  const actions: PluginDriftAction[] = [];

  for (const drift of pluginDrift) {
    for (const file of drift.missing) {
      actions.push({
        pluginId: drift.pluginId,
        file,
        kind: 'missing',
        template: `maintain/plugins/${drift.pluginId}/templates/${file}`,
        hint: pluginActionHint(drift.pluginId, file, 'missing'),
      });
    }
    for (const file of drift.checksumMismatch) {
      actions.push({
        pluginId: drift.pluginId,
        file,
        kind: 'drift',
        template: `maintain/plugins/${drift.pluginId}/templates/${file}`,
        installed: `maintain/plugins/${drift.pluginId}/installed/${file}`,
        diff: `maintain/plugins/${drift.pluginId}/diffs/${file}.diff`,
        hint: pluginActionHint(drift.pluginId, file, 'drift'),
      });
    }
  }

  return actions.sort(
    (a, b) => a.pluginId.localeCompare(b.pluginId) || a.file.localeCompare(b.file),
  );
}
