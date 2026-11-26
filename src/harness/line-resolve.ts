import {
  cleanupResolvedBundle,
  listLocalBundleIds,
  listTemplateBundleIds,
  resolveBundleSource,
  type BundleResolveConfig,
  type BundleSourceKind,
  type ResolvedBundleSource,
} from './bundle-resolve';
import * as path from 'path';
import { linesDirRel, personalHarRoot, type LineScope } from './line-scope';
import { LINE_MANIFEST_FILES } from './schema';

export type LineSourceKind = BundleSourceKind;
export type ResolvedLineSource = ResolvedBundleSource;

/** Conventional in-repo home for team factory lines (authored and installed). */
export const LOCAL_LINES_DIR = linesDirRel('team');

/** Gitignored home for personal factory lines. */
export const PERSONAL_LINES_DIR = linesDirRel('personal');

export const LINE_BUNDLE_CONFIG: BundleResolveConfig = {
  manifestFiles: LINE_MANIFEST_FILES,
  templatesSubdir: 'lines',
  localDir: LOCAL_LINES_DIR,
  gitNestedDir: 'lines',
  label: 'line',
  unknownHint: (repoPath: string) => knownLinesHint(repoPath),
};

/** Same channels, but a bare id resolves from the personal home. */
export const PERSONAL_LINE_BUNDLE_CONFIG: BundleResolveConfig = {
  ...LINE_BUNDLE_CONFIG,
  localDir: PERSONAL_LINES_DIR,
};

/**
 * Bundle config for a scope. With `repoPath`, the personal home is made
 * absolute under {@link personalHarRoot}, so a bare id resolves from the main
 * checkout inside a worktree slot while path specs stay relative to the repo.
 */
export function lineBundleConfig(scope: LineScope, repoPath?: string): BundleResolveConfig {
  if (scope === 'team') return LINE_BUNDLE_CONFIG;
  if (repoPath === undefined) return PERSONAL_LINE_BUNDLE_CONFIG;
  return {
    ...PERSONAL_LINE_BUNDLE_CONFIG,
    localDir: path.join(personalHarRoot(repoPath), PERSONAL_LINES_DIR),
  };
}

/**
 * Resolve a line install spec to a directory with line.manifest.json.
 * Same channels as plugins (path → git → bundled → npm), different apply.
 * A bare id resolves against the home of `scope` (`.har/lines` or `.har/local/lines`).
 */
export function resolveLineSource(
  spec: string,
  repoPath = '.',
  scope: LineScope = 'team',
): ResolvedLineSource {
  return resolveBundleSource(spec, repoPath, lineBundleConfig(scope, repoPath));
}

function knownLinesHint(repoPath: string): string {
  const bundled = listBundledLineIds();
  const local = listLocalLineIds(repoPath, 'team');
  const personal = listLocalLineIds(repoPath, 'personal');
  const parts = [`Bundled: ${bundled.join(', ') || '(none)'}.`];
  if (local.length > 0) {
    parts.push(`Local (${LOCAL_LINES_DIR}/): ${local.join(', ')}.`);
  }
  if (personal.length > 0) {
    parts.push(`Personal (${PERSONAL_LINES_DIR}/, install with --personal): ${personal.join(', ')}.`);
  }
  if (local.length === 0 && personal.length === 0) {
    parts.push('Scaffold a project-owned one with: har line create <id> [--personal].');
  }
  return parts.join(' ');
}

/** List line ids under <repo>/.har/lines/<id>/ (team) or <repo>/.har/local/lines/<id>/ (personal). */
export function listLocalLineIds(repoPath = '.', scope: LineScope = 'team'): string[] {
  return listLocalBundleIds(repoPath, lineBundleConfig(scope, repoPath));
}

/** List line ids discovered under templates/lines/<id>/line.manifest.json */
export function listBundledLineIds(): string[] {
  return listTemplateBundleIds(LINE_BUNDLE_CONFIG);
}

export function cleanupResolvedLine(source: ResolvedLineSource): void {
  cleanupResolvedBundle(source);
}
