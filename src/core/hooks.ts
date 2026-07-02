import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { run } from '../utils/shell';
import { CommitGateConfig, CommitGateConfigSchema } from '../harness/schema';
import { readStageRegistry } from '../harness/stages';
import {
  computeStagedTree,
  getCurrentBranch,
  getHeadSha,
  getHeadTree,
  isMergeOrRebaseInProgress,
} from './change-batch';
import { attachCommit, ensureValidationsIgnored, findValidation } from './validations';
import { syncRepoWithControlAsync } from './control-sync';

const MARKER_START = '# >>> har commit gate (managed by `har hooks`) >>>';
const MARKER_END = '# <<< har commit gate <<<';

const PRE_COMMIT_BLOCK = [
  MARKER_START,
  'if [ "$HAR_SKIP_GATE" != "1" ]; then',
  '  "$(git rev-parse --git-path hooks)/har-pre-commit" || exit 1',
  'fi',
  MARKER_END,
].join('\n');

const POST_COMMIT_BLOCK = [
  MARKER_START,
  '"$(git rev-parse --git-path hooks)/har-post-commit" || true',
  MARKER_END,
].join('\n');

function tryGit(cwd: string, args: string): string | undefined {
  const result = run(`git ${args}`, { cwd });
  return result.code === 0 ? result.stdout.trim() : undefined;
}

export function resolveCheckoutRoot(cwd: string): string | undefined {
  return tryGit(cwd, 'rev-parse --show-toplevel');
}

export function resolveHooksDir(checkoutDir: string): string {
  const hooksPath = tryGit(checkoutDir, 'rev-parse --git-path hooks');
  if (!hooksPath) throw new Error(`Not a git checkout: ${checkoutDir}`);
  return path.resolve(checkoutDir, hooksPath);
}

function getConfiguredHooksPath(checkoutDir: string): string | undefined {
  return tryGit(checkoutDir, 'config core.hooksPath') || undefined;
}

/** Command line baked into the hook script that re-enters this CLI. */
export function defaultHarInvocation(): string {
  const entry = process.argv[1];
  if (entry && entry.endsWith('.js')) {
    return `"${process.execPath}" "${path.resolve(entry)}"`;
  }
  if (entry) return `"${path.resolve(entry)}"`;
  return 'har';
}

function buildHookScript(harInvocation: string, subcommand: string, failOpenNotice: string): string {
  return `#!/bin/sh
# Managed by \`har hooks\` — do not edit; reinstall with \`har hooks install\`.
if ${harInvocation} --version >/dev/null 2>&1; then
  exec ${harInvocation} hooks ${subcommand}
fi
if command -v har >/dev/null 2>&1; then
  exec har hooks ${subcommand}
fi
toplevel="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -n "$toplevel" ] && [ -x "$toplevel/node_modules/.bin/har" ]; then
  exec "$toplevel/node_modules/.bin/har" hooks ${subcommand}
fi
echo "${failOpenNotice}" >&2
exit 0
`;
}

function upsertMarkedBlock(filePath: string, block: string): 'created' | 'appended' | 'updated' {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `#!/bin/sh\n${block}\n`, { mode: 0o755 });
    return 'created';
  }

  const content = fs.readFileSync(filePath, 'utf8');
  if (content.includes(MARKER_START)) {
    const pattern = new RegExp(
      `${escapeRegExp(MARKER_START)}[\\s\\S]*?${escapeRegExp(MARKER_END)}`,
    );
    fs.writeFileSync(filePath, content.replace(pattern, block));
    fs.chmodSync(filePath, 0o755);
    return 'updated';
  }

  const suffix = content.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(filePath, `${content}${suffix}\n${block}\n`);
  fs.chmodSync(filePath, 0o755);
  return 'appended';
}

function removeMarkedBlock(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.includes(MARKER_START)) return false;

  const pattern = new RegExp(
    `\\n?${escapeRegExp(MARKER_START)}[\\s\\S]*?${escapeRegExp(MARKER_END)}\\n?`,
  );
  const stripped = content.replace(pattern, '\n');
  if (stripped.replace(/^#!\/bin\/sh\n?/, '').trim() === '') {
    fs.rmSync(filePath);
  } else {
    fs.writeFileSync(filePath, stripped);
  }
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface InstallHooksOptions {
  repoPath: string;
  force?: boolean;
  /** Override the baked har invocation (used by tests). */
  harInvocation?: string;
}

export interface InstallHooksResult {
  hooksDir: string;
  preCommit: 'created' | 'appended' | 'updated';
  postCommit: 'created' | 'appended' | 'updated';
}

export function installHooks(options: InstallHooksOptions): InstallHooksResult {
  const checkout = resolveCheckoutRoot(options.repoPath);
  if (!checkout) throw new Error(`Not a git repository: ${options.repoPath}`);

  const configuredHooksPath = getConfiguredHooksPath(checkout);
  if (configuredHooksPath && !options.force) {
    throw new Error(
      `core.hooksPath is set to "${configuredHooksPath}" (managed hooks, e.g. husky).\n` +
        `Add this to your managed pre-commit hook instead:\n\n` +
        `  ${PRE_COMMIT_BLOCK.split('\n').join('\n  ')}\n\n` +
        `Or re-run with --force to write into that directory anyway.`,
    );
  }

  const hooksDir = resolveHooksDir(checkout);
  fs.mkdirSync(hooksDir, { recursive: true });

  const invocation = options.harInvocation ?? defaultHarInvocation();
  fs.writeFileSync(
    path.join(hooksDir, 'har-pre-commit'),
    buildHookScript(invocation, 'check', 'har: binary not found; skipping commit gate (reinstall with har hooks install)'),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(hooksDir, 'har-post-commit'),
    buildHookScript(invocation, 'record-commit', 'har: binary not found; skipping commit association'),
    { mode: 0o755 },
  );

  const preCommit = upsertMarkedBlock(path.join(hooksDir, 'pre-commit'), PRE_COMMIT_BLOCK);
  const postCommit = upsertMarkedBlock(path.join(hooksDir, 'post-commit'), POST_COMMIT_BLOCK);

  ensureValidationsIgnored(checkout);

  return { hooksDir, preCommit, postCommit };
}

export function uninstallHooks(repoPath: string): { hooksDir: string; removed: boolean } {
  const checkout = resolveCheckoutRoot(repoPath);
  if (!checkout) throw new Error(`Not a git repository: ${repoPath}`);

  const hooksDir = resolveHooksDir(checkout);
  let removed = false;
  removed = removeMarkedBlock(path.join(hooksDir, 'pre-commit')) || removed;
  removed = removeMarkedBlock(path.join(hooksDir, 'post-commit')) || removed;
  for (const file of ['har-pre-commit', 'har-post-commit']) {
    const full = path.join(hooksDir, file);
    if (fs.existsSync(full)) {
      fs.rmSync(full);
      removed = true;
    }
  }
  return { hooksDir, removed };
}

export interface HooksStatus {
  checkout: string;
  hooksDir: string;
  configuredHooksPath?: string;
  preCommitInstalled: boolean;
  postCommitInstalled: boolean;
  gate: CommitGateConfig;
  effectiveMode: 'block' | 'warn' | 'off';
}

export function getCommitGateConfig(checkoutDir: string): CommitGateConfig {
  try {
    const registry = readStageRegistry(checkoutDir);
    return CommitGateConfigSchema.parse(registry.commitGate ?? {});
  } catch {
    return CommitGateConfigSchema.parse({});
  }
}

/** True when this checkout is a har agent worktree (har-agent-N branch or slot worktree path). */
export function isAgentWorktree(checkoutDir: string): boolean {
  const branch = getCurrentBranch(checkoutDir);
  if (branch && /^har-agent-\d+$/.test(branch)) return true;

  const worktreesRoot = path.join(os.homedir(), 'worktrees');
  const resolved = path.resolve(checkoutDir);
  return resolved.startsWith(`${worktreesRoot}${path.sep}`) && /-agent-\d+$/.test(path.basename(resolved));
}

export function resolveEffectiveMode(checkoutDir: string, gate: CommitGateConfig): 'block' | 'warn' | 'off' {
  if (!gate.enabled) return 'off';
  if (gate.scope === 'all') return gate.mode;
  return isAgentWorktree(checkoutDir) ? gate.mode : 'warn';
}

export function getHooksStatus(repoPath: string): HooksStatus {
  const checkout = resolveCheckoutRoot(repoPath);
  if (!checkout) throw new Error(`Not a git repository: ${repoPath}`);

  const hooksDir = resolveHooksDir(checkout);
  const gate = getCommitGateConfig(checkout);
  const hasBlock = (name: string) => {
    const file = path.join(hooksDir, name);
    return fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(MARKER_START);
  };

  return {
    checkout,
    hooksDir,
    configuredHooksPath: getConfiguredHooksPath(checkout),
    preCommitInstalled: hasBlock('pre-commit') && fs.existsSync(path.join(hooksDir, 'har-pre-commit')),
    postCommitInstalled: hasBlock('post-commit') && fs.existsSync(path.join(hooksDir, 'har-post-commit')),
    gate,
    effectiveMode: resolveEffectiveMode(checkout, gate),
  };
}

export interface GateCheckResult {
  exitCode: number;
  messages: string[];
}

/** Pre-commit gate: is the staged tree covered by a passing full verification? */
export function checkCommitGate(cwd: string): GateCheckResult {
  if (process.env.HAR_SKIP_GATE === '1') {
    return { exitCode: 0, messages: ['har: commit gate skipped (HAR_SKIP_GATE=1)'] };
  }

  const checkout = resolveCheckoutRoot(cwd);
  if (!checkout) return { exitCode: 0, messages: [] };

  if (!fs.existsSync(path.join(checkout, '.har', 'stages.json'))) {
    return { exitCode: 0, messages: [] };
  }

  const gate = getCommitGateConfig(checkout);
  const mode = resolveEffectiveMode(checkout, gate);
  if (mode === 'off') return { exitCode: 0, messages: [] };

  if (!getHeadSha(checkout)) {
    return { exitCode: 0, messages: ['har: commit gate skipped (initial commit)'] };
  }
  if (isMergeOrRebaseInProgress(checkout)) {
    return { exitCode: 0, messages: ['har: commit gate skipped (merge/rebase in progress)'] };
  }

  let stagedTree: string;
  try {
    stagedTree = computeStagedTree(checkout);
  } catch {
    return { exitCode: 0, messages: ['har: commit gate skipped (index has unmerged entries)'] };
  }

  if (stagedTree === getHeadTree(checkout)) {
    return { exitCode: 0, messages: [] };
  }

  const record = findValidation(checkout, stagedTree);
  if (record && record.status === 'pass' && record.full) {
    return {
      exitCode: 0,
      messages: [
        `har: batch ${stagedTree.slice(0, 8)} verified${record.runId ? ` by run ${record.runId.slice(0, 8)}` : ''} ✓`,
      ],
    };
  }

  const messages: string[] = [];
  const verb = mode === 'block' ? 'commit blocked' : 'warning';
  messages.push(
    `har: ${verb} — no passing verification for this exact change batch (tree ${stagedTree.slice(0, 8)}).`,
  );
  if (record && record.status === 'fail') {
    messages.push(
      `  This exact batch was verified and FAILED${record.runId ? ` (run ${record.runId.slice(0, 8)})` : ''}. Fix and re-run.`,
    );
  } else if (record && !record.full) {
    messages.push(
      `  This batch only passed a partial verify${record.runId ? ` (run ${record.runId.slice(0, 8)})` : ''}; the gate requires --full.`,
    );
  }
  messages.push('  Run the full pipeline:   har env verify <agentId> --full');
  messages.push(
    '  Note: verify hashes the WORKING TREE — stage exactly what you verified (git add -A).',
  );
  messages.push('  Bypass (humans only):    HAR_SKIP_GATE=1 git commit …   or   git commit --no-verify');
  messages.push('  Configure via commitGate { mode: block|warn, scope: worktrees|all } in .har/stages.json');

  return { exitCode: mode === 'block' ? 1 : 0, messages };
}

/** Post-commit: associate the new commit with the validation for its tree. */
export function recordCommitAssociation(cwd: string): { attached: boolean; commitSha?: string } {
  try {
    const checkout = resolveCheckoutRoot(cwd);
    if (!checkout) return { attached: false };

    const commitSha = getHeadSha(checkout);
    const tree = tryGit(checkout, 'rev-parse HEAD^{tree}');
    if (!commitSha || !tree) return { attached: false };

    const updated = attachCommit(checkout, tree, commitSha);
    if (updated) {
      syncRepoWithControlAsync(updated.harnessRoot);
      return { attached: true, commitSha };
    }
    return { attached: false, commitSha };
  } catch {
    return { attached: false };
  }
}
