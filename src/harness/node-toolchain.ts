import * as fs from 'fs';
import * as path from 'path';
import {
  findPathNode,
  listInstalledNodes,
  NodeDiscoveryOptions,
  NodeInstall,
  probeNodeVersion,
} from '../utils/node-installs';
import { maxSatisfyingAll, parseRange, satisfiesRange } from '../utils/semver';
import { getHarnessDir } from './manifest';
import { readStageRegistry } from './stages';

/**
 * Node version requirements of a harness, and the Node a slot should pin.
 *
 * Sources (all must be satisfied):
 *  - harness root `package.json`: `engines.node`, `volta.node`
 *  - harness root `.nvmrc` / `.node-version`
 *  - `engines.node` of package.json files in directories the harness runs
 *    code in: npm/yarn workspaces of the root package.json, plus directories
 *    named by `cd <dir>`, `--prefix <dir>`, `-C|--dir|--cwd <dir>` in stage
 *    commands and in `.har/stages/*.sh` / `.har/hooks/*.sh`.
 */

export type NodeRequirementField = 'engines.node' | 'volta.node' | '.nvmrc' | '.node-version';

export interface NodeRequirement {
  /** File the requirement came from, relative to the harness root. */
  source: string;
  field: NodeRequirementField;
  /** npm-style range. */
  range: string;
}

export interface IgnoredNodeRequirement {
  source: string;
  value: string;
  reason: string;
}

export interface NodeRequirements {
  requirements: NodeRequirement[];
  ignored: IgnoredNodeRequirement[];
}

const LTS_MAJORS: Record<string, number> = {
  argon: 4,
  boron: 6,
  carbon: 8,
  dubnium: 10,
  erbium: 12,
  fermium: 14,
  gallium: 16,
  hydrogen: 18,
  iron: 20,
  jod: 22,
  krypton: 24,
};

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringAt(obj: Record<string, unknown> | null, key: string, sub: string): string | null {
  const parent = obj?.[key];
  if (!parent || typeof parent !== 'object') return null;
  const value = (parent as Record<string, unknown>)[sub];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** `.nvmrc` / `.node-version` value → range, or a reason it is ignored. */
function versionFileRange(value: string): { range: string } | { reason: string } {
  const v = value.trim().toLowerCase();
  if (['node', 'stable', 'latest', 'current'].includes(v)) return { reason: 'means "latest", no constraint' };
  const lts = v.match(/^lts\/(.+)$/);
  if (lts) {
    const major = LTS_MAJORS[lts[1]];
    return major ? { range: String(major) } : { reason: `alias ${value} is not resolvable offline` };
  }
  return parseRange(value) ? { range: value.trim().replace(/^v(?=\d)/, '') } : { reason: 'not a version or range' };
}

function workspaceDirs(root: string, pkg: Record<string, unknown> | null): string[] {
  const raw = pkg?.workspaces;
  const patterns = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).packages)
      ? ((raw as Record<string, unknown>).packages as unknown[])
      : [];
  const dirs: string[] = [];
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern.startsWith('!')) continue;
    const glob = pattern.match(/^(.*?)\/\*{1,2}$/);
    if (glob) {
      const parent = path.join(root, glob[1]);
      try {
        for (const name of fs.readdirSync(parent).sort()) dirs.push(path.join(parent, name));
      } catch {
        // missing workspace parent
      }
    } else if (!pattern.includes('*')) {
      dirs.push(path.join(root, pattern));
    }
  }
  return dirs;
}

const DIR_REFERENCE_RES = [
  /\bcd\s+(["']?)([^\s"'&;|()]+)\1/g,
  /--prefix[=\s]+(["']?)([^\s"'&;|()]+)\1/g,
  /\s(?:-C|--dir|--cwd)[=\s]+(["']?)([^\s"'&;|()]+)\1/g,
];

/** Directories referenced by shell text, resolved against the harness root. */
function referencedDirs(root: string, text: string): string[] {
  const dirs: string[] = [];
  for (const re of DIR_REFERENCE_RES) {
    for (const m of text.matchAll(re)) {
      let ref = m[2];
      ref = ref.replace(/^\$\{?(WORK_DIR|REPO_ROOT|PWD)\}?\/?/, '');
      if (!ref || ref.includes('$') || path.isAbsolute(ref)) continue;
      dirs.push(path.resolve(root, ref));
    }
  }
  return dirs;
}

function harnessShellText(root: string): string[] {
  const texts: string[] = [];
  try {
    for (const stage of readStageRegistry(root).stages) {
      if (stage.command) texts.push(stage.command);
    }
  } catch {
    // an unreadable registry is doctor's stages-registry finding, not ours
  }
  const harnessDir = getHarnessDir(root);
  for (const sub of ['stages', 'hooks']) {
    const dir = path.join(harnessDir, sub);
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.sh')) continue;
      try {
        texts.push(fs.readFileSync(path.join(dir, name), 'utf8'));
      } catch {
        // unreadable script
      }
    }
  }
  return texts;
}

/** Collect every Node requirement that applies to the harness at `root`. */
export function collectNodeRequirements(root: string): NodeRequirements {
  const requirements: NodeRequirement[] = [];
  const ignored: IgnoredNodeRequirement[] = [];
  const add = (req: NodeRequirement) => {
    if (!requirements.some((r) => r.source === req.source && r.field === req.field && r.range === req.range)) {
      requirements.push(req);
    }
  };

  const rootPkg = readJson(path.join(root, 'package.json'));
  const engines = (pkg: Record<string, unknown> | null, rel: string) => {
    const range = stringAt(pkg, 'engines', 'node');
    if (!range) return;
    if (parseRange(range)) add({ source: rel, field: 'engines.node', range });
    else ignored.push({ source: `${rel} engines.node`, value: range, reason: 'not a range HAR understands' });
  };
  engines(rootPkg, 'package.json');
  const volta = stringAt(rootPkg, 'volta', 'node');
  if (volta) {
    if (parseRange(volta)) add({ source: 'package.json', field: 'volta.node', range: volta });
    else ignored.push({ source: 'package.json volta.node', value: volta, reason: 'not a version' });
  }

  for (const file of ['.nvmrc', '.node-version'] as const) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      continue;
    }
    const value = content.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    if (!value) continue;
    const parsed = versionFileRange(value);
    if ('range' in parsed) add({ source: file, field: file, range: parsed.range });
    else ignored.push({ source: file, value, reason: parsed.reason });
  }

  const candidates = [
    ...workspaceDirs(root, rootPkg),
    ...harnessShellText(root).flatMap((text) => referencedDirs(root, text)),
  ];
  const seen = new Set<string>();
  for (const dir of candidates) {
    const rel = path.relative(root, dir);
    if (!rel || rel.startsWith('..') || seen.has(rel)) continue;
    seen.add(rel);
    const pkgFile = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgFile)) continue;
    engines(readJson(pkgFile), path.join(rel, 'package.json'));
  }

  return { requirements, ignored };
}

/** `>=22.23.4 (docs/package.json engines.node)` */
export function describeRequirement(req: NodeRequirement): string {
  const where = req.field === req.source ? req.source : `${req.source} ${req.field}`;
  return `${req.range} (${where})`;
}

export function describeRequirements(reqs: NodeRequirement[]): string {
  return reqs.map(describeRequirement).join(' and ');
}

/** Requirements `version` fails (empty when it satisfies all of them). */
export function unmetNodeRequirements(version: string, reqs: NodeRequirement[]): NodeRequirement[] {
  return reqs.filter((r) => !satisfiesRange(version, r.range));
}

/** Install hint (`22`, `22.1`) for a Node that would satisfy every requirement. */
export function nodeInstallHint(reqs: NodeRequirement[]): string | null {
  const ranges = reqs.map((r) => r.range);
  const ok = (v: string) => ranges.every((r) => satisfiesRange(v, r));
  // Lowest satisfying major: `nvm install 22` fetches the newest 22.x, which
  // meets `>=22.23.4` without jumping majors.
  for (let major = 10; major <= 40; major++) {
    if (ok(`${major}.999.999`)) return String(major);
  }
  for (let major = 10; major <= 40; major++) {
    for (let minor = 0; minor <= 60; minor++) {
      if (ok(`${major}.${minor}.999`)) return `${major}.${minor}`;
    }
  }
  return null;
}

export function nodeInstallRemedy(reqs: NodeRequirement[]): string {
  const hint = nodeInstallHint(reqs);
  const target = hint ?? '<version>';
  return `Install a Node that satisfies ${describeRequirements(reqs)}: \`nvm install ${target}\` (or \`fnm install ${target}\` / \`volta install node@${target}\` / \`mise install node@${target}\`), then relaunch the slot`;
}

export interface PathNode {
  nodeBin: string;
  version: string | null;
}

export type NodeToolchainChoice = 'unconstrained' | 'path' | 'pinned' | 'unsatisfied';

export interface NodeToolchainPlan {
  requirements: NodeRequirements;
  pathNode: PathNode | null;
  choice: NodeToolchainChoice;
  /** The Node a launch pins: the PATH node for 'path'/'unconstrained', an installed one for 'pinned'. */
  node: (NodeInstall | (PathNode & { source: 'path' })) | null;
  /** One-line summary for launch logs / doctor. */
  summary: string;
  /** Exact remediation when nothing installed satisfies the requirements. */
  remedy?: string;
}

export interface PlanNodeToolchainOptions extends NodeDiscoveryOptions {
  /** PATH node already resolved by the caller (e.g. SystemOps.which). Defaults to a PATH scan. */
  pathNodeBin?: string | null;
  /** Override the installed-runtime listing (tests). */
  installed?: NodeInstall[];
}

/** Decide which Node a slot of the harness at `root` should pin. */
export function planNodeToolchain(root: string, options: PlanNodeToolchainOptions = {}): NodeToolchainPlan {
  const requirements = collectNodeRequirements(root);
  const reqs = requirements.requirements;
  const pathBin = options.pathNodeBin !== undefined ? options.pathNodeBin : findPathNode(options.env ?? process.env);
  if (reqs.length === 0) {
    // Nothing to check against: keep the PATH node without probing it.
    const pathNode = pathBin ? { nodeBin: pathBin, version: null } : null;
    return {
      requirements,
      pathNode,
      choice: 'unconstrained',
      node: pathNode ? { ...pathNode, source: 'path' } : null,
      summary: 'no Node requirement declared — keeping the PATH node',
    };
  }
  const pathNode: PathNode | null = pathBin ? { nodeBin: pathBin, version: probeNodeVersion(pathBin) } : null;
  const asPath = pathNode ? { ...pathNode, source: 'path' as const } : null;
  const pathLabel = pathNode ? (pathNode.version ?? 'unknown version') : 'none on PATH';
  if (pathNode?.version && unmetNodeRequirements(pathNode.version, reqs).length === 0) {
    return {
      requirements,
      pathNode,
      choice: 'path',
      node: asPath,
      summary: `node ${pathNode.version} from PATH satisfies ${describeRequirements(reqs)}`,
    };
  }

  const unmet = pathNode?.version ? unmetNodeRequirements(pathNode.version, reqs) : reqs;
  const why = pathNode?.version
    ? `PATH ${pathNode.version} does not satisfy ${describeRequirements(unmet)}`
    : `PATH node (${pathLabel}) cannot be checked against ${describeRequirements(reqs)}`;

  const installed = options.installed ?? listInstalledNodes(options);
  const best = maxSatisfyingAll(
    installed.map((i) => i.version),
    reqs.map((r) => r.range),
  );
  const pick = best ? installed.find((i) => i.version === best) : undefined;
  if (pick) {
    return {
      requirements,
      pathNode,
      choice: 'pinned',
      node: pick,
      summary: `node ${pick.version} (${pick.source}) — ${why}`,
    };
  }
  return {
    requirements,
    pathNode,
    choice: 'unsatisfied',
    node: asPath,
    summary: `no installed Node satisfies ${describeRequirements(reqs)} — keeping ${pathLabel}; ${why}`,
    remedy: nodeInstallRemedy(reqs),
  };
}
