import * as fs from 'fs';
import * as path from 'path';
import { computeFileChecksum } from './manifest';
import { readPluginLedger } from './plugin-ledger';
import {
  listPluginIds,
  PluginId,
  PluginManifest,
  primaryStageId,
  readPluginManifest,
  readPluginManifestFromDir,
} from './plugins';
import { LOCAL_PLUGINS_DIR } from './plugin-resolve';
import { readStageRegistry } from './stages';
import { resolveTemplatesDir } from '../utils/paths';

export interface PluginDriftResult {
  pluginId: PluginId;
  stageId: string;
  /** Baseline the installed files are compared against. Local plugins are project-owned. */
  baseline: 'bundled' | 'local';
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

/**
 * Detect installed plugins from `.har/plugins.json` when present,
 * otherwise fall back to matching bundled plugin stage ids in stages.json.
 */
export function detectInstalledPlugins(repoPath: string): PluginId[] {
  const resolved = path.resolve(repoPath);
  const ledger = readPluginLedger(resolved);
  if (ledger && ledger.plugins.length > 0) {
    return ledger.plugins.map((p) => p.id).sort();
  }

  const registryPath = path.join(resolved, '.har', 'stages.json');
  if (!fs.existsSync(registryPath)) return [];

  const registry = readStageRegistry(resolved);
  const stageIds = new Set(registry.stages.map((stage) => stage.id));
  const installed: PluginId[] = [];

  for (const pluginId of listPluginIds()) {
    try {
      const manifest = readPluginManifest(pluginId);
      const primary = primaryStageId(manifest);
      if (stageIds.has(primary)) {
        installed.push(pluginId);
      }
    } catch {
      // Skip malformed/missing bundled manifests
    }
  }

  return installed.sort();
}

interface PluginBaseline {
  kind: 'bundled' | 'local';
  dir: string;
  manifest: PluginManifest;
}

/**
 * Resolve the baseline the installed plugin files are compared against:
 * `.har/plugins/<id>/` for local (project-owned) plugins per the ledger,
 * the bundled template dir otherwise. npm/git/path plugins have no stable
 * local baseline and are skipped by drift.
 */
function resolvePluginBaseline(repoPath: string, pluginId: PluginId): PluginBaseline | null {
  const resolved = path.resolve(repoPath);
  const ledger = readPluginLedger(resolved);
  const entry = ledger?.plugins.find((p) => p.id === pluginId);
  if (entry?.source === 'local') {
    const localDir = path.join(resolved, LOCAL_PLUGINS_DIR, pluginId);
    if (fs.existsSync(path.join(localDir, 'template.manifest.json'))) {
      return { kind: 'local', dir: localDir, manifest: readPluginManifestFromDir(localDir) };
    }
    return null;
  }
  const bundled = path.join(resolveTemplatesDir(), 'plugins', pluginId);
  if (fs.existsSync(path.join(bundled, 'template.manifest.json'))) {
    return { kind: 'bundled', dir: bundled, manifest: readPluginManifestFromDir(bundled) };
  }
  return null;
}

function requireBaseline(repoPath: string, pluginId: PluginId): PluginBaseline {
  const baseline = resolvePluginBaseline(repoPath, pluginId);
  if (!baseline) {
    throw new Error(`No drift baseline for plugin ${pluginId} (not bundled or local)`);
  }
  return baseline;
}

function readBaselineFile(baseline: PluginBaseline, srcRel: string): string {
  return fs.readFileSync(path.join(baseline.dir, srcRel), 'utf8');
}

function listPluginDestPaths(baseline: PluginBaseline, repoPath: string): string[] {
  const manifest = baseline.manifest;
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

function manifestEntryForDest(baseline: PluginBaseline, dest: string) {
  const manifest = baseline.manifest;
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

export function readTemplatePluginFile(
  repoPath: string,
  pluginId: PluginId,
  dest: string,
): string | null {
  const baseline = requireBaseline(repoPath, pluginId);
  const entry = manifestEntryForDest(baseline, dest);
  if (entry) {
    return readBaselineFile(baseline, entry.src);
  }

  const fragmentRel = baseline.manifest.merge?.[dest];
  if (fragmentRel) {
    const fragment = JSON.parse(readBaselineFile(baseline, fragmentRel)) as Record<
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
  const baseline = requireBaseline(repoPath, pluginId);
  const fragmentRel = baseline.manifest.merge?.[dest];
  if (fragmentRel) {
    return extractPackageFragment(content, readBaselineFile(baseline, fragmentRel));
  }

  return content;
}

function pluginActionHint(
  pluginId: PluginId,
  dest: string,
  kind: 'missing' | 'drift',
  baseline: 'bundled' | 'local',
): string {
  if (baseline === 'local') {
    // Project-owned: the source of truth is .har/plugins/<id>/ in this repo.
    if (kind === 'missing') {
      return `Reinstall from the project-owned source: har env add-plugin ${pluginId} --force (source: ${LOCAL_PLUGINS_DIR}/${pluginId}/)`;
    }
    return `Installed copy diverged from ${LOCAL_PLUGINS_DIR}/${pluginId}/ — update the plugin source or reinstall: har env add-plugin ${pluginId} --force`;
  }
  if (kind === 'missing') {
    return `Copy/adapt from maintain/plugins/${pluginId}/templates/${dest} or run: har env add-plugin ${pluginId} --force`;
  }
  if (dest === 'package.json') {
    return `Merge plugin script/devDependency keys from maintain/plugins/${pluginId}/diffs/${dest}.diff or run: har env add-plugin ${pluginId} --force`;
  }
  return `Merge maintain/plugins/${pluginId}/diffs/${dest}.diff or run: har env add-plugin ${pluginId} --force`;
}

export function comparePluginToTemplate(repoPath: string, pluginId: PluginId): PluginDriftResult {
  const resolved = path.resolve(repoPath);
  const baseline = requireBaseline(resolved, pluginId);
  const manifest = baseline.manifest;
  const destPaths = listPluginDestPaths(baseline, resolved);

  const missing: string[] = [];
  const checksumMismatch: string[] = [];
  const unchanged: string[] = [];

  for (const dest of destPaths) {
    const templateContent = readTemplatePluginFile(resolved, pluginId, dest);
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
        pluginKeysMatch(installedRaw, readBaselineFile(baseline, fragmentRel))
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
    stageId: primaryStageId(manifest),
    baseline: baseline.kind,
    missing,
    checksumMismatch,
    unchanged,
  };
}

export function compareInstalledPluginsToTemplate(repoPath: string): PluginDriftResult[] {
  return detectInstalledPlugins(repoPath)
    .filter((pluginId) => resolvePluginBaseline(repoPath, pluginId) !== null)
    .map((pluginId) => comparePluginToTemplate(repoPath, pluginId));
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
        hint: pluginActionHint(drift.pluginId, file, 'missing', drift.baseline),
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
        hint: pluginActionHint(drift.pluginId, file, 'drift', drift.baseline),
      });
    }
  }

  return actions.sort(
    (a, b) => a.pluginId.localeCompare(b.pluginId) || a.file.localeCompare(b.file),
  );
}
