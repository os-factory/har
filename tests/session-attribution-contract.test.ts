import {
  SessionSlotBindingSchema,
  UsageObservationSchema,
  launchingAgentSession,
} from '../packages/schemas/src/session-attribution';

describe('launchingAgentSession', () => {
  it('reads the session id each agent gives the commands it runs', () => {
    expect(launchingAgentSession({ CLAUDE_CODE_SESSION_ID: 'c1' })).toEqual({
      agentTool: 'claude_code',
      sessionId: 'c1',
    });
    expect(launchingAgentSession({ CODEX_THREAD_ID: 'x1' })).toEqual({
      agentTool: 'codex',
      sessionId: 'x1',
    });
    // Cursor shell-quotes the value.
    expect(launchingAgentSession({ CURSOR_CONVERSATION_ID: "'k1'" })).toEqual({
      agentTool: 'cursor',
      sessionId: 'k1',
    });
  });

  it('returns null outside an agent and ignores blank values', () => {
    expect(launchingAgentSession({})).toBeNull();
    expect(launchingAgentSession({ CLAUDE_CODE_SESSION_ID: '  ' })).toBeNull();
  });
});

describe('contract schemas', () => {
  it('accepts a subagent binding and a request observation', () => {
    expect(
      SessionSlotBindingSchema.parse({
        agentTool: 'claude_code',
        sessionId: 's',
        subagentId: 'a1',
        kind: 'observed',
        slotId: 2,
        at: '2026-11-12T10:00:00.000Z',
      }).subagentId,
    ).toBe('a1');
    expect(
      UsageObservationSchema.parse({
        agentTool: 'codex',
        sessionId: 't',
        observationKey: 'turn-1',
        observedAt: '2026-11-12T10:00:00.000Z',
        granularity: 'turn',
        source: 'harvest',
        tokensInput: 5,
      }),
    ).toMatchObject({ tokensOutput: 0, tokensInput: 5 });
  });

  it('rejects a slot below the minimum', () => {
    expect(() =>
      SessionSlotBindingSchema.parse({
        agentTool: 'cursor',
        sessionId: 's',
        kind: 'launch',
        slotId: 0,
        at: '2026-11-12T10:00:00.000Z',
      }),
    ).toThrow();
  });
});
