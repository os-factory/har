import {
  attributedSessionKey,
  selectAttributedUsage,
  servesAttributedUsage,
  type MissionControlUnassignedRow,
  type MissionControlUsageRow,
  type MissionControlUsageView,
} from '../src/core/portal-attributed-usage';

const OLD = '2026-03-01T10:00:00.000Z';
const NEW = '2026-03-01T12:00:00.000Z';
const SINCE = '2026-03-01T11:00:00.000Z';

function slotRow(overrides: Partial<MissionControlUsageRow> = {}): MissionControlUsageRow {
  return {
    sessionKey: 'sess-1',
    agentId: 2,
    agentTool: 'claude_code',
    workDir: '/wt/agent-2',
    branch: 'agent-2-x',
    suffix: 'x',
    occupancyKey: 'attempt::A1',
    workUnitId: 'FE-1',
    attemptId: 'A1',
    tokensInput: 1_000_000,
    tokensOutput: 1_000_000,
    tokensCacheRead: 0,
    tokensCacheCreation: 0,
    tokensTotal: 2_000_000,
    // Far below any price estimate for those tokens: a repricer would raise it.
    costUsd: 0.01,
    modelBreakdown: { 'claude-opus-4-1': { tokensTotal: 2_000_000, costUsd: 0.01 } },
    sources: ['otel'],
    harvestVersion: 3,
    firstSeenAt: OLD,
    lastSeenAt: OLD,
    updatedAt: OLD,
    origin: 'observations',
    changedAt: OLD,
    ...overrides,
  };
}

function unassigned(overrides: Partial<MissionControlUnassignedRow> = {}): MissionControlUnassignedRow {
  return {
    agentTool: 'claude_code',
    sessionId: 'sess-1',
    workDir: null,
    branch: null,
    tokensInput: 10,
    tokensOutput: 5,
    tokensCacheRead: 0,
    tokensCacheCreation: 0,
    tokensTotal: 15,
    costUsd: 0.5,
    modelBreakdown: {},
    sources: ['otel'],
    harvestVersion: 3,
    itemized: true,
    firstSeenAt: OLD,
    lastSeenAt: OLD,
    changedAt: OLD,
    ...overrides,
  };
}

function rows(view: MissionControlUsageView, since: string | null = null) {
  return selectAttributedUsage(view, since, 'dev@example.com').sessions.flat();
}

describe('servesAttributedUsage', () => {
  it('is true only for a usage view with the unassigned list', () => {
    expect(servesAttributedUsage({ usage: [], unassigned: [] })).toBe(true);
    expect(servesAttributedUsage({ usage: [] })).toBe(false);
    expect(servesAttributedUsage(null)).toBe(false);
  });
});

describe('selectAttributedUsage — row mapping', () => {
  it('state 1: the main checkout is agent 0 with no worktree, keyed <session>@main', () => {
    expect(rows({ usage: [], unassigned: [unassigned()] })).toEqual([
      {
        sessionKey: 'sess-1@main',
        providerSessionId: 'sess-1',
        agentId: 0,
        agentTool: 'claude_code',
        userEmail: 'dev@example.com',
        workDir: null,
        branch: null,
        workUnitId: null,
        attemptId: null,
        tokensInput: 10,
        tokensOutput: 5,
        tokensCacheRead: 0,
        tokensCacheCreation: 0,
        tokensTotal: 15,
        costUsd: 0.5,
        sources: ['otel'],
        harvestVersion: 3,
        firstSeenAt: OLD,
        lastSeenAt: OLD,
      },
    ]);
  });

  it('state 2: a non-slot worktree is agent 0 with its path and branch, keyed by branch, else path', () => {
    const [byBranch, byPath] = rows({
      usage: [],
      unassigned: [
        unassigned({ workDir: '/repo/.claude/worktrees/fix', branch: 'fix' }),
        unassigned({ workDir: '/wt/detached', branch: null }),
      ],
    });
    expect(byBranch).toMatchObject({
      sessionKey: 'sess-1@wt:fix',
      providerSessionId: 'sess-1',
      agentId: 0,
      workDir: '/repo/.claude/worktrees/fix',
      branch: 'fix',
      workUnitId: null,
      attemptId: null,
    });
    expect(byPath).toMatchObject({ sessionKey: 'sess-1@wt:/wt/detached', workDir: '/wt/detached', branch: null });
  });

  it('state 3: a slot occupancy keeps Mission Control\'s slot, work unit, attempt, models and cost', () => {
    expect(rows({ usage: [slotRow()], unassigned: [] })).toEqual([
      expect.objectContaining({
        sessionKey: 'sess-1@2:attempt::A1',
        providerSessionId: 'sess-1',
        agentId: 2,
        workDir: '/wt/agent-2',
        branch: 'agent-2-x',
        suffix: 'x',
        occupancyKey: 'attempt::A1',
        workUnitId: 'FE-1',
        attemptId: 'A1',
        costUsd: 0.01,
        modelBreakdown: { 'claude-opus-4-1': { tokensTotal: 2_000_000, costUsd: 0.01 } },
        models: [{ model: 'claude-opus-4-1', tokensTotal: 2_000_000, costUsd: 0.01 }],
        sources: ['otel'],
        harvestVersion: 3,
        userEmail: 'dev@example.com',
      }),
    ]);
    expect(attributedSessionKey('s', { kind: 'slot', slotId: 3, occupancyKey: null })).toBe('s@3:');
  });

  it('a reported-only session is a main-checkout row keyed <session>@reported', () => {
    expect(rows({ usage: [], unassigned: [unassigned({ itemized: false, costUsd: 3, tokensTotal: 9 })] })).toEqual([
      expect.objectContaining({
        sessionKey: 'sess-1@reported',
        providerSessionId: 'sess-1',
        agentId: 0,
        workDir: null,
        branch: null,
        costUsd: 3,
        tokensTotal: 9,
      }),
    ]);
  });

  it('sends a legacy session total as stored, with no provider session', () => {
    const [row] = rows({
      usage: [slotRow({ sessionKey: 'feat/x', agentId: 1, origin: 'legacy', occupancyKey: null, changedAt: OLD })],
      unassigned: [],
    });
    expect(row).toMatchObject({ sessionKey: 'feat/x', agentId: 1, costUsd: 0.01 });
    expect(row).not.toHaveProperty('providerSessionId');
  });
});

describe('selectAttributedUsage — completeness', () => {
  const view: MissionControlUsageView = {
    usage: [
      // sess-1's slot row has not changed itself…
      slotRow({ changedAt: OLD }),
      slotRow({ sessionKey: 'sess-2', changedAt: OLD }),
    ],
    unassigned: [
      // …but its session did (a late launch moved usage, say): the session goes whole.
      unassigned({ changedAt: NEW }),
      unassigned({ sessionId: 'sess-2', changedAt: OLD }),
    ],
  };

  it('sends every row of each session that changed since the watermark, and nothing of the others', () => {
    const selection = selectAttributedUsage(view, SINCE);
    expect(selection.sessions.map((session) => session.map((row) => row.sessionKey))).toEqual([
      ['sess-1@2:attempt::A1', 'sess-1@main'],
    ]);
    expect(selection.maxSyncedAt).toBe(NEW);
  });

  it('sends everything on a first or full sync', () => {
    const selection = selectAttributedUsage(view, null);
    expect(selection.sessions.flat()).toHaveLength(4);
    expect(selection.sessions).toHaveLength(2);
  });

  it('keeps the same session of another agent tool apart', () => {
    const selection = selectAttributedUsage(
      { usage: [], unassigned: [unassigned({ changedAt: NEW }), unassigned({ agentTool: 'codex', changedAt: OLD })] },
      SINCE,
    );
    expect(selection.sessions.flat().map((row) => row.agentTool)).toEqual(['claude_code']);
  });
});
