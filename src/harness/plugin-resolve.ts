import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveTemplatesDir } from '../utils/paths';

export type PluginSourceKind = 'bundled' | 'path' | 'npm' | 'git';

export interface ResolvedPluginSource {
  id: string;
  kind: PluginSourceKind;
  /** Absolute directory containing template.manifest.json */
  dir: string;
  /** Original user/spec string */
  spec: string;
  /** Optional package version read from package.json */
  version?: string;
  /** Temp dirs that should be cleaned up after apply */
  cleanupDirs: string[];
}

function hasManifest(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'template.manifest.json'));
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

function readManifestId(dir: string): string | undefined {
  const manifestPath = path.join(dir, 'template.manifest.json');
  if (!fs.existsSync(manifestPath)) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { id?: string };
    return typeof raw.id === 'string' ? raw.id : undefined;
  } catch {
    return undefined;
  }
}

function looksLikePath(spec: string): boolean {
  return (
    spec.startsWith('.') ||
    spec.startsWith('/') ||
    spec.startsWith('~') ||
    spec.startsWith('file:')
  );
}

function looksLikeGit(spec: string): boolean {
  return (
    spec.startsWith('git+') ||
    spec.startsWith('github:') ||
    spec.startsWith('gitlab:') ||
    spec.startsWith('bitbucket:') ||
    /^https?:\/\/.+\.git$/i.test(spec) ||
    /^git@/.test(spec)
  );
}

function looksLikeNpm(spec: string): boolean {
  // @scope/name, @scope/name@version, name@version, or plain package name with /
  if (looksLikePath(spec) || looksLikeGit(spec)) return false;
  if (spec.includes('/') && !spec.startsWith('@')) return false; // avoid treating relative as npm
  return /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@.+)?$/i.test(spec);
}

function resolveBundledDir(pluginId: string): string | null {
  const dir = path.join(resolveTemplatesDir(), 'plugins', pluginId);
  return hasManifest(dir) ? dir : null;
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p === '~') return os.homedir();
  return p;
}

function resolvePathSpec(spec: string): ResolvedPluginSource {
  const raw = spec.startsWith('file:') ? spec.slice('file:'.length) : spec;
  const dir = path.resolve(expandHome(raw));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`Plugin path not found: ${spec}`);
  }
  if (!hasManifest(dir)) {
    throw new Error(`No template.manifest.json in ${dir}`);
  }
  const id = readManifestId(dir) ?? path.basename(dir);
  return {
    id,
    kind: 'path',
    dir,
    spec,
    version: readPackageVersion(dir),
    cleanupDirs: [],
  };
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function resolveNpmSpec(spec: string): ResolvedPluginSource {
  const tmp = makeTempDir('har-plugin-npm-');
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
    const packageDir = path.join(extractDir, 'package');
    // Some packs nest the manifest; prefer package/, else search one level
    let dir = packageDir;
    if (!hasManifest(dir)) {
      const nested = fs
        .readdirSync(extractDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(extractDir, e.name))
        .find((d) => hasManifest(d));
      if (!nested) {
        throw new Error(
          `npm package ${spec} has no template.manifest.json (not a HAR plugin bundle)`,
        );
      }
      dir = nested;
    }
    const id = readManifestId(dir) ?? spec.replace(/^@/, '').replace(/[/:].*/g, '');
    return {
      id,
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
    throw new Error(`Failed to install plugin from npm (${spec}): ${message}`);
  }
}

function resolveGitSpec(spec: string): ResolvedPluginSource {
  const tmp = makeTempDir('har-plugin-git-');
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

    // Manifest at root, or under a single plugins/<id> dir
    let dir = cloneDir;
    if (!hasManifest(dir)) {
      const pluginsRoot = path.join(cloneDir, 'plugins');
      if (fs.existsSync(pluginsRoot)) {
        const child = fs
          .readdirSync(pluginsRoot, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => path.join(pluginsRoot, e.name))
          .find((d) => hasManifest(d));
        if (child) dir = child;
      }
    }
    if (!hasManifest(dir)) {
      throw new Error(`Git repo ${spec} has no template.manifest.json (not a HAR plugin bundle)`);
    }

    const id = readManifestId(dir) ?? path.basename(url.replace(/\.git$/, ''));
    return {
      id,
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
    throw new Error(`Failed to install plugin from git (${spec}): ${message}`);
  }
}

/**
 * Resolve a plugin install spec to a directory with template.manifest.json.
 *
 * Spec forms:
 * - bundled id: `playwright`
 * - local path: `./my-plugin`, `/abs/path`, `file:…`, `~/…`
 * - npm package: `@org/har-cypress`, `har-plugin-foo@1.0.0`
 * - git: `github:org/repo`, `git+https://…`, `https://….git`
 */
export function resolvePluginSource(spec: string): ResolvedPluginSource {
  const trimmed = spec.trim();
  if (!trimmed) {
    throw new Error('Plugin spec is empty');
  }

  if (looksLikePath(trimmed)) {
    return resolvePathSpec(trimmed);
  }

  if (looksLikeGit(trimmed)) {
    return resolveGitSpec(trimmed);
  }

  // Prefer bundled when the id matches a shipped plugin (even if it also looks like npm)
  const bundled = resolveBundledDir(trimmed);
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

  // Bare id that isn't bundled — if it looks like an npm package name, try npm
  if (looksLikeNpm(trimmed) && (trimmed.includes('@') || trimmed.includes('/'))) {
    return resolveNpmSpec(trimmed);
  }

  if (looksLikeNpm(trimmed)) {
    // Could be a typo for a bundled plugin, or an npm package without scope
    try {
      return resolveNpmSpec(trimmed);
    } catch (npmErr) {
      const available = listBundledPluginIds();
      const npmMessage = npmErr instanceof Error ? npmErr.message : String(npmErr);
      throw new Error(
        `Unknown plugin: ${trimmed}. Bundled: ${available.join(', ') || '(none)'}. ` +
          `Or pass a path, npm package, or git URL. (${npmMessage})`,
      );
    }
  }

  const available = listBundledPluginIds();
  throw new Error(
    `Unknown plugin: ${trimmed}. Bundled: ${available.join(', ') || '(none)'}. ` +
      `Or pass a path (./plugin), npm package (@org/pkg), or git URL (github:org/repo).`,
  );
}

/** List plugin ids discovered under templates/plugins/<id>/template.manifest.json */
export function listBundledPluginIds(): string[] {
  const root = path.join(resolveTemplatesDir(), 'plugins');
  if (!fs.existsSync(root)) return [];

  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => hasManifest(path.join(root, name)))
    .sort();
}

export function cleanupResolvedPlugin(source: ResolvedPluginSource): void {
  for (const dir of source.cleanupDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
