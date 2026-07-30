import { AgentSessionUsageSchema, SyncUsageInputSchema } from '../src/harness/schema';

const baseRow = {
  sessionKey: 'branch:1',
  agentId: 1,
  agentTool: 'claude_code',
  firstSeenAt: '2026-07-29T00:00:00.000Z',
  lastSeenAt: '2026-07-29T00:00:00.000Z',
};

describe('AgentSessionUsageSchema userEmail', () => {
  it('retains a member-matching userEmail (does not strip it)', () => {
    const parsed = AgentSessionUsageSchema.parse({
      ...baseRow,
      userEmail: 'diogo.ribeiro@kerno.io',
    });
    expect(parsed.userEmail).toBe('diogo.ribeiro@kerno.io');
  });

  it('survives the SyncUsageInput envelope used by the /usage push path', () => {
    const body = SyncUsageInputSchema.parse({
      usage: [{ ...baseRow, userEmail: 'diogo.ribeiro@kerno.io' }],
    });
    expect(body.usage[0].userEmail).toBe('diogo.ribeiro@kerno.io');
  });

  it('stays optional — a row without an email parses fine', () => {
    expect(AgentSessionUsageSchema.parse(baseRow).userEmail).toBeUndefined();
  });
});
