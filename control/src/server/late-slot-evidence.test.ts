import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** In-memory stand-in for the tables late evidence reads and rewrites. */
const db = vi.hoisted(() => {
  type Row = Record<string, unknown> & { id: string };
  const names = ['bindings', 'slots', 'attempts', 'spans', 'events', 'trajectory'] as const;
  const tables = Object.fromEntries(names.map((name) => [name, [] as Row[]])) as Record<(typeof names)[number], Row[]>;
  let seq = 0;
  const key = (value: unknown) => (value instanceof Date ? value.getTime() : value);
  const test = (actual: unknown, op: string, expected: unknown): boolean => {
    const a = key(actual) as number;
    const e = key(expected) as number;
    if (op === 'lte') return a <= e;
    if (op === 'gte') return a >= e;
    if (op === 'in') return (expected as unknown[]).includes(actual);
    return a === e;
  };
  const matches = (row: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([field, value]): boolean => {
      if (field === 'OR') return (value as Array<Record<string, unknown>>).some((clause) => matches(row, clause));
      if (value && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value)) {
        return Object.entries(value as Record<string, unknown>).every(([op, v]) => test(row[field], op, v));
      }
      return key(row[field]) === key(value);
    });
  /** Unique key of a binding row, as the real table enforces it. */
  const bindingKey = (row: Row) =>
    ['repositoryId', 'agentTool', 'sessionId', 'subagentId', 'kind', 'slotId', 'at'].map((f) => String(key(row[f]))).join('|');
  const table = (name: (typeof names)[number]) => ({
    findMany: async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
      tables[name].filter((row) => matches(row, where)).slice(0, take),
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = tables[name].find((candidate) => candidate.id === where.id)!;
      const next = { ...row, ...data };
      if (name === 'bindings' && tables.bindings.some((other) => other !== row && bindingKey(other) === bindingKey(next))) {
        throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
      }
      return Object.assign(row, data);
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const index = tables[name].findIndex((candidate) => candidate.id === where.id);
      return tables[name].splice(index, 1)[0];
    },
  });
  const insert = (name: (typeof names)[number], row: Record<string, unknown>) => {
    tables[name].push({ id: `r${(seq += 1)}`, ...row });
  };
  return { tables, table, insert, names };
});

vi.mock('@/lib/db', () => ({
  prisma: {
    sessionSlotBinding: db.table('bindings'),
    agentSlot: db.table('slots'),
    workAttempt: db.table('attempts'),
    agentSessionSpan: db.table('spans'),
    agentSessionEvent: db.table('events'),
    agentTrajectoryRecord: db.table('trajectory'),
  },
}));

import { claimLateSlotEvidence } from './late-slot-evidence';

const REPO = 'repo-1';
const SESSION = { agentTool: 'claude_code', sessionId: 'S1', subagentId: '' };
const BRANCH = 'main-7dfee-har-agent-1-kn75';
const WORK_DIR = '/w/main-7dfee-har-agent-1-kn75';
const OCC = 'attempt::a1';
const t = (seconds: number) => new Date(Date.UTC(2026, 10, 13, 16, 6, seconds));

const occupancy = { slotId: 1, occupancyKey: OCC, branch: BRANCH, workDir: WORK_DIR, since: t(32) };

beforeEach(() => {
  for (const name of db.names) db.tables[name].length = 0;
  db.insert('slots', {
    repositoryId: REPO,
    slotId: 1,
    active: true,
    occupancyKey: OCC,
    branch: BRANCH,
    workDir: WORK_DIR,
    worktreePath: null,
    suffix: 'kn75',
    workUnitId: 'HAR-E2E-1',
    attemptId: 'a1',
    sessionCreatedAt: t(32),
  });
  // The launch reached Mission Control; the edits that followed arrived first and
  // were stored as a non-slot worktree.
  db.insert('bindings', { repositoryId: REPO, ...SESSION, kind: 'launch', slotId: 1, occupancyKey: OCC, branch: BRANCH, at: t(33) });
  for (const second of [36, 37]) {
    db.insert('bindings', {
      repositoryId: REPO,
      ...SESSION,
      kind: 'observed',
      slotId: 0,
      occupancyKey: `worktree-branch:${BRANCH}`,
      branch: BRANCH,
      at: t(second),
    });
    db.insert('spans', { repositoryId: REPO, sessionKey: 'S1', agentTool: 'claude_code', agentId: 0, startTime: t(second) });
  }
});

describe('claimLateSlotEvidence', () => {
  it('moves worktree bindings onto the occupancy and re-places the session rows', async () => {
    db.insert('events', { repositoryId: REPO, sessionKey: 'S1', agentTool: 'claude_code', agentId: 0, timestamp: t(40) });
    db.insert('trajectory', { repositoryId: REPO, sessionKey: 'S1', agentTool: 'claude_code', agentId: 0, eventTimestamp: t(40) });

    expect(await claimLateSlotEvidence(REPO, occupancy)).toEqual({ bindings: 2, records: 4 });

    const observed = db.tables.bindings.filter((row) => row.kind === 'observed');
    expect(observed.map((row) => [row.slotId, row.occupancyKey])).toEqual([
      [1, OCC],
      [1, OCC],
    ]);
    expect(db.tables.spans.every((row) => row.agentId === 1 && row.workUnitId === 'HAR-E2E-1')).toBe(true);
    expect(db.tables.events[0]).toMatchObject({ agentId: 1, attemptId: 'a1' });
    expect(db.tables.trajectory[0]).toMatchObject({ agentId: 1, occupancyKey: OCC });
  });

  it('is a no-op the second time', async () => {
    await claimLateSlotEvidence(REPO, occupancy);
    expect(await claimLateSlotEvidence(REPO, occupancy)).toEqual({ bindings: 0, records: 0 });
  });

  it('drops the worktree copy when the same evidence is already on the slot', async () => {
    db.insert('bindings', { repositoryId: REPO, ...SESSION, kind: 'observed', slotId: 1, occupancyKey: OCC, branch: BRANCH, at: t(36) });

    await claimLateSlotEvidence(REPO, occupancy);

    const observed = db.tables.bindings.filter((row) => row.kind === 'observed');
    expect(observed).toHaveLength(2);
    expect(observed.every((row) => row.slotId === 1)).toBe(true);
  });

  it('leaves evidence from before the occupancy, of another worktree, or of the main checkout alone', async () => {
    db.insert('bindings', { repositoryId: REPO, ...SESSION, kind: 'observed', slotId: 0, occupancyKey: `worktree-branch:${BRANCH}`, branch: BRANCH, at: t(10) });
    db.insert('bindings', { repositoryId: REPO, ...SESSION, kind: 'observed', slotId: 0, occupancyKey: 'worktree-branch:other', branch: 'other', at: t(38) });
    db.insert('bindings', { repositoryId: REPO, ...SESSION, kind: 'workspace', slotId: 0, occupancyKey: 'worktree-branch:main', branch: 'main', at: t(39) });

    expect((await claimLateSlotEvidence(REPO, occupancy)).bindings).toBe(2);
    expect(db.tables.bindings.filter((row) => row.slotId === 0).map((row) => row.branch)).toEqual([BRANCH, 'other', 'main']);
  });

  it('matches a worktree named only by its path', async () => {
    db.tables.bindings.splice(1);
    db.insert('bindings', { repositoryId: REPO, ...SESSION, kind: 'workspace', slotId: 0, occupancyKey: `worktree:${WORK_DIR}`, branch: null, at: t(36) });

    expect((await claimLateSlotEvidence(REPO, occupancy)).bindings).toBe(1);
    expect(db.tables.bindings[1]).toMatchObject({ slotId: 1, occupancyKey: OCC, branch: BRANCH });
  });
});
