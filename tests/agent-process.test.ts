import { agentToolOfProcess, innermostAgentTool, type ProcessInfo } from '../src/core/agent-process';
import { currentAgentSession } from '../src/core/session-bindings';

function tree(chain: Array<[number, number, string, string[]?]>) {
  const map = new Map<number, ProcessInfo>(
    chain.map(([pid, ppid, command, args = []]) => [pid, { ppid, command, args }]),
  );
  return (pid: number) => map.get(pid) ?? null;
}

describe('agentToolOfProcess', () => {
  it('recognizes each agent as it appears in the process table', () => {
    expect(agentToolOfProcess({ ppid: 1, command: 'claude', args: [] })).toBe('claude_code');
    expect(
      agentToolOfProcess({ ppid: 1, command: 'node', args: ['/x/node_modules/@anthropic-ai/claude-code/cli.js'] }),
    ).toBe('claude_code');
    expect(
      agentToolOfProcess({ ppid: 1, command: '/home/u/.cursor/extensions/openai.chatgpt/bin/linux-x86_64/codex', args: ['app-server'] }),
    ).toBe('codex');
    expect(
      agentToolOfProcess({ ppid: 1, command: '/usr/lib/electron42/electron', args: ['/usr/share/cursor/resources/app/cursor.mjs'] }),
    ).toBe('cursor');
    expect(agentToolOfProcess({ ppid: 1, command: 'cursor-agent', args: [] })).toBe('cursor');
    expect(agentToolOfProcess({ ppid: 1, command: '/usr/bin/bash', args: ['-lc', 'node har env launch 3'] })).toBeNull();
  });
});

describe('innermostAgentTool', () => {
  // har (100) ← bash (90) ← codex (80) ← bash (70) ← claude (60) ← fish (50) ← cursor (40)
  const read = tree([
    [90, 80, '/usr/bin/bash', ['-lc', 'har env launch 3']],
    [80, 70, 'codex', ['exec']],
    [70, 60, '/usr/bin/bash', ['-c', 'codex exec']],
    [60, 50, 'claude', []],
    [50, 40, '/usr/bin/fish', []],
    [40, 1, '/usr/lib/electron42/electron', ['/usr/share/cursor/resources/app/cursor.mjs']],
  ]);

  it('picks the nearest agent ancestor', () => {
    expect(innermostAgentTool({ has: new Set(['claude_code', 'codex']), startPid: 90, read })).toBe('codex');
  });

  it('skips an agent whose session variable is not set', () => {
    // A plain Cursor terminal (not an agent shell) sets no CURSOR_CONVERSATION_ID.
    expect(innermostAgentTool({ has: new Set(['claude_code']), startPid: 50, read })).toBeNull();
    expect(innermostAgentTool({ has: new Set(['claude_code']), startPid: 70, read })).toBe('claude_code');
  });

  it('gives up rather than guessing when the tree cannot be read', () => {
    expect(innermostAgentTool({ has: new Set(['codex']), startPid: 999, read })).toBeNull();
  });
});

describe('currentAgentSession', () => {
  const env = { CLAUDE_CODE_SESSION_ID: 'claude-outer', CODEX_THREAD_ID: 'codex-inner' };

  it('uses the innermost agent when agents are nested', () => {
    expect(currentAgentSession(env, () => 'codex')).toEqual({ agentTool: 'codex', sessionId: 'codex-inner' });
  });

  it('records nothing when nested agents cannot be told apart', () => {
    expect(currentAgentSession(env, () => null)).toBeNull();
  });

  it('needs no process lookup for a single agent', () => {
    const resolve = jest.fn(() => null);
    expect(currentAgentSession({ CODEX_THREAD_ID: 't1' }, resolve)).toEqual({ agentTool: 'codex', sessionId: 't1' });
    expect(resolve).not.toHaveBeenCalled();
  });
});
