import {
  BindingTimeline,
  dedupeProducers,
  legacyRowSuperseded,
  MAIN_CHECKOUT_OCCUPANCY_KEY,
  observationCoverage,
  priceObservation,
  projectUsage,
  runningTotalDelta,
  worktreeOccupancyKey,
  type ObservationFact,
  type TimelineBinding,
} from '../packages/schemas/src/usage-attribution';

const T0 = Date.parse('2026-11-12T10:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

function bind(
  minutes: number,
  slotId: number,
  kind: TimelineBinding['kind'] = 'launch',
  extra: Partial<TimelineBinding> = {},
): TimelineBinding {
  return {
    agentTool: 'claude_code',
    sessionId: 'S1',
    kind,
    slotId,
    occupancyKey: `occ-${slotId}`,
    at: at(minutes),
    ...extra,
  };
}

function obs(minutes: number, extra: Partial<ObservationFact> = {}): ObservationFact {
  return {
    agentTool: 'claude_code',
    sessionId: 'S1',
    observationKey: `req-${minutes}-${extra.subagentId ?? ''}-${extra.sessionId ?? ''}`,
    observedAt: at(minutes),
    granularity: 'request',
    source: 'otel',
    producer: 'claude.api_request',
    model: 'claude-opus-5-5',
    tokensInput: 10,
    tokensOutput: 5,
    tokensCacheRead: 0,
    tokensCacheCreation: 0,
    costUsd: 1,
    ...extra,
  };
}

function costBySlot(projection: ReturnType<typeof projectUsage>) {
  const out: Record<string, number> = {};
  for (const bucket of projection.slots) {
    const key = `${bucket.sessionId}@${bucket.slotId}`;
    out[key] = (out[key] ?? 0) + (bucket.costUsd ?? 0);
  }
  for (const bucket of projection.unassigned) {
    const key = `${bucket.sessionId}@main`;
    out[key] = (out[key] ?? 0) + (bucket.costUsd ?? 0);
  }
  return out;
}

describe('projectUsage — evidence timeline', () => {
  it('keeps usage spent in main before a launch unassigned, then books the slot', () => {
    const projection = projectUsage([bind(10, 2)], [obs(1), obs(5), obs(11), obs(20)]);
    expect(costBySlot(projection)).toEqual({ 'S1@main': 2, 'S1@2': 2 });
    expect(projection.slots[0]).toMatchObject({ slotId: 2, occupancyKey: 'occ-2', observationCount: 2 });
  });

  it('follows a session through slots 2 → 3 → back to main', () => {
    const projection = projectUsage(
      [bind(10, 2), bind(20, 2, 'release'), bind(20, 3), bind(30, 3, 'release')],
      [obs(5), obs(12), obs(19), obs(21), obs(29), obs(31), obs(40)],
    );
    expect(costBySlot(projection)).toEqual({ 'S1@main': 3, 'S1@2': 2, 'S1@3': 2 });
  });

  it('moves to the newer slot on a second launch without a release', () => {
    const projection = projectUsage([bind(10, 2), bind(20, 3)], [obs(15), obs(25)]);
    expect(costBySlot(projection)).toEqual({ 'S1@2': 1, 'S1@3': 1 });
  });

  it('splits two sessions working in parallel on two slots', () => {
    const projection = projectUsage(
      [bind(1, 2), bind(1, 3, 'launch', { sessionId: 'S2' })],
      [obs(2), obs(3, { sessionId: 'S2' }), obs(4), obs(5, { sessionId: 'S2' }), obs(6, { sessionId: 'S2' })],
    );
    expect(costBySlot(projection)).toEqual({ 'S1@2': 2, 'S2@3': 3 });
  });

  it('books a subagent observed in another slot on that slot, and the parent on its own', () => {
    const projection = projectUsage(
      [bind(1, 2), bind(5, 4, 'observed', { subagentId: 'A1', occupancyKey: 'occ-4' })],
      [
        obs(2),
        obs(3, { subagentId: 'A1' }), // before the subagent's own evidence: parent's slot
        obs(6, { subagentId: 'A1' }),
        obs(7),
      ],
    );
    expect(costBySlot(projection)).toEqual({ 'S1@2': 3, 'S1@4': 1 });
  });

  it('falls back to the parent when the subagent has no binding', () => {
    const projection = projectUsage([bind(1, 2)], [obs(3, { subagentId: 'A9' })]);
    expect(costBySlot(projection)).toEqual({ 'S1@2': 1 });
  });

  it('closes a binding on release', () => {
    const projection = projectUsage([bind(1, 2), bind(10, 2, 'release')], [obs(5), obs(10), obs(15)]);
    expect(costBySlot(projection)).toEqual({ 'S1@2': 1, 'S1@main': 2 });
  });

  it('does not unbind a session that tears down another slot', () => {
    const projection = projectUsage(
      [bind(1, 3), bind(10, 2, 'release', { occupancyKey: 'occ-old-2' })],
      [obs(15)],
    );
    expect(costBySlot(projection)).toEqual({ 'S1@3': 1 });
  });

  it('closes a binding when another session releases the slot', () => {
    const projection = projectUsage(
      [bind(1, 2, 'observed'), bind(10, 2, 'release', { sessionId: 'S2' })],
      [obs(5), obs(15)],
    );
    expect(costBySlot(projection)).toEqual({ 'S1@2': 1, 'S1@main': 1 });
  });

  it('never lets a binding outlive its occupancy when the slot is reoccupied', () => {
    const projection = projectUsage(
      [bind(1, 2), bind(10, 2, 'launch', { sessionId: 'S2', occupancyKey: 'occ-2b' })],
      [obs(5), obs(15)],
      [],
    );
    expect(costBySlot(projection)).toEqual({ 'S1@2': 1, 'S1@main': 1 });
  });

  it('honours occupancy boundaries known outside the bindings', () => {
    const projection = projectUsage(
      [bind(1, 2)],
      [obs(5), obs(15)],
      [{ slotId: 2, occupancyKey: 'occ-2', at: at(10), kind: 'end' }],
    );
    expect(costBySlot(projection)).toEqual({ 'S1@2': 1, 'S1@main': 1 });
  });

  it('re-attributes usage when a binding arrives late', () => {
    const observations = [obs(5), obs(15), obs(25)];
    expect(costBySlot(projectUsage([], observations))).toEqual({ 'S1@main': 3 });
    expect(costBySlot(projectUsage([bind(10, 2)], observations))).toEqual({
      'S1@main': 1,
      'S1@2': 2,
    });
  });

  it('leaves an observation before any binding unassigned', () => {
    const projection = projectUsage([bind(10, 2)], [obs(9)]);
    expect(projection.slots).toEqual([]);
    expect(projection.unassigned).toHaveLength(1);
    expect(projection.unassigned[0]).toMatchObject({ sessionId: 'S1', observationCount: 1, costUsd: 1 });
  });

  it('counts cwd evidence from its first sighting: it never overrides a later move elsewhere', () => {
    const projection = projectUsage(
      [
        bind(1, 2, 'workspace'),
        bind(10, 3, 'observed', { occupancyKey: 'occ-3' }),
        bind(12, 2, 'workspace'),
        bind(20, 2, 'workspace'),
      ],
      [obs(5), obs(15), obs(25)],
    );
    expect(costBySlot(projection)).toEqual({ 'S1@2': 1, 'S1@3': 2 });
  });

  it('lets cwd evidence of a new occupancy take over', () => {
    const projection = projectUsage(
      [bind(1, 3, 'observed', { occupancyKey: 'occ-3' }), bind(10, 2, 'workspace')],
      [obs(5), obs(15)],
    );
    expect(costBySlot(projection)).toEqual({ 'S1@3': 1, 'S1@2': 1 });
  });

  it('never re-binds to an occupancy that already ended, even on later evidence', () => {
    const projection = projectUsage(
      [bind(1, 2), bind(10, 2, 'release'), bind(12, 2, 'workspace'), bind(13, 2, 'observed')],
      [obs(5), obs(15)],
    );
    expect(costBySlot(projection)).toEqual({ 'S1@2': 1, 'S1@main': 1 });
  });

  it('prefers the launch at the same instant as an observed binding', () => {
    const timeline = new BindingTimeline([
      bind(10, 3, 'observed'),
      bind(10, 2, 'launch'),
    ]);
    expect(timeline.resolve({ agentTool: 'claude_code', sessionId: 'S1' }, at(10))?.slotId).toBe(2);
  });

  it('sums tokens and a per-model breakdown', () => {
    const projection = projectUsage([], [obs(1), obs(2, { model: 'claude-haiku-5', costUsd: 0.5 })]);
    expect(projection.unassigned[0]).toMatchObject({
      tokensInput: 20,
      tokensOutput: 10,
      tokensTotal: 30,
      costUsd: 1.5,
      costSource: 'reported',
      firstSeenAt: at(1),
      lastSeenAt: at(2),
    });
    expect(Object.keys(projection.unassigned[0].modelBreakdown).sort()).toEqual([
      'claude-haiku-5',
      'claude-opus-5-5',
    ]);
  });
});

describe('priceObservation', () => {
  it('uses the provider cost when given', () => {
    expect(priceObservation(obs(1, { costUsd: 0.42 }))).toMatchObject({
      pricedCostUsd: 0.42,
      costSource: 'reported',
    });
  });

  it('estimates from the model price when no cost is reported', () => {
    const priced = priceObservation(
      obs(1, {
        agentTool: 'claude_code',
        model: 'claude-sonnet-4-5',
        costUsd: null,
        tokensInput: 1_000_000,
        tokensOutput: 0,
      }),
    );
    expect(priced.costSource).toBe('estimated');
    expect(priced.pricedCostUsd).toBeGreaterThan(0);
  });

  it('leaves a Cursor request unpriced, even with a reported cost (FE-2058)', () => {
    expect(priceObservation(obs(1, { agentTool: 'cursor', costUsd: 0.42 }))).toMatchObject({
      pricedCostUsd: null,
      costSource: null,
    });
  });

  it('leaves the cost unknown for an unpriced model', () => {
    expect(priceObservation(obs(1, { model: 'no-such-model-xyz', costUsd: null }))).toMatchObject({
      pricedCostUsd: null,
      costSource: null,
    });
  });
});

describe('runningTotalDelta', () => {
  const totals = (input: number, output: number) => ({
    tokensInput: input,
    tokensOutput: output,
    tokensCacheRead: 0,
    tokensCacheCreation: 0,
  });

  it('is the difference from the previous total, or the total itself for the first unit', () => {
    expect(runningTotalDelta(null, totals(100, 10))).toEqual(totals(100, 10));
    expect(runningTotalDelta(totals(100, 10), totals(250, 12))).toEqual(totals(150, 2));
  });

  it('treats a counter that goes down as a restart, never a negative delta', () => {
    expect(runningTotalDelta(totals(100, 10), totals(40, 4))).toEqual(totals(40, 4));
  });
});

describe('dedupeProducers', () => {
  const codex = (minutes: number, producer: string, extra: Partial<ObservationFact> = {}) =>
    obs(minutes, {
      agentTool: 'codex',
      producer,
      source: producer.startsWith('sync.') ? 'harvest' : 'otel',
      observationKey: `${producer}-${minutes}`,
      ...extra,
    });

  it('keeps one stream per instant when keys differ: the live stream wins its window, harvest fills the rest', () => {
    const kept = dedupeProducers([
      codex(1, 'sync.harvest'),
      codex(2, 'sync.harvest'),
      codex(5, 'sync.harvest'),
      codex(9, 'sync.harvest'),
      codex(4, 'otelhook.generation-span'),
      codex(6, 'otelhook.generation-span'),
    ]);
    expect(kept.map((o) => `${o.producer}@${(o.observedAt.getTime() - T0) / 60_000}`).sort()).toEqual(
      ['otelhook.generation-span@4', 'otelhook.generation-span@6', 'sync.harvest@1', 'sync.harvest@2', 'sync.harvest@9'].sort(),
    );
  });

  it('never drops Codex harvest turns between hook turns: both key by turn id', () => {
    expect(dedupeProducers([codex(1, 'otelhook.generation'), codex(2, 'sync.harvest'), codex(3, 'otelhook.generation')])).toHaveLength(3);
  });

  it('never drops Claude harvest rows inside the live window: both key by request id', () => {
    const kept = dedupeProducers([
      obs(1),
      obs(5),
      obs(3, { producer: 'sync.harvest', source: 'harvest', observationKey: 'req-missed-live' }),
    ]);
    expect(kept).toHaveLength(3);
  });

  it('never compares producers across sessions', () => {
    const kept = dedupeProducers([obs(1), obs(1, { sessionId: 'S2', producer: 'sync.harvest' })]);
    expect(kept).toHaveLength(2);
  });
});

describe('legacyRowSuperseded', () => {
  const coverage = observationCoverage([obs(10), obs(20)]);

  it('keeps legacy rows of another tool or another time', () => {
    expect(
      legacyRowSuperseded(
        { agentTool: 'codex', sessionKey: 'x', firstSeenAt: at(10), lastSeenAt: at(20) },
        coverage,
      ),
    ).toBe(false);
    expect(
      legacyRowSuperseded(
        { agentTool: 'claude_code', sessionKey: 'branch-a', firstSeenAt: at(-60), lastSeenAt: at(0) },
        coverage,
      ),
    ).toBe(false);
  });

  it('supersedes legacy rows of the same session or overlapping in time', () => {
    expect(
      legacyRowSuperseded(
        { agentTool: 'claude_code', sessionKey: 'S1', firstSeenAt: at(-60), lastSeenAt: at(-50) },
        coverage,
      ),
    ).toBe(true);
    expect(
      legacyRowSuperseded(
        { agentTool: 'claude_code', sessionKey: 'branch-a', firstSeenAt: at(15), lastSeenAt: at(30) },
        coverage,
      ),
    ).toBe(true);
  });
});

describe('non-slot worktrees (state 2)', () => {
  const worktree = (minutes: number, sessionId: string, workDir: string | null, branch: string) =>
    bind(minutes, 0, 'workspace', {
      sessionId,
      occupancyKey: worktreeOccupancyKey({ workDir, branch }),
      branch,
    });

  it('splits a session\'s unassigned usage between the main checkout and the worktree it moved to', () => {
    const projection = projectUsage(
      [worktree(10, 'S1', '/repo/.claude/worktrees/fix', 'fix')],
      [obs(5), obs(15), obs(20)],
    );
    expect(projection.slots).toEqual([]);
    expect(
      projection.unassigned.map((bucket) => [bucket.workDir, bucket.branch, bucket.costUsd]),
    ).toEqual([
      [null, null, 1],
      ['/repo/.claude/worktrees/fix', 'fix', 2],
    ]);
  });

  it('names a worktree known only by its branch', () => {
    const projection = projectUsage([worktree(0, 'S1', null, 'fix')], [obs(5)]);
    expect(projection.unassigned).toEqual([expect.objectContaining({ workDir: null, branch: 'fix', costUsd: 1 })]);
  });

  it('does not let one session\'s worktree close another session\'s', () => {
    const projection = projectUsage(
      [worktree(0, 'S1', '/wt/a', 'a'), worktree(10, 'S2', '/wt/b', 'b')],
      [obs(20), obs(20, { sessionId: 'S2' })],
    );
    expect(
      projection.unassigned.map((bucket) => [bucket.sessionId, bucket.workDir]).sort(),
    ).toEqual([
      ['S1', '/wt/a'],
      ['S2', '/wt/b'],
    ]);
  });

  it('moves the usage to a slot once a launch binds it', () => {
    const projection = projectUsage([worktree(0, 'S1', '/wt/a', 'a'), bind(10, 2)], [obs(5), obs(15)]);
    expect(projection.unassigned.map((bucket) => bucket.workDir)).toEqual(['/wt/a']);
    expect(projection.slots.map((bucket) => bucket.slotId)).toEqual([2]);
  });

  it('books usage after a main-checkout binding with the session\'s unbound main-checkout usage', () => {
    // A session works in another repository's slot, then here again (FE-2058).
    const projection = projectUsage(
      [bind(10, 2), bind(20, 0, 'workspace', { occupancyKey: MAIN_CHECKOUT_OCCUPANCY_KEY })],
      [obs(5), obs(15), obs(25)],
    );
    expect(projection.slots.map((bucket) => [bucket.slotId, bucket.costUsd])).toEqual([[2, 1]]);
    expect(projection.unassigned.map((bucket) => [bucket.workDir, bucket.branch, bucket.costUsd])).toEqual([[null, null, 2]]);
  });
});
