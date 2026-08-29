import {
  cleanupResolvedBundle,
  listLocalBundleIds,
  listTemplateBundleIds,
  resolveBundleSource,
  type BundleResolveConfig,
  type BundleSourceKind,
  type ResolvedBundleSource,
} from './bundle-resolve';

export type PluginSourceKind = BundleSourceKind;

/** Conventional in-repo home for project-owned plugins. */
export const LOCAL_PLUGINS_DIR = '.har/plugins';

export type ResolvedPluginSource = ResolvedBundleSource;

export const PLUGIN_BUNDLE_CONFIG: BundleResolveConfig = {
  // `line.manifest.json` is accepted here on purpose: resolving a line bundle
  // lets `readPluginManifestFromDir` refuse it with a pointer at `har line add`
  // instead of a bare "not a HAR plugin bundle".
  manifestFiles: ['template.manifest.json', 'line.manifest.json'],
  templatesSubdir: 'plugins',
  localDir: LOCAL_PLUGINS_DIR,
  gitNestedDir: 'plugins',
  label: 'plugin',
  unknownHint: (repoPath: string) => knownPluginsHint(repoPath),
};

/**
 * Resolve a plugin install spec to a directory with template.manifest.json.
 *
 * Spec forms:
 * - bundled id: `playwright`
 * - local plugin id (scaffolded by `har plugin create`): resolves `.har/plugins/<id>/`
 * - local path: `./my-plugin`, `/abs/path`, `file:…`, `~/…`
 * - npm package: `@org/har-cypress`, `har-plugin-foo@1.0.0`
 * - git: `github:org/repo`, `git+https://…`, `https://….git`
 */
export function resolvePluginSource(spec: string, repoPath = '.'): ResolvedPluginSource {
  return resolveBundleSource(spec, repoPath, PLUGIN_BUNDLE_CONFIG);
}

function knownPluginsHint(repoPath: string): string {
  const bundled = listBundledPluginIds();
  const local = listLocalPluginIds(repoPath);
  const parts = [`Bundled: ${bundled.join(', ') || '(none)'}.`];
  if (local.length > 0) {
    parts.push(`Local (.har/plugins/): ${local.join(', ')}.`);
  } else {
    parts.push('Scaffold a project-owned one with: har plugin create <id>.');
  }
  return parts.join(' ');
}

/** List project-owned plugin ids under <repo>/.har/plugins/<id>/template.manifest.json */
export function listLocalPluginIds(repoPath = '.'): string[] {
  return listLocalBundleIds(repoPath, PLUGIN_BUNDLE_CONFIG);
}

/** List plugin ids discovered under templates/plugins/<id>/template.manifest.json */
export function listBundledPluginIds(): string[] {
  return listTemplateBundleIds(PLUGIN_BUNDLE_CONFIG);
}

export function cleanupResolvedPlugin(source: ResolvedPluginSource): void {
  cleanupResolvedBundle(source);
}
