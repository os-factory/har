import * as fs from 'fs';
import * as path from 'path';
import { run } from '../utils/shell';

/**
 * Reads an Xcode project well enough to fill in the iOS harness profile.
 *
 * The scaffold ships placeholders (`MyApp`, `com.example.myapp`), so a freshly
 * initialized iOS harness cannot build anything until someone adapts it by hand.
 * This module resolves the mechanical part — which project file, which scheme,
 * which bundle id — and leaves everything genuinely project-specific alone.
 *
 * Two rules shape the whole module:
 *  - it never guesses. An ambiguous scheme stays unset, with the candidates
 *    reported as a warning, because a wrong scheme costs more than a missing one;
 *  - it never fails init. No Xcode, no macOS, a stalled `xcodebuild` — every path
 *    degrades to a partial result carrying an explanation.
 */

/** How long `xcodebuild` may take before we stop waiting on it. */
const LIST_TIMEOUT_MS = 45_000;
const SETTINGS_TIMEOUT_MS = 60_000;

/** Directories that never hold the project we are looking for. */
const SKIP_DIRS = new Set(['node_modules', 'Pods', 'DerivedData', 'build', 'vendor']);

/** Tool that produces the .xcodeproj, when it is a build product rather than a tracked file. */
export type XcodeProjectGenerator = 'tuist' | 'xcodegen' | 'cocoapods';

/**
 * Generator manifests, in the precedence the harness applies. `provision_ios_generate_project`
 * in provision-toolchain.sh must check the same files in the same order — a test binds
 * the two, since a divergence would have init name one generator and launch run another.
 */
export const GENERATOR_MANIFESTS: ReadonlyArray<{
  id: XcodeProjectGenerator;
  manifest: string;
}> = [
  { id: 'tuist', manifest: 'Project.swift' },
  { id: 'xcodegen', manifest: 'project.yml' },
  { id: 'cocoapods', manifest: 'Podfile' },
];

export interface XcodeProjectLocation {
  /** Repo-relative path to the .xcworkspace, when one exists outside any .xcodeproj. */
  workspace?: string;
  /** Repo-relative path to the .xcodeproj. */
  project?: string;
  generator: XcodeProjectGenerator | null;
  /**
   * Every project and workspace found, sorted. More than one entry means the pick
   * above was arbitrary and the caller should say so rather than choose silently.
   */
  candidates: string[];
}

export interface XcodeProjectInfo extends XcodeProjectLocation {
  /** Resolved only when unambiguous — see `schemes` for what was on offer. */
  scheme?: string;
  schemes: string[];
  bundleId?: string;
  /**
   * `high`   — scheme and bundle id resolved, the harness can build as generated.
   * `partial`— something is known, but manual adaptation is still required.
   * `none`   — this does not look like an Xcode project at all.
   */
  confidence: 'high' | 'partial' | 'none';
  warnings: string[];
}

export interface IntrospectOptions {
  listTimeoutMs?: number;
  settingsTimeoutMs?: number;
}

/** Single-quote a path for safe interpolation into a shell command. */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Parse JSON that may carry leading tool chatter. */
function parseJsonLoose<T>(raw: string): T | null {
  const start = raw.search(/[[{]/);
  if (start < 0) return null;
  try {
    return JSON.parse(raw.slice(start)) as T;
  } catch {
    return null;
  }
}

function detectGenerator(repoPath: string): XcodeProjectGenerator | null {
  // Precedence matters: a Tuist repo may also carry a Podfile, and Tuist is what
  // produces the project file the rest of the pipeline needs.
  const found = GENERATOR_MANIFESTS.find((entry) =>
    fs.existsSync(path.join(repoPath, entry.manifest)),
  );
  return found?.id ?? null;
}

/**
 * Locate the Xcode project on disk. Filesystem only — safe to call on every
 * `har env init`, including on machines without Xcode.
 */
export function detectXcodeProject(repoPath: string): XcodeProjectLocation | null {
  const resolved = path.resolve(repoPath);
  const generator = detectGenerator(resolved);

  const workspaces: string[] = [];
  const projects: string[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > 2) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
      const full = path.join(dir, name);

      if (name.endsWith('.xcodeproj')) {
        // Never descend: every .xcodeproj holds an inner project.xcworkspace that
        // would otherwise shadow the real workspace.
        projects.push(path.relative(resolved, full));
        continue;
      }
      if (name.endsWith('.xcworkspace')) {
        workspaces.push(path.relative(resolved, full));
        continue;
      }
      walk(full, depth + 1);
    }
  };

  walk(resolved, 1);

  // Sorted, not readdir order: that order is filesystem-dependent, and an arbitrary
  // pick must at least be the same arbitrary pick on every machine.
  workspaces.sort();
  projects.sort();

  const workspace = workspaces[0];
  const project = projects[0];

  if (!workspace && !project && !generator) return null;
  return { workspace, project, generator, candidates: [...workspaces, ...projects] };
}

/** Root manifests that mean the repository is primarily something other than an iOS app. */
const FOREIGN_ROOT_MANIFESTS = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml'];

/**
 * Whether `har env onboard` should offer the iOS profile by default.
 *
 * Deliberately stricter than `detectXcodeProject`: the project must sit at the
 * repository root, and no other ecosystem may own the root. A React Native repo
 * (package.json at root, project under ios/) must keep its own profile, and a
 * monorepo with one iOS app among many packages must not be reclassified.
 *
 * A suggestion only — the choice stays the user's, and `--profile` is unaffected.
 */
export function suggestsIosProfile(repoPath: string): boolean {
  const resolved = path.resolve(repoPath);

  for (const manifest of FOREIGN_ROOT_MANIFESTS) {
    if (fs.existsSync(path.join(resolved, manifest))) return false;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch {
    return false;
  }

  return entries.some((entry) => {
    if (entry.isDirectory()) {
      return entry.name.endsWith('.xcodeproj') || entry.name.endsWith('.xcworkspace');
    }
    return entry.name === 'Project.swift' || entry.name === 'project.yml';
  });
}

/** xcodebuild flags selecting the target — workspace wins, as CocoaPods requires. */
function targetFlags(repoPath: string, location: XcodeProjectLocation): string | null {
  if (location.workspace) return `-workspace ${quote(path.join(repoPath, location.workspace))}`;
  if (location.project) return `-project ${quote(path.join(repoPath, location.project))}`;
  return null;
}

interface XcodeListOutput {
  project?: { name?: string; schemes?: string[] };
  workspace?: { name?: string; schemes?: string[] };
}

interface XcodeBuildSettings {
  buildSettings?: Record<string, string>;
}

/**
 * Pick a scheme only when the choice is unambiguous: an exact match on the project
 * name, or a single candidate. Anything else is left for a human.
 */
function chooseScheme(schemes: string[], location: XcodeProjectLocation): string | undefined {
  if (schemes.length === 0) return undefined;
  if (schemes.length === 1) return schemes[0];

  const target = location.workspace ?? location.project;
  if (target) {
    const base = path.basename(target).replace(/\.(xcworkspace|xcodeproj)$/, '');
    const exact = schemes.find((scheme) => scheme === base);
    if (exact) return exact;
  }
  return undefined;
}

export function introspectXcodeProject(
  repoPath: string,
  options: IntrospectOptions = {},
): XcodeProjectInfo {
  const resolved = path.resolve(repoPath);
  const warnings: string[] = [];
  const location = detectXcodeProject(resolved);

  if (!location) {
    warnings.push(
      'No Xcode project, workspace, or generator manifest found here — left the iOS ' +
        'scaffold placeholders in place. Set HARNESS_XCODE_PROJECT (or _WORKSPACE), ' +
        'HARNESS_XCODE_SCHEME and HARNESS_BUNDLE_ID in .har/harness.env, or re-run ' +
        'init with a different --profile.',
    );
    return { generator: null, schemes: [], candidates: [], confidence: 'none', warnings };
  }

  const base: XcodeProjectInfo = {
    ...location,
    schemes: [],
    confidence: 'partial',
    warnings,
  };

  if (location.candidates.length > 1) {
    // Refusing to guess a scheme while silently guessing a project would be
    // inconsistent; the pick is reported so it can be overridden.
    warnings.push(
      `Several Xcode projects/workspaces found — picked ${location.workspace ?? location.project}. ` +
        `Set HARNESS_XCODE_WORKSPACE or HARNESS_XCODE_PROJECT to choose another: ${location.candidates.join(', ')}.`,
    );
  }

  const flags = targetFlags(resolved, location);
  if (!flags) {
    warnings.push(
      `No .xcodeproj found — this project is generated by ${location.generator ?? 'a build tool'}. ` +
        'The harness generates it at launch; set HARNESS_XCODE_SCHEME and HARNESS_BUNDLE_ID by hand until then.',
    );
    return base;
  }

  if (run('command -v xcodebuild').code !== 0) {
    warnings.push(
      'xcodebuild is not available — skipped project introspection. ' +
        'Set HARNESS_XCODE_SCHEME and HARNESS_BUNDLE_ID in .har/harness.env by hand.',
    );
    return base;
  }

  const listResult = run(`xcodebuild -list -json ${flags}`, {
    cwd: resolved,
    timeout: options.listTimeoutMs ?? LIST_TIMEOUT_MS,
  });

  if (listResult.code !== 0) {
    warnings.push(
      listResult.timedOut
        ? 'xcodebuild -list timed out — left the scheme unset in .har/harness.env.'
        : 'xcodebuild -list failed — left the scheme unset in .har/harness.env.',
    );
    return base;
  }

  const listed = parseJsonLoose<XcodeListOutput>(listResult.stdout);
  const schemes = listed?.workspace?.schemes ?? listed?.project?.schemes ?? [];
  base.schemes = schemes;

  if (schemes.length === 0) {
    warnings.push(
      'No shared scheme found. Mark a scheme as shared in Xcode (Product → Scheme → Manage Schemes), ' +
        'then set HARNESS_XCODE_SCHEME.',
    );
    return base;
  }

  const scheme = chooseScheme(schemes, location);
  if (!scheme) {
    warnings.push(
      `Several schemes match and none carries the project name — left HARNESS_XCODE_SCHEME unset. ` +
        `Pick one of: ${schemes.join(', ')}.`,
    );
    return base;
  }
  base.scheme = scheme;

  // The destination is pinned: on a project whose default destination is a device,
  // build settings differ from the simulator ones the harness actually builds for.
  const settingsResult = run(
    `xcodebuild -showBuildSettings -json ${flags} -scheme ${quote(scheme)} ` +
      `-destination 'generic/platform=iOS Simulator'`,
    { cwd: resolved, timeout: options.settingsTimeoutMs ?? SETTINGS_TIMEOUT_MS },
  );

  if (settingsResult.code !== 0) {
    warnings.push(
      settingsResult.timedOut
        ? `xcodebuild -showBuildSettings timed out — left HARNESS_BUNDLE_ID unset.`
        : `xcodebuild -showBuildSettings failed — left HARNESS_BUNDLE_ID unset.`,
    );
    return base;
  }

  const settingsList = parseJsonLoose<XcodeBuildSettings[]>(settingsResult.stdout);
  if (!Array.isArray(settingsList)) {
    // Distinct from "the setting is missing": blaming project config for output we
    // failed to parse sends the user hunting through Xcode for a correct setting.
    warnings.push(
      'Could not parse xcodebuild -showBuildSettings output — left HARNESS_BUNDLE_ID unset.',
    );
    return base;
  }

  const settings = settingsList[0]?.buildSettings;
  const bundleId = settings?.PRODUCT_BUNDLE_IDENTIFIER;

  if (!bundleId) {
    warnings.push('PRODUCT_BUNDLE_IDENTIFIER is not set for this scheme — left HARNESS_BUNDLE_ID unset.');
    return base;
  }
  base.bundleId = bundleId;

  base.confidence = 'high';
  return base;
}

/**
 * The harness.env exports this introspection can fill in. Keys absent from the
 * result are left at their template value rather than blanked.
 */
export function xcodeHarnessEnvValues(info: XcodeProjectInfo): Record<string, string> {
  const values: Record<string, string> = {};
  // Only one of the two is ever set: verify.sh prefers the workspace when both are.
  if (info.workspace) values.HARNESS_XCODE_WORKSPACE = info.workspace;
  else if (info.project) values.HARNESS_XCODE_PROJECT = info.project;
  if (info.scheme) values.HARNESS_XCODE_SCHEME = info.scheme;
  if (info.bundleId) values.HARNESS_BUNDLE_ID = info.bundleId;
  return values;
}
