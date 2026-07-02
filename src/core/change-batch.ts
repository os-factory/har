import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { run } from '../utils/shell';
import { ChangedFile, ChangedFileStatus } from '../harness/schema';

export interface ChangeBatchSnapshot {
  treeHash: string;
  headSha?: string;
  branch?: string;
  changedFiles: ChangedFile[];
}

function git(checkoutDir: string, args: string, env?: NodeJS.ProcessEnv): string {
  const result = run(`git ${args}`, { cwd: checkoutDir, env });
  if (result.code !== 0) {
    throw new Error(`git ${args} failed (${result.code}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function tryGit(checkoutDir: string, args: string): string | undefined {
  const result = run(`git ${args}`, { cwd: checkoutDir });
  return result.code === 0 ? result.stdout.trim() : undefined;
}

export function isGitCheckout(checkoutDir: string): boolean {
  return tryGit(checkoutDir, 'rev-parse --is-inside-work-tree') === 'true';
}

/**
 * True when dir is the top level of a git checkout (main or linked worktree).
 * Tree hashes are only meaningful for whole checkouts, not subdirectories.
 */
export function isCheckoutRoot(checkoutDir: string): boolean {
  const toplevel = tryGit(checkoutDir, 'rev-parse --show-toplevel');
  if (!toplevel) return false;
  try {
    return fs.realpathSync(toplevel) === fs.realpathSync(checkoutDir);
  } catch {
    return false;
  }
}

/** SHA of HEAD's tree, or undefined on an unborn HEAD (no commits yet). */
export function getHeadTree(checkoutDir: string): string | undefined {
  return tryGit(checkoutDir, 'rev-parse -q --verify HEAD^{tree}');
}

export function getHeadSha(checkoutDir: string): string | undefined {
  return tryGit(checkoutDir, 'rev-parse -q --verify HEAD');
}

export function getCurrentBranch(checkoutDir: string): string | undefined {
  const branch = tryGit(checkoutDir, 'rev-parse --abbrev-ref HEAD');
  return branch && branch !== 'HEAD' ? branch : undefined;
}

/** Tree SHA of the empty tree for whatever object format this repo uses. */
function getEmptyTree(checkoutDir: string): string {
  return git(checkoutDir, 'hash-object -t tree /dev/null');
}

export function isMergeOrRebaseInProgress(checkoutDir: string): boolean {
  if (tryGit(checkoutDir, 'rev-parse -q --verify MERGE_HEAD') !== undefined) return true;
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    const gitPath = tryGit(checkoutDir, `rev-parse --git-path ${dir}`);
    if (gitPath && fs.existsSync(path.resolve(checkoutDir, gitPath))) return true;
  }
  return false;
}

/**
 * Tree SHA of the real index — exactly what `git commit` would record.
 * Throws on unmerged entries (conflict in progress).
 */
export function computeStagedTree(checkoutDir: string): string {
  return git(checkoutDir, 'write-tree');
}

function parseNameStatus(output: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0]?.charAt(0) as ChangedFileStatus;
    if (!status) continue;
    if ((status === 'R' || status === 'C') && parts.length >= 3) {
      files.push({ path: parts[2], status, oldPath: parts[1] });
    } else if (parts.length >= 2) {
      files.push({ path: parts[1], status });
    }
  }
  return files;
}

/**
 * Hash the full working tree (tracked changes, untracked files, deletions)
 * without touching the real index: a temp GIT_INDEX_FILE primed from HEAD,
 * `git add -A`, then `write-tree`. Because `add` runs the normal filter/CRLF
 * pipeline, the result is byte-comparable with `computeStagedTree` at commit
 * time for the same content.
 */
export function computeWorktreeSnapshot(checkoutDir: string): ChangeBatchSnapshot {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-idx-'));
  const tmpIndex = path.join(tmpDir, 'index');
  const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: tmpIndex };

  try {
    const headTree = getHeadTree(checkoutDir);
    if (headTree) {
      git(checkoutDir, 'read-tree HEAD', env);
    } else {
      git(checkoutDir, 'read-tree --empty', env);
    }
    git(checkoutDir, 'add -A .', env);
    const treeHash = git(checkoutDir, 'write-tree', env);

    const baseTree = headTree ?? getEmptyTree(checkoutDir);
    const diffOutput =
      baseTree === treeHash
        ? ''
        : git(
            checkoutDir,
            `diff-tree -r -M --name-status --ignore-submodules=all ${baseTree} ${treeHash}`,
          );

    return {
      treeHash,
      headSha: getHeadSha(checkoutDir),
      branch: getCurrentBranch(checkoutDir),
      changedFiles: parseNameStatus(diffOutput),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
