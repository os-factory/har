import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync, spawnSync } from 'child_process';
import {
  CLAUDE_GUARD_RELATIVE_PATH,
  claudeGuardInstalled,
  installClaudeGuard,
  uninstallClaudeGuard,
} from '../src/core/claude-hooks';

function sh(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-claude-guard-'));
  sh(dir, 'git init -q -b main');
  sh(dir, 'git config user.email har@test.local');
  sh(dir, 'git config user.name har');
  fs.mkdirSync(path.join(dir, '.har'));
  fs.writeFileSync(path.join(dir, '.har', 'stages.json'), JSON.stringify({ version: '1', stages: [] }));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  sh(dir, 'git add -A');
  sh(dir, 'git commit -q -m init');
  return dir;
}

function runGuard(repo: string, targetFile: string, env: NodeJS.ProcessEnv = {}): number {
  const script = path.join(repo, CLAUDE_GUARD_RELATIVE_PATH);
  const input = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: targetFile },
  });
  const result = spawnSync('sh', [script], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return result.status ?? -1;
}

describe('claude worktree guard', () => {
  let repo: string;

  beforeEach(() => {
    repo = initRepo();
    installClaudeGuard(repo);
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('installs guard script and PreToolUse entry in .claude/settings.json', () => {
    expect(fs.existsSync(path.join(repo, CLAUDE_GUARD_RELATIVE_PATH))).toBe(true);
    const settings = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8'));
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].matcher).toBe('Edit|Write|MultiEdit|NotebookEdit');
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('claude-worktree-guard.sh');
    expect(claudeGuardInstalled(repo)).toBe(true);
  });

  it('is idempotent and preserves existing settings entries', () => {
    const settingsPath = path.join(repo, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] });
    settings.env = { FOO: 'bar' };
    fs.writeFileSync(settingsPath, JSON.stringify(settings));

    installClaudeGuard(repo);
    const updated = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(updated.env).toEqual({ FOO: 'bar' });
    expect(updated.hooks.PreToolUse).toHaveLength(2);
    expect(
      updated.hooks.PreToolUse.filter((entry: { hooks: { command: string }[] }) =>
        entry.hooks.some((hook) => hook.command.includes('claude-worktree-guard.sh')),
      ),
    ).toHaveLength(1);
  });

  it('blocks edits in the main checkout of a har repo (exit 2)', () => {
    expect(runGuard(repo, path.join(repo, 'a.txt'))).toBe(2);
  });

  it('allows edits inside a linked session worktree', () => {
    const worktree = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'har-guard-wt-')), 'wt');
    sh(repo, `git worktree add -q "${worktree}" -b har-agent-1`);
    expect(runGuard(repo, path.join(worktree, 'a.txt'))).toBe(0);
    fs.rmSync(path.dirname(worktree), { recursive: true, force: true });
  });

  it('allows edits outside har-managed repos and fails open on malformed input', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'har-guard-outside-'));
    sh(outside, 'git init -q -b main');
    expect(runGuard(repo, path.join(outside, 'x.txt'))).toBe(0);

    const script = path.join(repo, CLAUDE_GUARD_RELATIVE_PATH);
    const malformed = spawnSync('sh', [script], { input: 'not json', encoding: 'utf8' });
    expect(malformed.status).toBe(0);

    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('respects the HAR_SKIP_WT_GUARD bypass', () => {
    expect(runGuard(repo, path.join(repo, 'a.txt'), { HAR_SKIP_WT_GUARD: '1' })).toBe(0);
  });

  it('uninstall removes the script and the settings entry, keeping other hooks', () => {
    const settingsPath = path.join(repo, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] });
    fs.writeFileSync(settingsPath, JSON.stringify(settings));

    const result = uninstallClaudeGuard(repo);
    expect(result.removed).toBe(true);
    expect(fs.existsSync(path.join(repo, CLAUDE_GUARD_RELATIVE_PATH))).toBe(false);
    expect(claudeGuardInstalled(repo)).toBe(false);

    const remaining = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(remaining.hooks.PreToolUse).toHaveLength(1);
    expect(remaining.hooks.PreToolUse[0].matcher).toBe('Bash');
  });
});
