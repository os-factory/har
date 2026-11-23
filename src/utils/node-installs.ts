import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseVersion } from './semver';

/**
 * Enumerate Node.js runtimes installed by the common version managers.
 *
 * Filesystem-only: versions come from the install directory names
 * (`~/.nvm/versions/node/v24.14.0/bin/node`), so no binary is ever executed
 * to list them. Only the PATH node may need one `node --version` probe when
 * its location does not encode the version.
 */

export type NodeInstallSource = 'nvm' | 'fnm' | 'volta' | 'mise' | 'asdf' | 'n' | 'path';

export interface NodeInstall {
  /** Normalized `vX.Y.Z`. */
  version: string;
  /** Absolute path of the `node` binary. */
  nodeBin: string;
  /** Directory holding `node` (and usually `npm`/`npx`). */
  binDir: string;
  source: NodeInstallSource;
}

export interface NodeDiscoveryOptions {
  /** Environment to read manager dirs (NVM_DIR, FNM_DIR, …) and PATH from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Home directory for default manager locations. Defaults to env.HOME, then os.homedir(). */
  home?: string;
}

const VERSION_DIR_RE = /^v?(\d+\.\d+\.\d+)$/;

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function listDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function normalize(version: string): string {
  return `v${version.replace(/^v/, '')}`;
}

/** `<root>/<versionDir>/<binRel>/node` for every full-version directory name. */
function scan(root: string, binRel: string, source: NodeInstallSource): NodeInstall[] {
  const out: NodeInstall[] = [];
  for (const name of listDirs(root)) {
    const m = name.match(VERSION_DIR_RE);
    if (!m) continue; // skips aliases such as mise's `22` / `latest` symlinks
    const binDir = path.join(root, name, binRel);
    const nodeBin = path.join(binDir, 'node');
    if (!isFile(nodeBin)) continue;
    out.push({ version: normalize(m[1]), nodeBin, binDir, source });
  }
  return out;
}

function resolveHome(options: NodeDiscoveryOptions): { env: NodeJS.ProcessEnv; home: string } {
  const env = options.env ?? process.env;
  return { env, home: options.home ?? env.HOME ?? os.homedir() };
}

/** Every Node install found under nvm, fnm, volta, mise, asdf and n, deduped by real path. */
export function listInstalledNodes(options: NodeDiscoveryOptions = {}): NodeInstall[] {
  const { env, home } = resolveHome(options);
  const xdgData = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const found: NodeInstall[] = [];

  const nvmDir = env.NVM_DIR || path.join(home, '.nvm');
  found.push(...scan(path.join(nvmDir, 'versions', 'node'), 'bin', 'nvm'));

  const fnmDirs = env.FNM_DIR ? [env.FNM_DIR] : [path.join(xdgData, 'fnm'), path.join(home, '.fnm')];
  for (const dir of fnmDirs) {
    found.push(...scan(path.join(dir, 'node-versions'), path.join('installation', 'bin'), 'fnm'));
  }

  const voltaHome = env.VOLTA_HOME || path.join(home, '.volta');
  found.push(...scan(path.join(voltaHome, 'tools', 'image', 'node'), 'bin', 'volta'));

  const miseData = env.MISE_DATA_DIR || path.join(xdgData, 'mise');
  found.push(...scan(path.join(miseData, 'installs', 'node'), 'bin', 'mise'));

  const asdfData = env.ASDF_DATA_DIR || path.join(home, '.asdf');
  found.push(...scan(path.join(asdfData, 'installs', 'nodejs'), 'bin', 'asdf'));

  const nPrefix = env.N_PREFIX || '/usr/local';
  found.push(...scan(path.join(nPrefix, 'n', 'versions', 'node'), 'bin', 'n'));

  const seen = new Set<string>();
  return found.filter((install) => {
    let key = install.nodeBin;
    try {
      key = fs.realpathSync(install.nodeBin);
    } catch {
      // keep the literal path
    }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** First executable `node` on the given PATH, or null. */
export function findPathNode(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'node');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (isFile(candidate)) return candidate;
    } catch {
      // keep scanning
    }
  }
  return null;
}

/** Version encoded in a node binary's (real) path, e.g. `.../v24.14.0/bin/node`. */
export function nodeVersionFromPath(nodeBin: string): string | null {
  const candidates = [nodeBin];
  try {
    candidates.push(fs.realpathSync(nodeBin));
  } catch {
    // literal path only
  }
  for (const candidate of candidates) {
    for (const segment of candidate.split(path.sep).reverse()) {
      const m = segment.match(VERSION_DIR_RE);
      if (m) return normalize(m[1]);
    }
  }
  return null;
}

/**
 * Version of a node binary: from its path when the path encodes it, from the
 * running process when it is the same binary, else one `node --version` probe.
 */
export function probeNodeVersion(nodeBin: string): string | null {
  const fromPath = nodeVersionFromPath(nodeBin);
  if (fromPath) return fromPath;
  try {
    if (fs.realpathSync(nodeBin) === fs.realpathSync(process.execPath)) return process.version;
  } catch {
    // fall through to the probe
  }
  try {
    const out = execFileSync(nodeBin, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return parseVersion(out) ? normalize(out) : null;
  } catch {
    return null;
  }
}
