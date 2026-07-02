import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  checkCommitGate,
  getHooksStatus,
  installHooks,
  isAgentWorktree,
  recordCommitAssociation,
  uninstallHooks,
} from '../src/core/hooks';
import { recordValidation, findValidation } from '../src/core/validations';

function sh(cwd: string, command: string, env: NodeJS.ProcessEnv = {}): string {
  return execSync(command, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  }).trim();
}

function initRepo(gate?: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-hooks-'));
  sh(dir, 'git init -q -b main');
  sh(dir, 'git config user.email har@test.local');
  sh(dir, 'git config user.name har');
  fs.mkdirSync(path.join(dir, '.har'));
  fs.writeFileSync(path.join(dir, '.har', '.gitignore'), 'runs/\nvalidations/\n');
  fs.writeFileSync(
    path.join(dir, '.har', 'stages.json'),
    JSON.stringify({ version: '1', stages: [], ...(gate ? { commitGate: gate } : {}) }),
  );
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  sh(dir, 'git add -A');
  sh(dir, 'git commit -q -m init');
  return dir;
}

function addAgentWorktree(dir: string, id = 1): string {
  const worktree = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'har-hooks-wt-')), 'wt');
  sh(dir, `git worktree add -q "${worktree}" -b har-agent-${id}`);
  return worktree;
}

describe('checkCommitGate', () => {
  it('allows when nothing is staged beyond HEAD', () => {
    const dir = initRepo();
    expect(checkCommitGate(dir).exitCode).toBe(0);
  });

  it('blocks unverified staged changes in an agent worktree', () => {
    const dir = initRepo();
    const worktree = addAgentWorktree(dir);
    fs.writeFileSync(path.join(worktree, 'a.txt'), 'changed\n');
    sh(worktree, 'git add -A');

    const result = checkCommitGate(worktree);
    expect(result.exitCode).toBe(1);
    expect(result.messages.join('\n')).toContain('commit blocked');
    expect(result.messages.join('\n')).toContain('har env verify');
  });

  it('warns (exit 0) in the main checkout under default worktrees scope', () => {
    const dir = initRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    sh(dir, 'git add -A');

    const result = checkCommitGate(dir);
    expect(result.exitCode).toBe(0);
    expect(result.messages.join('\n')).toContain('warning');
  });

  it('blocks in the main checkout with scope=all', () => {
    const dir = initRepo({ scope: 'all' });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    sh(dir, 'git add -A');
    expect(checkCommitGate(dir).exitCode).toBe(1);
  });

  it('allows a batch with a passing full validation', () => {
    const dir = initRepo();
    const worktree = addAgentWorktree(dir);
    fs.writeFileSync(path.join(worktree, 'a.txt'), 'verified change\n');
    recordValidation({ checkoutDir: worktree, harnessRoot: dir, status: 'pass', full: true });
    sh(worktree, 'git add -A');

    const result = checkCommitGate(worktree);
    expect(result.exitCode).toBe(0);
    expect(result.messages.join('\n')).toContain('verified');
  });

  it('rejects fail and partial validations with specific messages', () => {
    const dir = initRepo();
    const worktree = addAgentWorktree(dir);

    fs.writeFileSync(path.join(worktree, 'a.txt'), 'failed change\n');
    recordValidation({ checkoutDir: worktree, harnessRoot: dir, status: 'fail', full: true });
    sh(worktree, 'git add -A');
    expect(checkCommitGate(worktree).messages.join('\n')).toContain('FAILED');

    fs.writeFileSync(path.join(worktree, 'a.txt'), 'partial change\n');
    recordValidation({ checkoutDir: worktree, harnessRoot: dir, status: 'pass', full: false });
    sh(worktree, 'git add -A');
    const partial = checkCommitGate(worktree);
    expect(partial.exitCode).toBe(1);
    expect(partial.messages.join('\n')).toContain('partial verify');
  });

  it('partial staging of a verified batch is blocked', () => {
    const dir = initRepo();
    const worktree = addAgentWorktree(dir);
    fs.writeFileSync(path.join(worktree, 'a.txt'), 'change one\n');
    fs.writeFileSync(path.join(worktree, 'b.txt'), 'change two\n');
    recordValidation({ checkoutDir: worktree, harnessRoot: dir, status: 'pass', full: true });

    sh(worktree, 'git add a.txt');
    expect(checkCommitGate(worktree).exitCode).toBe(1);
  });

  it('respects HAR_SKIP_GATE, disabled gate, warn mode, and non-harness repos', () => {
    const dir = initRepo();
    const worktree = addAgentWorktree(dir);
    fs.writeFileSync(path.join(worktree, 'a.txt'), 'changed\n');
    sh(worktree, 'git add -A');

    process.env.HAR_SKIP_GATE = '1';
    try {
      expect(checkCommitGate(worktree).exitCode).toBe(0);
    } finally {
      delete process.env.HAR_SKIP_GATE;
    }

    const disabled = initRepo({ enabled: false });
    fs.writeFileSync(path.join(disabled, 'a.txt'), 'changed\n');
    sh(disabled, 'git add -A');
    expect(checkCommitGate(disabled).exitCode).toBe(0);

    const warnRepo = initRepo({ mode: 'warn', scope: 'all' });
    fs.writeFileSync(path.join(warnRepo, 'a.txt'), 'changed\n');
    sh(warnRepo, 'git add -A');
    const warned = checkCommitGate(warnRepo);
    expect(warned.exitCode).toBe(0);
    expect(warned.messages.length).toBeGreaterThan(0);

    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'har-hooks-plain-'));
    sh(plain, 'git init -q');
    expect(checkCommitGate(plain).exitCode).toBe(0);
  });

  it('skips the gate during a merge', () => {
    const dir = initRepo({ scope: 'all' });
    sh(dir, 'git checkout -q -b feature');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'feature\n');
    sh(dir, 'git add -A && git commit -q -m feature');
    sh(dir, 'git checkout -q main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'main\n');
    sh(dir, 'git add -A && git commit -q -m main');
    try {
      sh(dir, 'git merge feature');
    } catch {
      // conflict expected
    }

    const result = checkCommitGate(dir);
    expect(result.exitCode).toBe(0);
    expect(result.messages.join('\n')).toContain('merge/rebase');
  });
});

describe('isAgentWorktree', () => {
  it('detects har-agent-N branches', () => {
    const dir = initRepo();
    expect(isAgentWorktree(dir)).toBe(false);
    const worktree = addAgentWorktree(dir, 3);
    expect(isAgentWorktree(worktree)).toBe(true);
  });
});

describe('install/uninstall/status', () => {
  it('installs marked blocks, chains existing hooks, and uninstalls cleanly', () => {
    const dir = initRepo();
    const hooksDir = path.join(dir, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\necho existing-hook\n', {
      mode: 0o755,
    });

    const result = installHooks({ repoPath: dir, harInvocation: 'har' });
    expect(result.preCommit).toBe('appended');
    expect(result.postCommit).toBe('created');

    const preCommit = fs.readFileSync(path.join(hooksDir, 'pre-commit'), 'utf8');
    expect(preCommit).toContain('echo existing-hook');
    expect(preCommit).toContain('har commit gate');
    expect(fs.existsSync(path.join(hooksDir, 'har-pre-commit'))).toBe(true);

    // reinstall is idempotent
    expect(installHooks({ repoPath: dir, harInvocation: 'har' }).preCommit).toBe('updated');
    const status = getHooksStatus(dir);
    expect(status.preCommitInstalled).toBe(true);
    expect(status.postCommitInstalled).toBe(true);
    expect(status.effectiveMode).toBe('warn');

    const removed = uninstallHooks(dir);
    expect(removed.removed).toBe(true);
    const after = fs.readFileSync(path.join(hooksDir, 'pre-commit'), 'utf8');
    expect(after).toContain('echo existing-hook');
    expect(after).not.toContain('har commit gate');
    expect(fs.existsSync(path.join(hooksDir, 'post-commit'))).toBe(false);
    expect(fs.existsSync(path.join(hooksDir, 'har-pre-commit'))).toBe(false);
  });

  it('refuses when core.hooksPath is set unless --force', () => {
    const dir = initRepo();
    sh(dir, 'git config core.hooksPath .husky');
    expect(() => installHooks({ repoPath: dir })).toThrow(/core\.hooksPath/);
    const forced = installHooks({ repoPath: dir, force: true, harInvocation: 'har' });
    expect(forced.hooksDir).toBe(path.join(dir, '.husky'));
  });
});

describe('end-to-end git commit with installed hooks', () => {
  const cli = path.resolve(__dirname, '..', 'dist', 'index.js');
  const hasBuild = fs.existsSync(cli);
  const invocation = `"${process.execPath}" "${cli}"`;
  const maybeIt = hasBuild ? it : it.skip;

  maybeIt('blocks unverified commits in an agent worktree, allows verified ones, records commitSha', () => {
    const dir = initRepo();
    installHooks({ repoPath: dir, harInvocation: invocation });
    const worktree = addAgentWorktree(dir);

    fs.writeFileSync(path.join(worktree, 'a.txt'), 'unverified\n');
    sh(worktree, 'git add -A');
    expect(() => sh(worktree, 'git commit -q -m blocked')).toThrow(/commit blocked/);

    // --no-verify bypasses
    sh(worktree, 'git commit -q --no-verify -m bypassed');

    fs.writeFileSync(path.join(worktree, 'a.txt'), 'verified\n');
    const record = recordValidation({
      checkoutDir: worktree,
      harnessRoot: dir,
      status: 'pass',
      full: true,
    });
    sh(worktree, 'git add -A');
    sh(worktree, 'git commit -q -m verified', { HAR_CONTROL_DISABLED: 'true' });

    const commitSha = sh(worktree, 'git rev-parse HEAD');
    expect(findValidation(worktree, record.treeHash)?.commitSha).toBe(commitSha);
    expect(findValidation(dir, record.treeHash)?.commitSha).toBe(commitSha);
  });

  maybeIt('HAR_SKIP_GATE=1 bypasses the gate', () => {
    const dir = initRepo();
    installHooks({ repoPath: dir, harInvocation: invocation });
    const worktree = addAgentWorktree(dir);
    fs.writeFileSync(path.join(worktree, 'a.txt'), 'skipped\n');
    sh(worktree, 'git add -A');
    sh(worktree, 'git commit -q -m skipped', { HAR_SKIP_GATE: '1' });
  });
});

describe('recordCommitAssociation', () => {
  it('attaches the commit sha to the matching validation', async () => {
    const dir = initRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'change\n');
    const record = recordValidation({ checkoutDir: dir, harnessRoot: dir, status: 'pass', full: true });
    sh(dir, 'git add -A');
    sh(dir, 'git commit -q -m change');

    const result = await recordCommitAssociation(dir);
    expect(result.attached).toBe(true);
    expect(findValidation(dir, record.treeHash)?.commitSha).toBe(sh(dir, 'git rev-parse HEAD'));
  });
});
