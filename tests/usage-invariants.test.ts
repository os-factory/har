import {
  checkUsageInvariants,
  ledgerRowsFromPortalUsage,
  ledgerRowsFromUsageView,
  type LedgerObservation,
  type LedgerRow,
  type UsageInvariantId,
  type UsageLedger,
} from '../packages/schemas/src/usage-invariants';
import {
  MAIN_CHECKOUT_AGENT_ID,
  projectUsage,
  worktreeOccupancyKey,
  type TimelineBinding,
} from '../packages/schemas/src/usage-attribution';
import { selectAttributedUsage } from '../src/core/portal-attributed-usage';

/**
 * Usage invariants (FE-2058): the current pipeline keeps them, and each one
 * fails on the shape a root cause of the usage audit left in a real Mission
 * Control (rebuilt here with its real counters and costs).
 */

const T0 = Date.parse('2026-11-12T10:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const A = { id: 'repo-a', path: '/work/a' };
const B = { id: 'repo-b', path: '/work/b' };
const C = { id: 'repo-c', path: '/work/a/nested' };
const D = { id: 'repo-d', path: '/work/d' };
const SID = '11111111-2222-4333-8444-555555555555';

function request(minutes: number, extra: Partial<LedgerObservation> = {}): LedgerObservation {
  return {
    repositoryId: A.id,
    agentTool: 'claude_code',
    sessionId: SID,
    observationKey: `req-${minutes}`,
    observedAt: at(minutes),
    granularity: 'request',
    source: 'otel',
    producer: 'claude.api_request',
    model: 'claude-opus-5-5',
    tokensInput: 100,
    tokensOutput: 50,
    tokensCacheRead: 1_000,
    tokensCacheCreation: 10,
    costUsd: 0.01,
    ...extra,
  };
}

/** A stored legacy session total, as the audit found them. */
function legacy(repositoryId: string, key: string, extra: Partial<LedgerRow> = {}): LedgerRow {
  return {
    repositoryId,
    agentTool: 'claude_code',
    kind: 'legacy',
    key,
    slotId: 1,
    workDir: null,
    tokensInput: 124,
    tokensOutput: 24_433,
    tokensCacheRead: 3_718_927,
    tokensCacheCreation: 118_703,
    tokensTotal: 3_862_187,
    costUsd: 3.21,
    firstSeenAt: at(0),
    lastSeenAt: at(60),
    ...extra,
  };
}

function bind(
  minutes: number,
  slotId: number,
  extra: Partial<TimelineBinding> = {},
): TimelineBinding {
  return {
    agentTool: 'claude_code',
    sessionId: SID,
    kind: 'launch',
    slotId,
    occupancyKey: `attempt::occ-${slotId}`,
    branch: `agent-${slotId}-x`,
    at: at(minutes),
    ...extra,
  };
}

/** What the pipeline ships for one repository: Mission Control's projection, selected by `har control sync`. */
function shipped(
  repositoryId: string,
  bindings: TimelineBinding[],
  observations: LedgerObservation[],
): LedgerRow[] {
  const { slots, unassigned } = projectUsage(bindings, observations);
  const iso = (b: { firstSeenAt: Date; lastSeenAt: Date }) => ({
    firstSeenAt: b.firstSeenAt.toISOString(),
    lastSeenAt: b.lastSeenAt.toISOString(),
  });
  const selection = selectAttributedUsage(
    {
      usage: slots.map((b) => ({
        ...b,
        ...iso(b),
        sessionKey: b.sessionId,
        agentId: b.slotId,
        origin: 'observations' as const,
      })),
      unassigned: unassigned.map((b) => ({ ...b, ...iso(b), itemized: true })),
    },
    null,
  );
  return ledgerRowsFromPortalUsage(
    repositoryId,
    selection.sessions.flat() as unknown as Array<Record<string, unknown>>,
  );
}

function check(partial: Partial<UsageLedger>) {
  return checkUsageInvariants({
    repositories: [A, B, C, D],
    observations: [],
    rows: [],
    ...partial,
  });
}

function failing(report: ReturnType<typeof checkUsageInvariants>): UsageInvariantId[] {
  return [...new Set(report.violations.map((v) => v.invariant))].sort();
}

const summary = (report: ReturnType<typeof checkUsageInvariants>, id: UsageInvariantId) =>
  report.summary.find((s) => s.invariant === id)!;

describe('the current pipeline keeps every invariant', () => {
  it('main checkout → worktree → slot', () => {
    const observations = [request(1), request(2), request(3), request(4)];
    const bindings = [
      bind(1.5, MAIN_CHECKOUT_AGENT_ID, {
        kind: 'observed',
        occupancyKey: worktreeOccupancyKey({ workDir: '/work/a-wt' }),
      }),
      bind(3.5, 2),
    ];
    const rows = shipped(A.id, bindings, observations);
    expect(rows).toHaveLength(3);
    expect(check({ observations, rows }).violations).toEqual([]);
  });

  it('one session across repositories with disjoint requests: A main → slot in B → A', () => {
    const inA = [request(1), request(4)];
    const inB = [request(2, { repositoryId: B.id }), request(3, { repositoryId: B.id })];
    const rows = [
      ...shipped(A.id, [], inA),
      ...shipped(B.id, [bind(1.5, 1, { kind: 'workspace' })], inB),
    ];
    expect(check({ observations: [...inA, ...inB], rows }).violations).toEqual([]);
  });

  it('a relaunched slot (new occupancy) keeps one row per occupancy', () => {
    const observations = [request(1), request(2), request(3)];
    const bindings = [
      bind(0, 3, { occupancyKey: 'attempt::first' }),
      bind(1.5, 3, { occupancyKey: 'attempt::second' }),
    ];
    const rows = shipped(A.id, bindings, observations);
    expect(rows).toHaveLength(2);
    expect(check({ observations, rows }).ok).toBe(true);
  });
});

describe('regressions: one per root cause of the usage audit', () => {
  it('I1: a live sync harvested one session into two repositories', () => {
    const inA = [request(1), request(2), request(3)];
    const copies = inA.map((o) => ({ ...o, repositoryId: B.id }));
    const report = check({ observations: [...inA, ...copies] });
    const i1 = report.violations.find((v) => v.invariant === 'I1')!;
    expect(i1).toMatchObject({
      repositoryIds: [A.id, B.id],
      keys: [SID],
      tokens: 3 * 1_160,
      costUsd: 0.03,
    });
    expect(report.blockedUnits).toEqual([
      { repositoryId: A.id, agentTool: 'claude_code', key: SID, invariants: ['I1'] },
      { repositoryId: B.id, agentTool: 'claude_code', key: SID, invariants: ['I1'] },
    ]);
  });

  it('I2: one dogfood worktree total copied into 8 rows across 4 repositories', () => {
    const wt = { workDir: '/worktrees/dogfood-har-agent-4', slotId: 4 };
    const rows = [
      legacy(A.id, 'main-99ec7-har-agent-3-vheb', wt),
      legacy(A.id, 'main-27c3a-har-agent-1-4hdq', wt),
      legacy(B.id, 'docs-saas-har-agent-2-whn9', wt),
      legacy(C.id, 'main-02d9-har-agent-3-2mqo', wt),
      legacy(C.id, 'main-02d9-har-agent-2-c1cp', wt),
      legacy(D.id, 'main-3da6-har-agent-2-wwff', wt),
      legacy(D.id, 'main-296b-har-agent-3-gmeh', wt),
      legacy(D.id, 'main-a15b-har-agent-1-5voz', wt),
    ];
    const report = check({ rows });
    expect(failing(report)).toEqual(['I2']);
    expect(summary(report, 'I2').costUsd).toBeCloseTo(7 * 3.21);
    expect(report.blockedUnits).toHaveLength(8);
  });

  it('I2: createdAt-derived keys stored one stream as 5 rows', () => {
    const keys = [
      '09-24-25-607Z',
      '09-24-55-538Z',
      '11-41-25-887Z',
      '11-50-03-049Z',
      '11-50-16-615Z',
    ];
    const report = check({
      rows: keys.map((k) => legacy(A.id, `agent-1-2026-10-09T${k}`, { costUsd: 3.83 })),
    });
    expect(summary(report, 'I2')).toMatchObject({ violations: 1, costUsd: 4 * 3.83 });
  });

  it('I2 + I4: a slot suffix change re-keyed usage of a slot whose work dir was the main checkout', () => {
    const slot3 = { slotId: 3, workDir: `${A.path}/` };
    const report = check({
      rows: [
        legacy(A.id, 'agent-3-16b855a', { ...slot3, tokensTotal: 1_253_489_353, costUsd: 932.92 }),
        // An earlier snapshot of the same stream, under the suffix the slot had before.
        legacy(A.id, 'agent-3-59d3f5f', {
          ...slot3,
          tokensTotal: 1_026_698_205,
          costUsd: 890.79,
          lastSeenAt: at(50),
        }),
      ],
    });
    expect(failing(report)).toEqual(['I2', 'I4']);
    expect(summary(report, 'I2')).toMatchObject({ tokens: 1_026_698_205, costUsd: 890.79 });
    expect(summary(report, 'I4').costUsd).toBeCloseTo(932.92 + 890.79);
  });

  it('I2: nested repositories each stored the same session total', () => {
    const rows = [A, B, C].map((repo, i) => legacy(repo.id, SID, { slotId: i + 1, costUsd: 5.27 }));
    const report = check({ rows });
    expect(summary(report, 'I2').costUsd).toBeCloseTo(2 * 5.27);
    expect(report.blockedUnits.map((u) => u.repositoryId).sort()).toEqual([A.id, B.id, C.id]);
  });

  it('I2: a legacy total beside its session’s requests', () => {
    const observations = [request(1)];
    const rows = [...shipped(A.id, [], observations), legacy(B.id, SID, { firstSeenAt: at(1) })];
    expect(failing(check({ observations, rows }))).toEqual(['I2']);
  });

  it('I3: a row that gains tokens, a session that loses its rows, a max-merged Cursor row', () => {
    const observations = [request(1), request(2)];
    const rows = shipped(A.id, [], observations);
    const gained = rows.map((r) => ({ ...r, tokensCacheRead: r.tokensCacheRead + 500 }));
    expect(check({ observations, rows: gained }).violations[0].message).toMatch(
      /gain 500 tokens .*\(tokensCacheRead\)/,
    );
    expect(check({ observations, rows: [] }).violations[0].message).toMatch(/lose 2320 tokens/);

    const generation = (minutes: number, tokensInput: number) =>
      request(minutes, {
        agentTool: 'cursor',
        producer: 'otelhook.generation',
        model: 'gpt-5',
        tokensInput,
        tokensCacheRead: 0,
        costUsd: null,
      });
    const cursor = [generation(1, 300), generation(2, 500)];
    const [summed] = shipped(A.id, [], cursor);
    expect(check({ observations: cursor, rows: [summed] }).ok).toBe(true);
    expect(
      failing(check({ observations: cursor, rows: [{ ...summed, tokensInput: 500 }] })),
    ).toEqual(['I3']);
  });

  it('I5: Cursor cache reads added on top of an input that already holds them', () => {
    const row = legacy(A.id, 'c7c9bc29-d26d-4868-9413-8889e1bb7e2c', {
      agentTool: 'cursor',
      tokensInput: 27_276_507,
      tokensOutput: 84_373,
      tokensCacheRead: 26_887_680,
      tokensCacheCreation: 0,
      tokensTotal: 54_248_560,
      costUsd: null,
    });
    expect(summary(check({ rows: [row] }), 'I5')).toMatchObject({
      violations: 1,
      tokens: 26_887_680,
    });
  });
});

describe('adapters and scope', () => {
  it('reads Mission Control’s usage view and the portal’s usage[] alike', () => {
    const counters = {
      tokensInput: 1,
      tokensOutput: 2,
      tokensCacheRead: 3,
      tokensCacheCreation: 4,
      tokensTotal: 10,
      costUsd: 0.5,
    };
    const times = { firstSeenAt: at(0).toISOString(), lastSeenAt: at(1).toISOString() };
    const fromView = ledgerRowsFromUsageView(A.id, {
      usage: [
        {
          ...counters,
          ...times,
          sessionKey: SID,
          agentId: 2,
          agentTool: 'claude_code',
          origin: 'observations',
          workDir: '/w/2',
        },
        {
          ...counters,
          ...times,
          sessionKey: 'agent-3-abc',
          agentId: 3,
          agentTool: 'claude_code',
          origin: 'legacy',
        },
      ],
      unassigned: [
        { ...counters, ...times, sessionId: SID, agentTool: 'claude_code', itemized: false },
      ],
    });
    const fromPortal = ledgerRowsFromPortalUsage(A.id, [
      {
        ...counters,
        ...times,
        sessionKey: `${SID}@2:occ`,
        providerSessionId: SID,
        agentId: 2,
        agentTool: 'claude_code',
        workDir: '/w/2',
      },
      { ...counters, ...times, sessionKey: 'agent-3-abc', agentId: 3, agentTool: 'claude_code' },
      {
        ...counters,
        ...times,
        sessionKey: `${SID}@reported`,
        providerSessionId: SID,
        agentId: 0,
        agentTool: 'claude_code',
      },
    ]);
    expect(fromPortal).toEqual(fromView);
    expect(fromView.map((r) => [r.kind, r.key, r.slotId])).toEqual([
      ['attributed', SID, 2],
      ['legacy', 'agent-3-abc', 3],
      ['reported', SID, 0],
    ]);
  });

  it('scopes a report to one repository without losing cross-repository findings', () => {
    const report = checkUsageInvariants(
      {
        repositories: [A, B],
        observations: [request(1), request(1, { repositoryId: B.id })],
        rows: [],
      },
      { repositoryIds: [B.id] },
    );
    expect(failing(report)).toEqual(['I1', 'I3']);
    expect(report.blockedUnits.map((u) => u.repositoryId)).toEqual([B.id]);
  });
});
