import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A slot's trajectory includes the session's lead-in from the main checkout:
 * the prompt that asked for the work, typed before `har env launch` made the
 * slot, is placed in the main checkout (ADR 0003) and must still open the
 * slot's trajectory.
 */

type Row = {
  id: string;
  repositoryId: string;
  sessionKey: string;
  agentTool: string;
  agentId: number;
  eventType: string;
  eventTimestamp: Date;
  sequence: number;
  source: string;
  sourceEventId: string;
  contentKey: string;
};

const store = vi.hoisted(() => ({ rows: [] as Row[] }));

type Where = Record<string, unknown>;

function matchesField(value: unknown, condition: unknown): boolean {
  if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
  if (condition === null || typeof condition !== 'object') return value === condition;
  const ops = condition as Record<string, unknown>;
  const cmp = (a: unknown, b: unknown) =>
    a instanceof Date && b instanceof Date ? a.getTime() - b.getTime() : (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
  for (const [op, operand] of Object.entries(ops)) {
    if (op === 'lt' && !(cmp(value, operand) < 0)) return false;
    if (op === 'gt' && !(cmp(value, operand) > 0)) return false;
    if (op === 'gte' && !(cmp(value, operand) >= 0)) return false;
    if (op === 'lte' && !(cmp(value, operand) <= 0)) return false;
    if (op === 'notIn' && (operand as unknown[]).includes(value)) return false;
    if (op === 'in' && !(operand as unknown[]).includes(value)) return false;
    if (op === 'contains' && !String(value).includes(String(operand))) return false;
  }
  return true;
}

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'AND') return (condition as Where[]).every((part) => matches(row, part));
    if (key === 'OR') return (condition as Where[]).some((part) => matches(row, part));
    return matchesField(row[key as keyof Row], condition);
  });
}

function sortRows(rows: Row[], orderBy: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>): Row[] {
  const fields = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((left, right) => {
    for (const field of fields) {
      const [key, direction] = Object.entries(field)[0];
      const a = left[key as keyof Row];
      const b = right[key as keyof Row];
      const diff = a instanceof Date && b instanceof Date ? a.getTime() - b.getTime() : a < b ? -1 : a > b ? 1 : 0;
      if (diff !== 0) return direction === 'asc' ? diff : -diff;
    }
    return 0;
  });
}

vi.mock('@/lib/db', () => ({
  prisma: {
    agentTrajectoryRecord: {
      findFirst: async ({ where, orderBy }: { where: Where; orderBy: Record<string, 'asc' | 'desc'> }) =>
        sortRows(store.rows.filter((row) => matches(row, where)), orderBy)[0] ?? null,
      findMany: async ({ where, orderBy, take }: { where: Where; orderBy: Array<Record<string, 'asc' | 'desc'>>; take?: number }) =>
        sortRows(store.rows.filter((row) => matches(row, where)), orderBy).slice(0, take),
    },
  },
}));
vi.mock('@/server/trajectory-projections', () => ({ projectTrajectoryRecord: async () => {} }));

import { listTrajectoryExport, listTrajectoryHistory } from './trajectory-ledger';

const SESSION = '507965e0-3f72-4695-a56d-df1ff267887b';
let seq = 0;

function row(agentId: number, eventType: string, at: string, sessionKey = SESSION): Row {
  seq += 1;
  return {
    id: `row-${seq}`,
    repositoryId: 'repo-1',
    sessionKey,
    agentTool: 'claude_code',
    agentId,
    eventType,
    eventTimestamp: new Date(at),
    sequence: seq,
    source: 'otel',
    sourceEventId: `event-${seq}`,
    contentKey: `content-${seq}`,
  };
}

const slot3 = { repositoryId: 'repo-1', agentId: 3, sessionKey: SESSION, agentTool: 'claude_code' };

describe('slot trajectory lead-in', () => {
  beforeEach(() => {
    seq = 0;
    store.rows = [];
  });

  it('opens the slot trajectory with the prompt typed before the launch', async () => {
    store.rows = [
      row(0, 'session.start', '2026-11-13T18:22:43Z'),
      row(0, 'prompt.submitted', '2026-11-13T18:22:49Z'),
      row(0, 'tool.start', '2026-11-13T18:22:50Z'), // `har env launch 3`
      row(3, 'tool.start', '2026-11-13T18:22:52Z'),
      row(3, 'tool.end', '2026-11-13T18:23:10Z'),
      row(3, 'generation.end', '2026-11-13T18:34:00Z'),
    ];

    const page = await listTrajectoryHistory(slot3);

    expect(page.records.map((record) => [record.agentId, record.eventType])).toEqual([
      [0, 'prompt.submitted'],
      [0, 'tool.start'],
      [3, 'tool.start'],
      [3, 'tool.end'],
      [3, 'generation.end'],
    ]);
  });

  it('starts at the last prompt, not at hours of earlier main-checkout work', async () => {
    store.rows = [
      row(0, 'prompt.submitted', '2026-11-13T09:00:00Z'),
      row(0, 'tool.start', '2026-11-13T09:05:00Z'),
      row(0, 'prompt.submitted', '2026-11-13T12:00:00Z'),
      row(0, 'tool.start', '2026-11-13T12:01:00Z'),
      row(3, 'tool.start', '2026-11-13T12:02:00Z'),
    ];

    const records = await listTrajectoryExport(slot3);

    expect(records.map((record) => record.eventTimestamp.toISOString())).toEqual([
      '2026-11-13T12:00:00.000Z',
      '2026-11-13T12:01:00.000Z',
      '2026-11-13T12:02:00.000Z',
    ]);
  });

  it('never reaches back into a slot the session worked in before', async () => {
    store.rows = [
      row(0, 'prompt.submitted', '2026-11-13T10:00:00Z'),
      row(2, 'tool.start', '2026-11-13T10:01:00Z'),
      row(0, 'tool.start', '2026-11-13T10:30:00Z'), // back in main, no new prompt
      row(3, 'tool.start', '2026-11-13T10:31:00Z'),
    ];

    const records = await listTrajectoryExport(slot3);

    expect(records.map((record) => [record.agentId, record.eventTimestamp.toISOString()])).toEqual([
      [0, '2026-11-13T10:30:00.000Z'],
      [3, '2026-11-13T10:31:00.000Z'],
    ]);
  });

  it('leaves out other sessions and main-checkout work after the slot started', async () => {
    store.rows = [
      row(0, 'prompt.submitted', '2026-11-13T18:00:00Z', 'other-session'),
      row(0, 'prompt.submitted', '2026-11-13T18:22:49Z'),
      row(3, 'tool.start', '2026-11-13T18:22:52Z'),
      row(0, 'tool.start', '2026-11-13T18:40:00Z'),
    ];

    const records = await listTrajectoryExport(slot3);

    expect(records.map((record) => [record.agentId, record.eventType])).toEqual([
      [0, 'prompt.submitted'],
      [3, 'tool.start'],
    ]);
    expect(records.every((record) => record.sessionKey === SESSION)).toBe(true);
  });

  it('reads the main checkout itself unchanged', async () => {
    store.rows = [
      row(0, 'prompt.submitted', '2026-11-13T18:22:49Z'),
      row(3, 'tool.start', '2026-11-13T18:22:52Z'),
    ];

    const records = await listTrajectoryExport({ ...slot3, agentId: 0 });

    expect(records.map((record) => record.agentId)).toEqual([0]);
  });

  it('pages back through the lead-in like any other record', async () => {
    store.rows = [
      row(0, 'prompt.submitted', '2026-11-13T18:22:49Z'),
      row(3, 'tool.start', '2026-11-13T18:22:52Z'),
      row(3, 'tool.end', '2026-11-13T18:23:00Z'),
    ];

    const latest = await listTrajectoryHistory(slot3, { limit: 2 });
    expect(latest.records.map((record) => record.eventType)).toEqual(['tool.start', 'tool.end']);
    expect(latest.hasMore).toBe(true);

    const older = await listTrajectoryHistory(slot3, { limit: 2, before: latest.nextBefore! });
    expect(older.records.map((record) => record.eventType)).toEqual(['prompt.submitted']);
    expect(older.hasMore).toBe(false);
  });
});
