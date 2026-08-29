import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveTemplatesDir } from '../utils/paths';

/**
 * Generic resolver for installable HAR bundles (verification plugins and
 * factory lines). Both kinds share the same install channels — path → git →
 * bundled id → npm — and differ only in manifest file name, template
 * subdirectory, and in-repo home. Keeping one resolver is the point: a line is
 * plugin-style plumbing with a different apply path, not a fourth marketplace.
 */

export type BundleSourceKind = 'bundled' | 'local' | 'path' | 'npm' | 'git';

export interface BundleResolveConfig {
  /** Manifest file names accepted at a bundle root, in priority order. */
  manifestFiles: readonly string[];
  /** Subdirectory of the packaged templates dir holding bundled ids. */
  templatesSubdir: string;
  /** Repo-relative home for project-owned bundles (e.g. `.har/plugins`). */
  localDir: string;
  /** Subdirectory a git repo may nest bundles under (e.g. `plugins`). */
  gitNestedDir: string;
  /** Human label used in errors ("plugin", "line"). */
  label: string;
  /** Extra hint appended to "unknown bundle" errors. */
  unknownHint?: (repoPath: string) => string;
}

export interface ResolvedBundleSource {
  id: string;
  kind: BundleSourceKind;
  /** Absolute directory containing the manifest. */
  dir: string;
  /** Original user/spec string. */
  spec: string;
  /** Optional package version read from package.json. */
  version?: string;
  /** Temp dirs that should be cleaned up after apply. */
  cleanupDirs: string[];
}

export function findManifestPath(dir: string, config: BundleResolveConfig): string | null {
  for (const name of config.manifestFiles) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function hasManifest(dir: string, config: BundleResolveConfig): boolean {
  return findManifestPath(dir, config) !== null;
}

function readPackageVersion(dir: string): string | undefined {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

function readManifestId(dir: string, config: BundleResolveConfig): string | undefined {
  const manifestPath = findManifestPath(dir, config);
  if (!manifestPath) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { id?: string };
    return typeof raw.id === 'string' ? raw.id : undefined;
  } catch {
    return undefined;
  }
}

export function looksLikePath(spec: string): boolean {
  return (
    spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('~') || spec.startsWith('file:')
  );
}

export function looksLikeGit(spec: string): boolean {
  return (
    spec.startsWith('git+') ||
    spec.startsWith('github:') ||
    spec.startsWith('gitlab:') ||
    spec.startsWith('bitbucket:') ||
    /^https?:\/\/.+\.git$/i.test(spec) ||
    /^git@/.test(spec)
  );
}

export function looksLikeNpm(spec: string): boolean {
  if (looksLikePath(spec) || looksLikeGit(spec)) return false;
  if (spec.includes('/') && !spec.startsWith('@')) return false;
  return /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@.+)?$/i.test(spec);
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p === '~') return os.homedir();
  return p;
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function manifestNames(config: BundleResolveConfig): string {
  return config.manifestFiles.join(' or ');
}

function resolveTemplatesBundleDir(id: string, config: BundleResolveConfig): string | null {
  const dir = path.join(resolveTemplatesDir(), config.templatesSubdir, id);
  return hasManifest(dir, config) ? dir : null;
}

function resolveLocalDir(id: string, repoPath: string, config: BundleResolveConfig): string | null {
  const dir = path.resolve(repoPath, config.localDir, id);
  return hasManifest(dir, config) ? dir : null;
}

function isLocalBundleDir(dir: string, repoPath: string, config: BundleResolveConfig): boolean {
  return path.dirname(dir) === path.resolve(repoPath, config.localDir);
}

function resolvePathSpec(
  spec: string,
  repoPath: string,
  config: BundleResolveConfig,
): ResolvedBundleSource {
  const raw = spec.startsWith('file:') ? spec.slice('file:'.length) : spec;
  const dir = path.resolve(expandHome(raw));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`${config.label} path not found: ${spec}`);
  }
  if (!hasManifest(dir, config)) {
    throw new Error(`No ${manifestNames(config)} in ${dir}`);
  }
  return {
    id: readManifestId(dir, config) ?? path.basename(dir),
    kind: isLocalBundleDir(dir, repoPath, config) ? 'local' : 'path',
    dir,
    spec,
    version: readPackageVersion(dir),
    cleanupDirs: [],
  };
}

function resolveNpmSpec(spec: string, config: BundleResolveConfig): ResolvedBundleSource {
  const tmp = makeTempDir(`har-${config.label}-npm-`);
  const cleanupDirs = [tmp];
  try {
    execFileSync('npm', ['pack', spec, '--pack-destination', tmp], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    const tarballs = fs.readdirSync(tmp).filter((f) => f.endsWith('.tgz'));
    if (tarballs.length === 0) {
      throw new Error(`npm pack produced no tarball for ${spec}`);
    }
    const extractDir = path.join(tmp, 'extract');
    fs.mkdirSync(extractDir);
    execFileSync('tar', ['-xzf', path.join(tmp, tarballs[0]), '-C', extractDir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let dir = path.join(extractDir, 'package');
    if (!hasManifest(dir, config)) {
      const nested = fs
        .readdirSync(extractDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(extractDir, e.name))
        .find((d) => hasManifest(d, config));
      if (!nested) {
        throw new Error(
          `npm package ${spec} has no ${manifestNames(config)} (not a HAR ${config.label} bundle)`,
        );
      }
      dir = nested;
    }
    return {
      id: readManifestId(dir, config) ?? spec.replace(/^@/, '').replace(/[/:].*/g, ''),
      kind: 'npm',
      dir,
      spec,
      version: readPackageVersion(dir),
      cleanupDirs,
    };
  } catch (err) {
    for (const d of cleanupDirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to install ${config.label} from npm (${spec}): ${message}`);
  }
}

function resolveGitSpec(spec: string, config: BundleResolveConfig): ResolvedBundleSource {
  const tmp = makeTempDir(`har-${config.label}-git-`);
  const cleanupDirs = [tmp];
  const cloneDir = path.join(tmp, 'repo');
  try {
    let url = spec;
    if (spec.startsWith('github:')) {
      url = `https://github.com/${spec.slice('github:'.length)}.git`;
    } else if (spec.startsWith('gitlab:')) {
      url = `https://gitlab.com/${spec.slice('gitlab:'.length)}.git`;
    } else if (spec.startsWith('bitbucket:')) {
      url = `https://bitbucket.org/${spec.slice('bitbucket:'.length)}.git`;
    } else if (spec.startsWith('git+')) {
      url = spec.slice('git+'.length);
    }

    execFileSync('git', ['clone', '--depth', '1', url, cloneDir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180_000,
    });

    let dir = cloneDir;
    if (!hasManifest(dir, config)) {
      const nestedRoot = path.join(cloneDir, config.gitNestedDir);
      if (fs.existsSync(nestedRoot)) {
        const child = fs
          .readdirSync(nestedRoot, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => path.join(nestedRoot, e.name))
          .find((d) => hasManifest(d, config));
        if (child) dir = child;
      }
    }
    if (!hasManifest(dir, config)) {
      throw new Error(
        `Git repo ${spec} has no ${manifestNames(config)} (not a HAR ${config.label} bundle)`,
      );
    }

    return {
      id: readManifestId(dir, config) ?? path.basename(url.replace(/\.git$/, '')),
      kind: 'git',
      dir,
      spec,
      version: readPackageVersion(dir),
      cleanupDirs,
    };
  } catch (err) {
    for (const d of cleanupDirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to install ${config.label} from git (${spec}): ${message}`);
  }
}

/** Resolve an install spec to a directory containing the bundle manifest. */
export function resolveBundleSource(
  spec: string,
  repoPath: string,
  config: BundleResolveConfig,
): ResolvedBundleSource {
  const trimmed = spec.trim();
  if (!trimmed) {
    throw new Error(`${config.label} spec is empty`);
  }

  if (looksLikePath(trimmed)) {
    return resolvePathSpec(trimmed, repoPath, config);
  }

  if (looksLikeGit(trimmed)) {
    return resolveGitSpec(trimmed, config);
  }

  const bundled = resolveTemplatesBundleDir(trimmed, config);
  if (bundled) {
    return {
      id: trimmed,
      kind: 'bundled',
      dir: bundled,
      spec: trimmed,
      version: readPackageVersion(bundled),
      cleanupDirs: [],
    };
  }

  const local = resolveLocalDir(trimmed, repoPath, config);
  if (local) {
    return {
      id: readManifestId(local, config) ?? trimmed,
      kind: 'local',
      dir: local,
      spec: trimmed,
      version: readPackageVersion(local),
      cleanupDirs: [],
    };
  }

  const hint = config.unknownHint?.(repoPath) ?? '';

  if (looksLikeNpm(trimmed)) {
    try {
      return resolveNpmSpec(trimmed, config);
    } catch (npmErr) {
      if (trimmed.includes('@') || trimmed.includes('/')) throw npmErr;
      const npmMessage = npmErr instanceof Error ? npmErr.message : String(npmErr);
      throw new Error(
        `Unknown ${config.label}: ${trimmed}. ${hint} ` +
          `Or pass a path, npm package, or git URL. (${npmMessage})`,
      );
    }
  }

  throw new Error(
    `Unknown ${config.label}: ${trimmed}. ${hint} ` +
      `Or pass a path (./bundle), npm package (@org/pkg), or git URL (github:org/repo).`,
  );
}

/** List bundle ids under `<templates>/<subdir>/<id>/<manifest>`. */
export function listTemplateBundleIds(config: BundleResolveConfig): string[] {
  const root = path.join(resolveTemplatesDir(), config.templatesSubdir);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => hasManifest(path.join(root, name), config))
    .sort();
}

/** List project-owned bundle ids under `<repo>/<localDir>/<id>/<manifest>`. */
export function listLocalBundleIds(repoPath: string, config: BundleResolveConfig): string[] {
  const root = path.resolve(repoPath, config.localDir);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => hasManifest(path.join(root, name), config))
    .sort();
}

export function cleanupResolvedBundle(source: ResolvedBundleSource): void {
  for (const dir of source.cleanupDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
