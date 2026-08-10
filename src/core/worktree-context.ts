import { execSync } from 'child_process';
import { resolveCheckoutRoot } from '../utils/git';

/**
 * A session worktree only materialises what is in `HEAD` — anything untracked or
 * ignored stays behind in the main checkout. That is correct for dependencies and
 * build output, and silently wrong for agent instructions (an agent launched in a
 * worktree never learns the project rules) and for local build config (the build
 * fails there for no visible reason).
 *
 * This module names the second and third case at preflight time so the failure is
 * loud instead of silent.
 */

/**
 * `scan-limit` is a scan diagnostic rather than a missing path: it names the
 * directories the expansion pass stopped short of, so a partial scan never reads
 * as a clean one.
 */
export type WorktreeContextCategory = 'agent-context' | 'local-config' | 'scan-limit';

export interface WorktreeContextFinding {
  category: WorktreeContextCategory;
  /** Repo-relative paths; directories keep their trailing slash. */
  paths: string[];
  /** Paths left out of `paths` because the list was capped. */
  omitted: number;
}

export interface DetectWorktreeContextOptions {
  /** Repo-relative paths or prefixes to treat as expected-absent (HARNESS_WORKTREE_CONTEXT_IGNORE). */
  ignore?: string[];
  /** Repo-relative paths or prefixes this project treats as agent context (HARNESS_WORKTREE_CONTEXT_PATHS). */
  extraContext?: string[];
  /** Paths listed per category before the rest are summarised as a count. */
  maxPathsPerCategory?: number;
  /** Directories the expansion pass may open; the remainder is reported as `scan-limit`. */
  maxExpandedDirectories?: number;
}

/** Dependency and build directories that are meant to be absent from a worktree. */
const NOISE_DIRS = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.build',
  'DerivedData',
  'Pods',
  'Carthage',
  '.swiftpm',
  '.gradle',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.idea',
  '.vscode',
  '.terraform',
]);

const NOISE_BASENAMES = new Set(['.DS_Store', 'Thumbs.db', '.eslintcache']);

/** Written by the harness itself — absent from a fresh worktree by design. */
const HARNESS_GENERATED_PREFIXES = [
  '.har/runs',
  '.har/artifacts',
  '.har/slots',
  '.har/venv',
  '.har/simulators',
];

const HARNESS_GENERATED_BASENAMES = [/^\.env\.agent\./, /^ecosystem\.agent\..+\.config\.cjs$/];

/** Agent state that is machine-local by design — untracked on purpose, not a gap. */
const LOCAL_AGENT_STATE = new Set([
  '.claude/settings.local.json',
  '.claude/.credentials.json',
  '.cursor/mcp.json',
  '.codex/auth.json',
]);

/** Instruction files coding agents load by name. */
const CONTEXT_BASENAMES = new Set([
  'CLAUDE.md',
  'AGENTS.md',
  'GEMINI.md',
  'CONVENTIONS.md',
  'copilot-instructions.md',
  '.cursorrules',
  '.windsurfrules',
  '.aider.conf.yml',
]);

/** Top-level directories owned by a coding agent. */
const CONTEXT_DIRS = new Set(['.claude', '.cursor', '.codex', '.gemini', '.aider', '.opencode']);

/** Top-level directories whose markdown is project documentation, not scratch notes. */
const DOC_DIRS = new Set(['docs', 'doc', 'documentation', 'spec', 'specs', 'adr']);

/** Local build configuration and credentials a worktree build would need. */
const CONFIG_BASENAMES = new Set([
  '.env',
  '.npmrc',
  '.netrc',
  'local.properties',
  'gradle.properties',
  'GoogleService-Info.plist',
  'google-services.json',
]);

const CONFIG_PATTERNS = [
  /^\.env\..+/,
  /\.xcconfig$/,
  /\.mobileprovision$/,
  /\.(p8|p12|pem|keystore|jks)$/,
  /^[Ss]ecrets?\./,
];

/** Committed placeholders, not the real thing — their absence breaks no build. */
const TEMPLATE_SUFFIXES = ['.example', '.sample', '.template', '.dist', '.default'];

/** Directories the second pass expands; the remainder is reported, never dropped silently. */
const MAX_EXPANDED_DIRS = 200;

function listUntracked(toplevel: string, args: string): string[] {
  try {
    // --literal-pathspecs: a directory named `assets[old]` is a path, not a glob.
    const raw = execSync(`git --literal-pathspecs ls-files --others -z ${args}`, {
      cwd: toplevel,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return raw.split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Everything present on disk but absent from a fresh worktree: untracked *and*
 * ignored (no `--exclude-standard`), with fully untracked directories collapsed
 * to a single entry (`--directory`) so a `node_modules` walk never happens.
 */
function listAbsentFromWorktree(toplevel: string): string[] {
  return listUntracked(toplevel, '--directory');
}

/**
 * Contents of directories the first pass collapsed without recognising — that is
 * where an otherwise-untracked `Config/Secrets.xcconfig` hides. One call per
 * directory: an oversized or slow directory then costs only its own results.
 */
function listAbsentUnder(toplevel: string, directories: string[]): string[] {
  const entries: string[] = [];
  for (const dir of directories) {
    const pathspec = `'${dir.replace(/'/g, `'\\''`)}'`;
    entries.push(...listUntracked(toplevel, `-- ${pathspec}`));
  }
  return entries;
}

function isNoise(normalized: string, segments: string[], basename: string): boolean {
  if (NOISE_BASENAMES.has(basename)) return true;
  if (LOCAL_AGENT_STATE.has(normalized)) return true;
  if (segments.some((segment) => NOISE_DIRS.has(segment))) return true;
  if (HARNESS_GENERATED_BASENAMES.some((pattern) => pattern.test(basename))) return true;
  return HARNESS_GENERATED_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

function isAgentContext(
  normalized: string,
  segments: string[],
  basename: string,
  isDirectory: boolean,
  extraContext: string[],
): boolean {
  if (matchesPrefix(normalized, extraContext)) return true;
  if (CONTEXT_BASENAMES.has(basename)) return true;
  if (CONTEXT_DIRS.has(segments[0])) return true;
  // Root-level markdown: PRODUCT.md, design.md, and anything else a `*.md` ignore rule swallows.
  if (segments.length === 1 && basename.endsWith('.md')) return true;
  if (segments.length === 1 && isDirectory && DOC_DIRS.has(basename)) return true;
  return DOC_DIRS.has(segments[0]) && basename.endsWith('.md');
}

function isLocalConfig(basename: string): boolean {
  if (TEMPLATE_SUFFIXES.some((suffix) => basename.endsWith(suffix))) return false;
  if (CONFIG_BASENAMES.has(basename)) return true;
  return CONFIG_PATTERNS.some((pattern) => pattern.test(basename));
}

function matchesPrefix(normalized: string, prefixes: string[]): boolean {
  return prefixes.some((raw) => {
    const prefix = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    return prefix !== '' && (normalized === prefix || normalized.startsWith(`${prefix}/`));
  });
}

/** True when the entry is *meant* to be absent — dependency output, harness state, or opted out. */
function isDropped(normalized: string, ignore: string[]): boolean {
  if (normalized === '') return true;
  if (matchesPrefix(normalized, ignore)) return true;
  const segments = normalized.split('/');
  return isNoise(normalized, segments, segments[segments.length - 1]);
}

function normalizeEntry(entry: string): string {
  return entry.endsWith('/') ? entry.slice(0, -1) : entry;
}

function classify(
  entry: string,
  options: { ignore: string[]; extraContext: string[] },
): WorktreeContextCategory | undefined {
  const isDirectory = entry.endsWith('/');
  const normalized = normalizeEntry(entry);
  if (isDropped(normalized, options.ignore)) return undefined;

  const segments = normalized.split('/');
  const basename = segments[segments.length - 1];

  if (isAgentContext(normalized, segments, basename, isDirectory, options.extraContext)) {
    return 'agent-context';
  }
  if (isLocalConfig(basename)) return 'local-config';
  return undefined;
}

/**
 * Paths that exist in `repoPath` but would be missing from a session worktree,
 * limited to the categories where that absence is a defect. Returns `[]` outside
 * a git checkout, and never throws — this is advisory, it must not fail a launch.
 */
export function detectMissingWorktreeContext(
  repoPath: string,
  options: DetectWorktreeContextOptions = {},
): WorktreeContextFinding[] {
  const toplevel = resolveCheckoutRoot(repoPath);
  if (!toplevel) return [];

  const classifyOptions = {
    ignore: options.ignore ?? [],
    extraContext: options.extraContext ?? [],
  };
  const maxPaths = options.maxPathsPerCategory ?? 6;
  const grouped = new Map<WorktreeContextCategory, string[]>();
  const unrecognisedDirs: string[] = [];

  const collect = (entry: string): WorktreeContextCategory | undefined => {
    const category = classify(entry, classifyOptions);
    if (!category) return undefined;
    const paths = grouped.get(category) ?? [];
    paths.push(entry);
    grouped.set(category, paths);
    return category;
  };

  for (const entry of listAbsentFromWorktree(toplevel)) {
    if (collect(entry)) continue;
    if (entry.endsWith('/') && !isDropped(normalizeEntry(entry), classifyOptions.ignore)) {
      unrecognisedDirs.push(entry);
    }
  }
  const maxDirs = options.maxExpandedDirectories ?? MAX_EXPANDED_DIRS;
  for (const entry of listAbsentUnder(toplevel, unrecognisedDirs.slice(0, maxDirs))) {
    collect(entry);
  }
  // A partial scan must never read as a clean one.
  if (unrecognisedDirs.length > maxDirs) {
    grouped.set('scan-limit', unrecognisedDirs.slice(maxDirs));
  }

  const order: WorktreeContextCategory[] = ['agent-context', 'local-config', 'scan-limit'];
  return order.flatMap((category) => {
    const paths = grouped.get(category);
    if (!paths || paths.length === 0) return [];
    paths.sort(); // Codepoint order — locale-independent, so output is identical on every machine.
    return [
      {
        category,
        paths: paths.slice(0, maxPaths),
        omitted: Math.max(0, paths.length - maxPaths),
      },
    ];
  });
}

const CATEGORY_MESSAGE: Record<
  WorktreeContextCategory,
  (total: number, listed: string) => string
> = {
  'agent-context': (total, listed) => {
    const it = total === 1 ? 'it' : 'them';
    return (
      `${total} agent-context path${total === 1 ? '' : 's'} untracked — absent from every ` +
      `session worktree: ${listed}. Agents launched in a worktree never read ${it} — ` +
      `track ${it} in git, or launch with --no-worktree.`
    );
  },
  'local-config': (total, listed) => {
    const it = total === 1 ? 'it' : 'them';
    return (
      `${total} local-config path${total === 1 ? '' : 's'} untracked — absent from every ` +
      `session worktree: ${listed}. Builds that need ${it} fail inside the worktree — ` +
      `track ${it}, or copy ${it} in after launch.`
    );
  },
  'scan-limit': (total, listed) =>
    `${total} untracked director${total === 1 ? 'y was' : 'ies were'} left unscanned: ` +
    `${listed}. Their contents were not checked — narrow the scan with ` +
    `HARNESS_WORKTREE_CONTEXT_IGNORE.`,
};

/** One `warnings` line per category, in the shape `formatPreflightReport` prints. */
export function formatWorktreeContextWarnings(findings: WorktreeContextFinding[]): string[] {
  return findings.map((finding) => {
    const total = finding.paths.length + finding.omitted;
    const suffix = finding.omitted > 0 ? ` (+${finding.omitted} more)` : '';
    return CATEGORY_MESSAGE[finding.category](total, finding.paths.join(', ') + suffix);
  });
}
