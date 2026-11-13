import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Minimal in-memory stand-in for the three tables this module writes. A
 * composite unique `where` matches on its nested fields.
 */
const db = vi.hoisted(() => {
  type Row = Record<string, unknown> & { id: string };
  const tables: Record<string, Row[]> = { bindings: [], observations: [], reported: [] };
  let seq = 0;
  const OPS = ['lt', 'lte', 'gt', 'gte', 'not', 'equals', 'in'];
  const key = (value: unknown) => (value instanceof Date ? value.getTime() : value);
  const test = (actual: unknown, op: string, expected: unknown): boolean => {
    const a = key(actual) as number;
    const e = key(expected) as number;
    if (op === 'lt') return a < e;
    if (op === 'lte') return a <= e;
    if (op === 'gt') return a > e;
    if (op === 'gte') return a >= e;
    if (op === 'not') return a !== e;
    if (op === 'in') return (expected as unknown[]).includes(actual);
    return a === e;
  };
  /** Field filters with Prisma operators; a nested non-operator object is a composite unique key. */
  const matches = (row: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([field, value]): boolean => {
      if (field === 'OR') return (value as Array<Record<string, unknown>>).some((clause) => matches(row, clause));
      if (value && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value)) {
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.every(([op]) => OPS.includes(op))) return entries.every(([op, v]) => test(row[field], op, v));
        return matches(row, value as Record<string, unknown>);
      }
      return key(row[field]) === key(value);
    });
  type Order = Array<Record<string, 'asc' | 'desc'>> | undefined;
  const sorted = (rows: Row[], orderBy: Order) =>
    [...rows].sort((left, right) => {
      for (const clause of orderBy ?? []) {
        const [field, direction] = Object.entries(clause)[0];
        const a = key(left[field]) as number;
        const b = key(right[field]) as number;
        if (a !== b) return (a < b ? -1 : 1) * (direction === 'asc' ? 1 : -1);
      }
      return 0;
    });
  const table = (name: string) => ({
    findUnique: async ({ where }: { where: Record<string, unknown> }) =>
      tables[name].find((row) => matches(row, where)) ?? null,
    findFirst: async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: Order }) =>
      sorted(tables[name].filter((row) => matches(row, where)), orderBy)[0] ?? null,
    findMany: async ({ where, orderBy, take }: { where: Record<string, unknown>; orderBy?: Order; take?: number }) =>
      sorted(tables[name].filter((row) => matches(row, where)), orderBy).slice(0, take),
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `r${(seq += 1)}`, ...data };
      tables[name].push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = tables[name].find((candidate) => candidate.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
    upsert: async ({ where, create, update }: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) => {
      const row = tables[name].find((candidate) => matches(candidate, where));
      if (row) return Object.assign(row, update);
      const created = { id: `r${(seq += 1)}`, ...create };
      tables[name].push(created);
      return created;
    },
  });
  return { tables, table };
});

vi.mock('@/lib/db', () => ({
  prisma: {
    sessionSlotBinding: db.table('bindings'),
    usageObservation: db.table('observations'),
    sessionReportedUsage: db.table('reported'),
    agentSlot: {
      findUnique: async () => ({ branch: 'main-abcd-har-agent-2-xy12', occupancyKey: 'occ-2' }),
    },
  },
}));

import {
  buildUsageView,
  listReportedUsage,
  listSessionBindingsPage,
  listUsageObservationChanges,
  mergeRepeatedObservation,
  recordBindings,
  recordObservations,
  recordReportedUsage,
  syncSessionBindings,
  syncUsageObservations,
} from './session-attribution';

const AT = '2026-11-12T10:00:00.000Z';

beforeEach(() => {
  db.tables.bindings.length = 0;
  db.tables.observations.length = 0;
  db.tables.reported.length = 0;
});

describe('syncSessionBindings', () => {
  const binding = {
    agentTool: 'claude_code',
    sessionId: 'S1',
    kind: 'launch',
    slotId: 2,
    branch: 'main-abcd-har-agent-2-xy12',
    at: AT,
  };

  it('validates with the contract schema', async () => {
    await expect(syncSessionBindings('repo-1', { bindings: [{ ...binding, kind: 'guess' }] })).rejects.toThrow();
    await expect(syncSessionBindings('repo-1', { bindings: [{ ...binding, slotId: 0 }] })).rejects.toThrow();
  });

  it('is idempotent and fills the occupancy of the slot on the same branch', async () => {
    expect(await syncSessionBindings('repo-1', { bindings: [binding] })).toEqual({ synced: 1, created: 1 });
    expect(await syncSessionBindings('repo-1', { bindings: [binding] })).toEqual({ synced: 1, created: 0 });
    expect(db.tables.bindings).toHaveLength(1);
    expect(db.tables.bindings[0]).toMatchObject({ subagentId: '', occupancyKey: 'occ-2', origin: 'sync' });
  });

  it('keeps a binding of another subagent, kind or instant distinct', async () => {
    await recordBindings(
      'repo-1',
      [
        { agentTool: 'claude_code', sessionId: 'S1', kind: 'observed', slotId: 2, at: new Date(AT) },
        { agentTool: 'claude_code', sessionId: 'S1', subagentId: 'A', kind: 'observed', slotId: 2, at: new Date(AT) },
        { agentTool: 'claude_code', sessionId: 'S1', kind: 'launch', slotId: 2, at: new Date(AT) },
      ],
      'otel',
    );
    expect(db.tables.bindings).toHaveLength(3);
  });
});

describe('syncUsageObservations', () => {
  const observation = {
    agentTool: 'claude_code',
    sessionId: 'S1',
    observationKey: 'req_1',
    observedAt: AT,
    granularity: 'message',
    source: 'harvest',
    model: 'claude-opus-5-5',
    tokensInput: 10,
    tokensOutput: 20,
  };

  it('validates with the contract schema', async () => {
    await expect(
      syncUsageObservations('repo-1', { observations: [{ ...observation, tokensInput: -1 }] }),
    ).rejects.toThrow();
  });

  it('is idempotent per key, and the same producer may correct its fact', async () => {
    await syncUsageObservations('repo-1', { observations: [observation] });
    await syncUsageObservations('repo-1', { observations: [{ ...observation, tokensOutput: 25 }] });
    expect(db.tables.observations).toHaveLength(1);
    expect(db.tables.observations[0]).toMatchObject({ producer: 'sync.harvest', tokensOutput: 25n, subagentId: '' });
  });

  const live = {
    ...observation,
    observedAt: new Date(AT),
    granularity: 'request',
    source: 'otel' as const,
    producer: 'claude.api_request',
    tokensOutput: 30,
    costUsd: 0.25,
  };

  it('lets the live report replace a harvested copy of the same request', async () => {
    await syncUsageObservations('repo-1', { observations: [observation] });
    await recordObservations('repo-1', [live]);
    expect(db.tables.observations).toHaveLength(1);
    expect(db.tables.observations[0]).toMatchObject({ producer: 'claude.api_request', tokensOutput: 30n });
    expect(Number(db.tables.observations[0].costUsd)).toBe(0.25);
  });

  it('never lets a harvested copy overwrite or erase the live cost', async () => {
    await recordObservations('repo-1', [live]);
    await syncUsageObservations('repo-1', { observations: [{ ...observation, tokensOutput: 999 }] });
    expect(db.tables.observations).toHaveLength(1);
    expect(db.tables.observations[0]).toMatchObject({ producer: 'claude.api_request', tokensOutput: 30n });
    expect(Number(db.tables.observations[0].costUsd)).toBe(0.25);
  });
});

describe('mergeRepeatedObservation', () => {
  const harvest = { producer: 'sync.harvest', source: 'harvest' };
  const otel = { producer: 'claude.api_request', source: 'otel' };

  it('keeps a stored cost when a re-harvest reports none', () => {
    expect(mergeRepeatedObservation({ ...harvest, costUsd: 1 }, { ...harvest, costUsd: null })).toEqual({
      replace: true,
      costUsd: 1,
    });
  });

  it('only fills a missing cost from a lower-authority repeat', () => {
    expect(mergeRepeatedObservation({ ...otel, costUsd: null }, { ...harvest, costUsd: 2 })).toEqual({
      replace: false,
      costUsd: 2,
    });
    expect(mergeRepeatedObservation({ ...otel, costUsd: 1 }, { ...harvest, costUsd: null })).toBeNull();
  });
});

describe('Codex running totals', () => {
  const t = (minutes: number) => new Date(Date.parse(AT) + minutes * 60_000);
  const turn = (minutes: number, input: number, output: number) => ({
    agentTool: 'codex',
    sessionId: 'thread-1',
    observationKey: `turn-${minutes}`,
    observedAt: t(minutes),
    granularity: 'turn',
    source: 'otel' as const,
    producer: 'otelhook.generation',
    runningTotal: { tokensInput: input, tokensOutput: output, tokensCacheRead: 0, tokensCacheCreation: 0 },
  });
  const harvested = (minutes: number, input: number, output: number) => ({
    agentTool: 'codex',
    sessionId: 'thread-1',
    observationKey: `turn-${minutes}`,
    observedAt: t(minutes).toISOString(),
    granularity: 'turn',
    source: 'harvest',
    tokensInput: input,
    tokensOutput: output,
  });
  const usage = () =>
    Object.fromEntries(
      [...db.tables.observations]
        .sort((a, b) => (a.observedAt as Date).getTime() - (b.observedAt as Date).getTime())
        .map((row) => [row.observationKey, [Number(row.tokensInput), Number(row.tokensOutput)]]),
    );

  it('stores each turn as its difference from the previous turn, whatever the arrival order', async () => {
    await recordObservations('repo-1', [turn(1, 100, 10)]);
    await recordObservations('repo-1', [turn(3, 300, 30)]);
    await recordObservations('repo-1', [turn(2, 250, 12)]);
    expect(usage()).toEqual({ 'turn-1': [100, 10], 'turn-2': [150, 2], 'turn-3': [50, 18] });
  });

  it('merges with the harvested turn of the same id and never counts harvested turns twice', async () => {
    // Harvest saw turns 1 and 2; the hook only saw turn 2 and 3 (installed late).
    await syncUsageObservations('repo-1', { observations: [harvested(1, 100, 10), harvested(2, 150, 2)] });
    await recordObservations('repo-1', [turn(2, 250, 12), turn(3, 300, 30)]);
    expect(db.tables.observations).toHaveLength(3);
    expect(usage()).toEqual({ 'turn-1': [100, 10], 'turn-2': [150, 2], 'turn-3': [50, 18] });
  });

  it('corrects a later turn when a harvested earlier turn arrives after it', async () => {
    await recordObservations('repo-1', [turn(3, 300, 30)]);
    expect(usage()).toEqual({ 'turn-3': [300, 30] });
    await syncUsageObservations('repo-1', { observations: [harvested(1, 100, 10), harvested(2, 150, 2)] });
    expect(usage()).toEqual({ 'turn-1': [100, 10], 'turn-2': [150, 2], 'turn-3': [50, 18] });
  });
});

describe('recordReportedUsage', () => {
  const base = { agentTool: 'claude_code', sessionId: 'S1', tokensTotal: 100, at: new Date(AT) };

  it('max-merges cumulative totals and adds delta ones', async () => {
    await recordReportedUsage('repo-1', { ...base, costUsd: 1, temporality: 'cumulative' });
    await recordReportedUsage('repo-1', { ...base, costUsd: 0.5, temporality: 'cumulative' });
    expect(Number(db.tables.reported[0].costUsd)).toBe(1);
    await recordReportedUsage('repo-1', { ...base, costUsd: 0.5, temporality: 'delta' });
    expect(Number(db.tables.reported[0].costUsd)).toBe(1.5);
  });
});

describe('buildUsageView', () => {
  const t = (minutes: number) => new Date(Date.parse(AT) + minutes * 60_000);
  const fact = (minutes: number, sessionId = 'S1') => ({
    agentTool: 'claude_code',
    sessionId,
    observationKey: `k-${sessionId}-${minutes}`,
    observedAt: t(minutes),
    granularity: 'request',
    source: 'otel',
    producer: 'claude.api_request',
    model: 'claude-opus-5-5',
    tokensInput: 1,
    tokensOutput: 1,
    tokensCacheRead: 0,
    tokensCacheCreation: 0,
    costUsd: 0.5,
  });
  const legacyRow = (sessionKey: string, from: number, to: number) => ({
    id: `legacy-${sessionKey}`,
    repositoryId: 'repo-1',
    sessionKey,
    agentId: 1,
    agentTool: 'claude_code',
    workDir: null,
    branch: sessionKey,
    suffix: null,
    occupancyKey: null,
    workUnitId: null,
    attemptId: null,
    tokensInput: 1n,
    tokensOutput: 1n,
    tokensCacheRead: 0n,
    tokensCacheCreation: 0n,
    tokensTotal: 2n,
    costUsd: new Prisma.Decimal(9),
    costSource: 'reported',
    modelBreakdown: null,
    sources: ['otel'],
    harvestVersion: 1,
    firstSeenAt: t(from),
    lastSeenAt: t(to),
    updatedAt: t(to),
  });

  const view = buildUsageView({
    repositoryId: 'repo-1',
    bindings: [{ agentTool: 'claude_code', sessionId: 'S1', kind: 'launch', slotId: 2, occupancyKey: 'attempt::A1', at: t(10) }],
    observations: [fact(5), fact(15), fact(20)],
    slots: [
      {
        slotId: 2,
        occupancyKey: 'attempt::A1',
        workDir: '/wt/2',
        worktreePath: '/wt/2',
        branch: 'b2',
        suffix: 'xy',
        workUnitId: 'WU-7',
        attemptId: 'A1',
        sessionCreatedAt: t(9),
      },
    ],
    attempts: [],
    legacy: [legacyRow('old-branch', -600, -500), legacyRow('overlapping', 0, 30)],
    reported: [
      { agentTool: 'claude_code', sessionId: 'S1', costUsd: 1.6, tokensTotal: 6, firstSeenAt: t(0), lastSeenAt: t(20) },
      { agentTool: 'claude_code', sessionId: 'S9', costUsd: 3, tokensTotal: 9, firstSeenAt: t(0), lastSeenAt: t(1) },
    ],
  });

  it('books the observations after the launch on the slot, as a usage row of that occupancy', () => {
    const derived = view.rows.filter((row) => row.origin === 'observations');
    expect(derived).toHaveLength(1);
    expect(derived[0]).toMatchObject({
      sessionKey: 'S1',
      agentId: 2,
      occupancyKey: 'attempt::A1',
      attemptId: 'A1',
      workUnitId: 'WU-7',
      workDir: '/wt/2',
      branch: 'b2',
      tokensTotal: 4n,
      costSource: 'reported',
    });
    expect(Number(derived[0].costUsd)).toBe(1);
  });

  it('keeps legacy rows no observation covers, and drops the ones it does', () => {
    expect(view.rows.filter((row) => row.origin === 'legacy').map((row) => row.sessionKey)).toEqual(['old-branch']);
  });

  it('shows usage before the launch as the session\'s unassigned usage, plus reported-only sessions', () => {
    expect(view.unassigned).toEqual([
      expect.objectContaining({ sessionId: 'S1', costUsd: 0.5, observationCount: 1, itemized: true }),
      expect.objectContaining({ sessionId: 'S9', costUsd: 3, observationCount: 0, itemized: false }),
    ]);
  });

  it('cross-checks the observed sum against the reported session total', () => {
    expect(view.crossChecks).toEqual([
      expect.objectContaining({ sessionId: 'S1', observedCostUsd: 1.5, reportedCostUsd: 1.6, observationCount: 3 }),
    ]);
  });
});

describe('mirror reads (har-portal)', () => {
  function stored(id: string, updatedAt: string, observedAt: string) {
    return {
      id,
      repositoryId: 'repo-1',
      agentTool: 'claude_code',
      sessionId: 'S1',
      subagentId: '',
      observationKey: `req_${id}`,
      observedAt: new Date(observedAt),
      granularity: 'request',
      source: 'otel',
      producer: 'claude.api_request',
      model: null,
      tokensInput: BigInt(1),
      tokensOutput: BigInt(2),
      tokensCacheRead: BigInt(0),
      tokensCacheCreation: BigInt(0),
      costUsd: new Prisma.Decimal(0.5),
      reportedTotals: null,
      updatedAt: new Date(updatedAt),
    };
  }

  it('pages observations in change order, so a late fact with an old observedAt is not skipped', async () => {
    const t = '2026-11-12T10:00:00.000Z';
    db.tables.observations.push(
      stored('a', t, t),
      stored('b', t, t),
      // Harvested late: observed long before, changed after the cursor.
      stored('c', '2026-11-12T11:00:00.000Z', '2026-11-11T09:00:00.000Z'),
    );
    const first = await listUsageObservationChanges('repo-1', { since: null, sinceId: null, limit: 1 });
    expect(first.map((row) => row.id)).toEqual(['a']);
    // A page boundary inside one millisecond loses nothing.
    const next = await listUsageObservationChanges('repo-1', { since: t, sinceId: 'a', limit: 10 });
    expect(next.map((row) => row.id)).toEqual(['b', 'c']);
    expect(next[1]).toMatchObject({
      observedAt: '2026-11-11T09:00:00.000Z',
      updatedAt: '2026-11-12T11:00:00.000Z',
      producer: 'claude.api_request',
      costUsd: 0.5,
    });
  });

  it('pages bindings in storage order with their cursor columns', async () => {
    await syncSessionBindings('repo-1', {
      bindings: [{ agentTool: 'codex', sessionId: 'T1', kind: 'launch', slotId: 2, at: AT }],
    });
    for (const row of db.tables.bindings) row.createdAt = new Date(AT);
    const page = await listSessionBindingsPage('repo-1', { since: null, sinceId: null, limit: 10 });
    expect(page).toEqual([
      expect.objectContaining({ agentTool: 'codex', sessionId: 'T1', kind: 'launch', slotId: 2, createdAt: AT }),
    ]);
    expect(await listSessionBindingsPage('repo-1', { since: AT, sinceId: page[0].id, limit: 10 })).toEqual([]);
  });

  it('lists provider-reported session totals', async () => {
    await recordReportedUsage('repo-1', {
      agentTool: 'claude_code',
      sessionId: 'S1',
      costUsd: 1.5,
      tokensTotal: 300,
      at: new Date(AT),
      temporality: 'cumulative',
    });
    expect(await listReportedUsage('repo-1')).toEqual([
      { agentTool: 'claude_code', sessionId: 'S1', costUsd: 1.5, tokensTotal: 300, firstSeenAt: AT, lastSeenAt: AT },
    ]);
  });
});
