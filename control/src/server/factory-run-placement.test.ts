import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ prisma: {} }));

import { placeFactoryRunsOfAttempt } from './factory-run-placement';

describe('placeFactoryRunsOfAttempt', () => {
  it('fills the occupancy, slot number and work dir of an attempt\'s factory runs, only where empty', async () => {
    const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
    const db = {
      attempt: { findUnique: async () => ({ agentId: 3, workDir: null, worktreePath: null }) },
      agentSlot: { findFirst: async () => ({ slotId: 3, workDir: '/wt/slot-3', worktreePath: '/wt/slot-3' }) },
      factoryRun: {
        updateMany: async (query: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          updates.push(query);
          return { count: 1 };
        },
      },
    };

    await placeFactoryRunsOfAttempt('att-1', db as never);

    expect(updates).toEqual([
      { where: { attemptId: 'att-1', occupancyKey: null }, data: { occupancyKey: 'attempt::att-1' } },
      { where: { attemptId: 'att-1', agentId: null }, data: { agentId: 3 } },
      { where: { attemptId: 'att-1', workDir: null }, data: { workDir: '/wt/slot-3' } },
    ]);
  });
});
