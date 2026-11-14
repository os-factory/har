import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mission Control's usage invariants (FE-2058): the real loader and usage view
 * over an in-memory store — what `GET /api/usage/invariants` reports.
 */
const db = vi.hoisted(() => {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    repository: [],
    sessionSlotBinding: [],
    usageObservation: [],
    agentSlot: [],
    workAttempt: [],
    agentSessionUsage: [],
    sessionReportedUsage: [],
  };
  const table = (name: string) => ({
    findMany: async (args: { where?: { repositoryId?: string } } = {}) =>
      tables[name].filter(
        (row) => !args.where?.repositoryId || row.repositoryId === args.where.repositoryId,
      ),
  });
  return { tables, table };
});

vi.mock('@/lib/db', () => ({
  prisma: Object.fromEntries(Object.keys(db.tables).map((name) => [name, db.table(name)])),
}));

import { checkMissionControlUsage, UnknownRepositoryError } from './usage-invariants';

const SID = '11111111-2222-4333-8444-555555555555';
const AT = new Date('2026-11-12T10:00:00.000Z');

function observation(repositoryId: string, key: string, minutes = 0) {
  return {
    repositoryId,
    agentTool: 'claude_code',
    sessionId: SID,
    subagentId: '',
    observationKey: key,
    observedAt: new Date(AT.getTime() + minutes * 60_000),
    granularity: 'request',
    source: 'otel',
    producer: 'claude.api_request',
    model: 'claude-opus-5-5',
    tokensInput: 10n,
    tokensOutput: 20n,
    tokensCacheRead: 1_000n,
    tokensCacheCreation: 0n,
    costUsd: 0.25,
    updatedAt: AT,
  };
}

function legacyTotal(sessionKey: string, firstSeenAt: Date) {
  return {
    id: sessionKey,
    repositoryId: 'a',
    sessionKey,
    agentId: 3,
    agentTool: 'claude_code',
    workDir: '/work/a',
    tokensInput: 1n,
    tokensOutput: 1n,
    tokensCacheRead: 0n,
    tokensCacheCreation: 0n,
    tokensTotal: 2n,
    costUsd: null,
    sources: [],
    harvestVersion: 2,
    firstSeenAt,
    lastSeenAt: firstSeenAt,
    updatedAt: firstSeenAt,
  };
}

beforeEach(() => {
  for (const rows of Object.values(db.tables)) rows.length = 0;
  db.tables.repository.push({ id: 'a', path: '/work/a' }, { id: 'b', path: '/work/a/nested' });
});

describe('checkMissionControlUsage', () => {
  it('holds for a session spanning two repositories with disjoint requests', async () => {
    db.tables.usageObservation.push(
      observation('a', 'req-1'),
      observation('b', 'req-2', 1),
      observation('a', 'req-3', 2),
    );
    const report = await checkMissionControlUsage();
    expect(report.violations).toEqual([]);
    expect(report.checked).toEqual({ repositories: 2, observations: 3, rows: 2 });
  });

  it('finds a request both nested repositories stored, from either side', async () => {
    db.tables.usageObservation.push(observation('a', 'req-1'), observation('b', 'req-1'));
    const report = await checkMissionControlUsage('/work/a/nested');
    // The copy also gains usage against the request counted once (I3).
    expect(report.violations.map((v) => v.invariant)).toEqual(['I1', 'I3']);
    expect(report.violations[0]).toMatchObject({
      repositoryIds: ['a', 'b'],
      keys: [SID],
      tokens: 1_030,
    });
    expect(report.blockedUnits).toEqual([
      { repositoryId: 'b', agentTool: 'claude_code', key: SID, invariants: ['I1'] },
    ]);
  });

  it('flags a served legacy slot total booked in the main checkout, not one the observations supersede', async () => {
    db.tables.usageObservation.push(observation('a', 'req-1'));
    db.tables.agentSessionUsage.push(
      legacyTotal('agent-3-old', AT),
      legacyTotal('agent-3-new', new Date('2026-01-01T00:00:00Z')),
    );
    const report = await checkMissionControlUsage('a');
    expect(report.violations.map((v) => [v.invariant, v.keys])).toEqual([['I4', ['agent-3-new']]]);
  });

  it('rejects an unknown repository', async () => {
    await expect(checkMissionControlUsage('/nope')).rejects.toBeInstanceOf(UnknownRepositoryError);
  });
});
