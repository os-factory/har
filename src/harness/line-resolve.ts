import {
  cleanupResolvedBundle,
  listLocalBundleIds,
  listTemplateBundleIds,
  resolveBundleSource,
  type BundleResolveConfig,
  type BundleSourceKind,
  type ResolvedBundleSource,
} from './bundle-resolve';
import { LINE_MANIFEST_FILES } from './schema';

export type LineSourceKind = BundleSourceKind;
export type ResolvedLineSource = ResolvedBundleSource;

/** Conventional in-repo home for factory lines (authored and installed). */
export const LOCAL_LINES_DIR = '.har/lines';

export const LINE_BUNDLE_CONFIG: BundleResolveConfig = {
  manifestFiles: LINE_MANIFEST_FILES,
  templatesSubdir: 'lines',
  localDir: LOCAL_LINES_DIR,
  gitNestedDir: 'lines',
  label: 'line',
  unknownHint: (repoPath: string) => knownLinesHint(repoPath),
};

/**
 * Resolve a line install spec to a directory with line.manifest.json.
 * Same channels as plugins (path → git → bundled → npm), different apply.
 */
export function resolveLineSource(spec: string, repoPath = '.'): ResolvedLineSource {
  return resolveBundleSource(spec, repoPath, LINE_BUNDLE_CONFIG);
}

function knownLinesHint(repoPath: string): string {
  const bundled = listBundledLineIds();
  const local = listLocalLineIds(repoPath);
  const parts = [`Bundled: ${bundled.join(', ') || '(none)'}.`];
  if (local.length > 0) {
    parts.push(`Local (${LOCAL_LINES_DIR}/): ${local.join(', ')}.`);
  } else {
    parts.push('Scaffold a project-owned one with: har line create <id>.');
  }
  return parts.join(' ');
}

/** List line ids under <repo>/.har/lines/<id>/line.manifest.json */
export function listLocalLineIds(repoPath = '.'): string[] {
  return listLocalBundleIds(repoPath, LINE_BUNDLE_CONFIG);
}

/** List line ids discovered under templates/lines/<id>/line.manifest.json */
export function listBundledLineIds(): string[] {
  return listTemplateBundleIds(LINE_BUNDLE_CONFIG);
}

export function cleanupResolvedLine(source: ResolvedLineSource): void {
  cleanupResolvedBundle(source);
}
