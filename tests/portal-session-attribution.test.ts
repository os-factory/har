import {
  buildPortalAttributionBodies,
  combinePortalWatermark,
  parseStoredObservations,
} from '../src/core/portal-session-attribution';

function observation(key: string) {
  return {
    agentTool: 'codex' as const,
    sessionId: 'thread-1',
    observationKey: key,
    observedAt: '2026-03-01T10:00:00.000Z',
    granularity: 'turn' as const,
    source: 'harvest' as const,
    producer: 'sync.harvest',
    tokensInput: 1,
    tokensOutput: 1,
    tokensCacheRead: 0,
    tokensCacheCreation: 0,
  };
}

const binding = {
  agentTool: 'codex' as const,
  sessionId: 'thread-1',
  kind: 'launch' as const,
  slotId: 1,
  at: '2026-03-01T09:00:00.000Z',
};

describe('buildPortalAttributionBodies', () => {
  it('puts bindings and reported totals on the first body only and chunks observations', () => {
    const observations = Array.from({ length: 6 }, (_, i) => observation(`turn-${i}`));
    const bodies = buildPortalAttributionBodies(
      { path: '/repo/x', gitRemote: 'git@example.com:o/x.git' },
      { bindings: [binding], observations, reportedUsage: [] },
      'dev@example.com',
      JSON.stringify(observation('turn-0')).length * 2 + 200,
    );
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies[0].bindings).toHaveLength(1);
    expect(bodies.slice(1).every((body) => body.bindings.length === 0)).toBe(true);
    expect(bodies.flatMap((body) => body.observations)).toHaveLength(6);
    expect(bodies.every((body) => body.gitRemote === 'git@example.com:o/x.git')).toBe(true);
    expect(bodies[0].observations[0].userEmail).toBe('dev@example.com');
  });

  it('sends one body when there are no observations, and no user when none is known', () => {
    const [body, ...rest] = buildPortalAttributionBodies(
      { path: '/repo/x' },
      { bindings: [binding], observations: [observation('t')], reportedUsage: [] },
      undefined,
      1_000_000,
    );
    expect(rest).toHaveLength(0);
    expect(body.observations[0]).not.toHaveProperty('userEmail');
    expect(
      buildPortalAttributionBodies({ path: '/repo/x' }, { bindings: [], observations: [], reportedUsage: [] }, undefined, 10),
    ).toHaveLength(1);
  });
});

describe('parseStoredObservations', () => {
  it('drops rows the contract rejects instead of failing the sync', () => {
    expect(parseStoredObservations([observation('ok'), { ...observation('bad'), producer: '' }, null])).toHaveLength(1);
  });
});

describe('combinePortalWatermark', () => {
  it('advances to the latest change across channels', () => {
    expect(
      combinePortalWatermark('2026-03-01T10:00:00.000Z', {
        maxSyncedAt: '2026-03-01T11:00:00.000Z',
        truncatedAt: null,
      }),
    ).toBe('2026-03-01T11:00:00.000Z');
  });

  it('never passes the end of a truncated read', () => {
    expect(
      combinePortalWatermark('2026-03-01T12:00:00.000Z', {
        maxSyncedAt: '2026-03-01T11:00:00.000Z',
        truncatedAt: '2026-03-01T10:30:00.000Z',
      }),
    ).toBe('2026-03-01T10:30:00.000Z');
  });
});
