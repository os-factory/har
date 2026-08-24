import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { harvestClaudeUsage, encodeClaudeProjectDir } from '../src/core/usage-harvest/claude';
import { USAGE_HARVEST_VERSION } from '../src/harness/schema';
import { harvestCodexUsage } from '../src/core/usage-harvest/codex';
import {
  omitHarvestEventsWhenOtelPresent,
  omitHarvestWhenOtelPresent,
} from '../src/core/usage-harvest';
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
    expect(usage!.harvestVersion).toBe(USAGE_HARVEST_VERSION);
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

  it('bills a repeated assistant message id once', () => {
    const workDir = '/home/user/worktrees/main-abcd-har-agent-3-dd44';
    const project = path.join(tmp, encodeClaudeProjectDir(workDir));
    fs.mkdirSync(project, { recursive: true });
    const message = (id: string) => ({
      type: 'assistant',
      message: {
        id,
        role: 'assistant',
        model: 'claude-opus-5',
        usage: {
          input_tokens: 10,
          output_tokens: 100,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 50,
        },
      },
    });
    fs.writeFileSync(
      path.join(project, 'session.jsonl'),
      [
        JSON.stringify({ type: 'user', cwd: workDir }),
        JSON.stringify(message('msg_a')),
        JSON.stringify(message('msg_a')),
        JSON.stringify(message('msg_b')),
        JSON.stringify(message('msg_b')),
      ].join('\n') + '\n',
    );

    const usage = harvestClaudeUsage({
      agentId: 3,
      workDir,
      branch: 'main-abcd-har-agent-3-dd44',
      suffix: 'dd44',
      repoPath: '/home/user/repo',
    });

    expect(usage).not.toBeNull();
    expect(usage!.tokensInput).toBe(20);
    expect(usage!.tokensOutput).toBe(200);
    expect(usage!.tokensCacheRead).toBe(2000);
    expect(usage!.tokensCacheCreation).toBe(100);
    expect(usage!.tokensTotal).toBe(2320);
    expect(usage!.modelBreakdown).toEqual({
      'claude-opus-5': {
        tokensInput: 20,
        tokensOutput: 200,
        tokensCacheRead: 2000,
        tokensCacheCreation: 100,
        tokensTotal: 2320,
      },
    });
  });

  it('counts every transcript in the slot, not just the newest', () => {
    const workDir = '/home/user/worktrees/main-abcd-har-agent-4-ee55';
    const project = path.join(tmp, encodeClaudeProjectDir(workDir));
    fs.mkdirSync(project, { recursive: true });
    const message = (id: string, output: number) =>
      JSON.stringify({
        type: 'assistant',
        message: {
          id,
          role: 'assistant',
          model: 'claude-opus-5',
          usage: { input_tokens: 1, output_tokens: output },
        },
      });
    fs.writeFileSync(path.join(project, 'older.jsonl'), message('msg_old', 10) + '\n');
    fs.writeFileSync(path.join(project, 'newer.jsonl'), message('msg_new', 70) + '\n');

    const usage = harvestClaudeUsage({
      agentId: 4,
      workDir,
      branch: 'main-abcd-har-agent-4-ee55',
      suffix: 'ee55',
      repoPath: '/home/user/repo',
    });

    expect(usage).not.toBeNull();
    expect(usage!.tokensOutput).toBe(80);
    expect(usage!.tokensInput).toBe(2);
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

  it('harvests only the slot whose worktree matches among parallel slots', () => {
    const homeDir = '/home/alice';
    const slot1Dir = '/home/alice/worktrees/main-abcd-har-agent-1-aa11';
    const slot2Dir = '/home/alice/worktrees/main-abcd-har-agent-2-bb22';
    const slot3Dir = '/home/alice/worktrees/main-abcd-har-agent-3-cc33';
    const repoPath = '/home/alice/project';

    const homeProject = path.join(tmp, encodeClaudeProjectDir(homeDir));
    fs.mkdirSync(homeProject, { recursive: true });
    fs.writeFileSync(
      path.join(homeProject, 'parent-session.jsonl'),
      [
        JSON.stringify({ type: 'user', cwd: homeDir }),
        JSON.stringify({
          type: 'result',
          usage: { input_tokens: 99, output_tokens: 99 },
          total_cost_usd: 9.99,
        }),
      ].join('\n') + '\n',
    );

    const slot2Project = path.join(tmp, encodeClaudeProjectDir(slot2Dir));
    fs.mkdirSync(slot2Project, { recursive: true });
    fs.writeFileSync(
      path.join(slot2Project, 'slot2-session.jsonl'),
      [
        JSON.stringify({ type: 'user', cwd: slot2Dir }),
        JSON.stringify({
          type: 'result',
          usage: { input_tokens: 20, output_tokens: 10 },
          total_cost_usd: 0.2,
        }),
      ].join('\n') + '\n',
    );

    const slots = [
      { agentId: 1, workDir: slot1Dir, branch: 'main-abcd-har-agent-1-aa11', suffix: 'aa11' },
      { agentId: 2, workDir: slot2Dir, branch: 'main-abcd-har-agent-2-bb22', suffix: 'bb22' },
      { agentId: 3, workDir: slot3Dir, branch: 'main-abcd-har-agent-3-cc33', suffix: 'cc33' },
    ];

    const harvested = slots.map((slot) =>
      harvestClaudeUsage({ ...slot, repoPath }),
    );

    expect(harvested[0]).toBeNull();
    expect(harvested[1]?.tokensOutput).toBe(10);
    expect(harvested[1]?.costUsd).toBe(0.2);
    expect(harvested[2]).toBeNull();
  });

  it('attributes a main-checkout transcript when the worktree has none and fallback is enabled', () => {
    const repoPath = '/home/user/Documents/Kerno/fecore';
    const worktree = '/home/user/worktrees/main-2b19-har-agent-1-5wrz';
    const checkoutProject = path.join(tmp, encodeClaudeProjectDir(repoPath));
    fs.mkdirSync(checkoutProject, { recursive: true });
    fs.writeFileSync(
      path.join(checkoutProject, 'session.jsonl'),
      [
        JSON.stringify({ type: 'user', cwd: repoPath }),
        JSON.stringify({
          type: 'result',
          usage: { input_tokens: 30, output_tokens: 15 },
          total_cost_usd: 0.3,
        }),
      ].join('\n') + '\n',
    );

    const slot = {
      agentId: 1,
      workDir: worktree,
      worktreePath: worktree,
      branch: 'main-2b19-har-agent-1-5wrz',
      suffix: '5wrz',
      repoPath,
    };

    expect(harvestClaudeUsage(slot)).toBeNull();

    const withFallback = harvestClaudeUsage({ ...slot, includeRepoPathFallback: true });
    expect(withFallback).not.toBeNull();
    expect(withFallback!.tokensOutput).toBe(15);
    expect(withFallback!.costUsd).toBe(0.3);
  });

  it('prefers the worktree transcript over the main checkout when both exist', () => {
    const repoPath = '/home/user/Documents/Kerno/fecore';
    const worktree = '/home/user/worktrees/main-2b19-har-agent-1-5wrz';

    const checkoutProject = path.join(tmp, encodeClaudeProjectDir(repoPath));
    fs.mkdirSync(checkoutProject, { recursive: true });
    fs.writeFileSync(
      path.join(checkoutProject, 'checkout.jsonl'),
      [
        JSON.stringify({ type: 'user', cwd: repoPath }),
        JSON.stringify({ type: 'result', usage: { input_tokens: 99, output_tokens: 99 } }),
      ].join('\n') + '\n',
    );

    const worktreeProject = path.join(tmp, encodeClaudeProjectDir(worktree));
    fs.mkdirSync(worktreeProject, { recursive: true });
    fs.writeFileSync(
      path.join(worktreeProject, 'worktree.jsonl'),
      [
        JSON.stringify({ type: 'user', cwd: worktree }),
        JSON.stringify({ type: 'result', usage: { input_tokens: 5, output_tokens: 7 } }),
      ].join('\n') + '\n',
    );

    fs.utimesSync(path.join(worktreeProject, 'worktree.jsonl'), 1000, 1000);
    fs.utimesSync(path.join(checkoutProject, 'checkout.jsonl'), 2000, 2000);

    const usage = harvestClaudeUsage({
      agentId: 1,
      workDir: worktree,
      worktreePath: worktree,
      branch: 'main-2b19-har-agent-1-5wrz',
      suffix: '5wrz',
      repoPath,
      includeRepoPathFallback: true,
    });

    expect(usage!.tokensOutput).toBe(7);
  });

  it('sums the slot own transcripts without adding the main-checkout fallback', () => {
    const repoPath = '/home/user/Documents/Kerno/fecore';
    const worktree = '/home/user/worktrees/main-2b19-har-agent-1-5wrz';
    const message = (id: string, output: number) =>
      JSON.stringify({
        type: 'assistant',
        message: {
          id,
          role: 'assistant',
          model: 'claude-opus-5',
          usage: { output_tokens: output },
        },
      });

    const checkoutProject = path.join(tmp, encodeClaudeProjectDir(repoPath));
    fs.mkdirSync(checkoutProject, { recursive: true });
    fs.writeFileSync(path.join(checkoutProject, 'checkout.jsonl'), message('msg_c', 500) + '\n');

    const worktreeProject = path.join(tmp, encodeClaudeProjectDir(worktree));
    fs.mkdirSync(worktreeProject, { recursive: true });
    fs.writeFileSync(path.join(worktreeProject, 'first.jsonl'), message('msg_1', 3) + '\n');
    fs.writeFileSync(path.join(worktreeProject, 'second.jsonl'), message('msg_2', 4) + '\n');

    const usage = harvestClaudeUsage({
      agentId: 1,
      workDir: worktree,
      worktreePath: worktree,
      branch: 'main-2b19-har-agent-1-5wrz',
      suffix: '5wrz',
      repoPath,
      includeRepoPathFallback: true,
    });

    expect(usage!.tokensOutput).toBe(7);
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

  it('does not harvest a parent cwd session into a child worktree slot', () => {
    const homeDir = '/home/alice';
    const workDir = '/home/alice/worktrees/main-abcd-har-agent-2-bb22';
    const sessionDir = path.join(tmp, '2026');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'parent.jsonl'),
      [
        JSON.stringify({ cwd: homeDir }),
        JSON.stringify({
          usage: { input_tokens: 50, output_tokens: 25 },
        }),
      ].join('\n') + '\n',
    );

    expect(
      harvestCodexUsage({
        agentId: 2,
        workDir,
        branch: 'main-abcd-har-agent-2-bb22',
        suffix: 'bb22',
        repoPath: '/home/alice/project',
      }),
    ).toBeNull();
  });
});

describe('omit harvest when otel present', () => {
  it('drops harvested usage when otel already attributed the session/tool', () => {
    const harvested = [
      {
        sessionKey: 'main-abcd-har-agent-2-bb22',
        agentId: 2,
        agentTool: 'claude_code' as const,
        tokensInput: 10,
        tokensOutput: 5,
        tokensCacheRead: 0,
        tokensCacheCreation: 0,
        tokensTotal: 15,
        sources: ['harvest' as const],
        harvestVersion: USAGE_HARVEST_VERSION,
        firstSeenAt: '2026-01-01T00:00:00.000Z',
        lastSeenAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    const existing = [
      {
        ...harvested[0],
        sources: ['otel' as const],
      },
    ];

    expect(omitHarvestWhenOtelPresent(harvested, existing)).toEqual([]);
  });

  it('drops harvested events when otel events already exist for the session/tool', () => {
    const harvested = [
      {
        sessionKey: 'main-abcd-har-agent-2-bb22',
        agentId: 2,
        agentTool: 'claude_code' as const,
        eventName: 'claude_code.user_prompt',
        sequence: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
        source: 'harvest' as const,
      },
    ];
    const existing = [
      {
        ...harvested[0],
        source: 'otel' as const,
      },
    ];

    expect(omitHarvestEventsWhenOtelPresent(harvested, existing)).toEqual([]);
  });
});
