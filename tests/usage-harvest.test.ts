import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { harvestClaudeUsage, encodeClaudeProjectDir } from '../src/core/usage-harvest/claude';
import { harvestCodexUsage } from '../src/core/usage-harvest/codex';
import { isWorkspaceUnderPath } from '../src/core/workspace-path-match';

describe('usage harvest claude', () => {
  let tmp: string;
  const original = process.env.HAR_CLAUDE_PROJECTS_DIR;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-claude-'));
    process.env.HAR_CLAUDE_PROJECTS_DIR = tmp;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.HAR_CLAUDE_PROJECTS_DIR;
    else process.env.HAR_CLAUDE_PROJECTS_DIR = original;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('parses result usage from matching cwd transcript', () => {
    const workDir = '/home/user/worktrees/main-abcd-har-agent-1-xy12';
    const project = path.join(tmp, encodeClaudeProjectDir(workDir));
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(
      path.join(project, 'session.jsonl'),
      [
        JSON.stringify({ type: 'user', cwd: workDir }),
        JSON.stringify({
          type: 'result',
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 5,
          },
          total_cost_usd: 0.42,
        }),
      ].join('\n') + '\n',
    );

    const usage = harvestClaudeUsage({
      agentId: 1,
      workDir,
      branch: 'main-abcd-har-agent-1-xy12',
      suffix: 'xy12',
      repoPath: '/home/user/repo',
    });

    expect(usage).not.toBeNull();
    expect(usage!.agentTool).toBe('claude_code');
    expect(usage!.tokensOutput).toBe(50);
    expect(usage!.costUsd).toBe(0.42);
    expect(usage!.sources).toEqual(['harvest']);
  });

  it('rolls up a per-model breakdown from assistant messages', () => {
    const workDir = '/home/user/worktrees/main-abcd-har-agent-2-zz99';
    const project = path.join(tmp, encodeClaudeProjectDir(workDir));
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(
      path.join(project, 'session.jsonl'),
      [
        JSON.stringify({ type: 'user', cwd: workDir }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            model: 'claude-opus-4-8',
            usage: { input_tokens: 30, output_tokens: 10, cache_read_input_tokens: 4 },
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', model: '<synthetic>', usage: { output_tokens: 999 } },
        }),
        JSON.stringify({
          type: 'result',
          usage: { input_tokens: 30, output_tokens: 10, cache_read_input_tokens: 4 },
        }),
      ].join('\n') + '\n',
    );

    const usage = harvestClaudeUsage({
      agentId: 2,
      workDir,
      branch: 'main-abcd-har-agent-2-zz99',
      suffix: 'zz99',
      repoPath: '/home/user/repo',
    });

    expect(usage).not.toBeNull();
    expect(usage!.modelBreakdown).toEqual({
      'claude-opus-4-8': {
        tokensInput: 30,
        tokensOutput: 10,
        tokensCacheRead: 4,
        tokensCacheCreation: 0,
        tokensTotal: 44,
      },
    });
  });

  it('does not harvest a parent cwd session into a child worktree slot', () => {
    const homeDir = '/home/antoine';
    const workDir = '/home/antoine/worktrees/main-abcd-har-agent-2-xy12';
    const homeProject = path.join(tmp, encodeClaudeProjectDir(homeDir));
    fs.mkdirSync(homeProject, { recursive: true });
    fs.writeFileSync(
      path.join(homeProject, 'session.jsonl'),
      [
        JSON.stringify({ type: 'user', cwd: homeDir, message: { role: 'user', content: 'hi' } }),
        JSON.stringify({
          type: 'result',
          usage: { input_tokens: 10, output_tokens: 5 },
          total_cost_usd: 0.01,
        }),
      ].join('\n') + '\n',
    );

    expect(
      harvestClaudeUsage({
        agentId: 2,
        workDir,
        branch: 'main-abcd-har-agent-2-xy12',
        suffix: 'xy12',
        repoPath: '/home/antoine/Documents/osfactory/har-project',
      }),
    ).toBeNull();
  });
});

describe('workspace path match', () => {
  it('matches equal paths and child workspaces only', () => {
    const worktree = '/home/antoine/worktrees/main-abcd-har-agent-2-xy12';
    expect(isWorkspaceUnderPath(worktree, worktree)).toBe(true);
    expect(isWorkspaceUnderPath(`${worktree}/src`, worktree)).toBe(true);
    expect(isWorkspaceUnderPath('/home/antoine', worktree)).toBe(false);
  });
});

describe('usage harvest codex', () => {
  let tmp: string;
  const original = process.env.HAR_CODEX_SESSIONS_DIR;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-codex-'));
    process.env.HAR_CODEX_SESSIONS_DIR = tmp;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.HAR_CODEX_SESSIONS_DIR;
    else process.env.HAR_CODEX_SESSIONS_DIR = original;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('sums token usage for matching cwd', () => {
    const workDir = '/tmp/wt-codex';
    const sessionDir = path.join(tmp, '2026');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 's.jsonl'),
      [
        JSON.stringify({ cwd: workDir }),
        JSON.stringify({
          usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 2 },
        }),
      ].join('\n') + '\n',
    );

    const usage = harvestCodexUsage({
      agentId: 2,
      workDir,
      branch: 'main-xxxx-har-agent-2-abcd',
      suffix: 'abcd',
      repoPath: '/repo',
    });

    expect(usage).not.toBeNull();
    expect(usage!.agentTool).toBe('codex');
    expect(usage!.tokensInput).toBe(10);
    expect(usage!.tokensOutput).toBe(5);
    expect(usage!.costUsd).toBeNull();
  });
});
