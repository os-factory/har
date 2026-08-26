import { beforeEach, describe, expect, it, vi } from 'vitest';

const eventFindMany = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    agentSessionEvent: {
      findMany: (...args: unknown[]) => eventFindMany(...args),
    },
  },
}));

import { listSessionEventsForRepo } from './session-events';

describe('listSessionEventsForRepo', () => {
  beforeEach(() => eventFindMany.mockReset());

  it('reads oldest-first on createdAt so a caller can walk forward', async () => {
    eventFindMany.mockResolvedValue([]);
    await listSessionEventsForRepo('repo-1');
    expect(eventFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { repositoryId: 'repo-1' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 1_000,
      }),
    );
  });

  it('pages from the caller cursor', async () => {
    eventFindMany.mockResolvedValue([]);
    await listSessionEventsForRepo('repo-1', {
      since: '2026-01-01T00:00:00.000Z',
      sinceId: 'ev-9',
      limit: 2,
    });
    expect(eventFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          repositoryId: 'repo-1',
          OR: [
            { createdAt: { gt: new Date('2026-01-01T00:00:00.000Z') } },
            { createdAt: new Date('2026-01-01T00:00:00.000Z'), id: { gt: 'ev-9' } },
          ],
        },
        take: 2,
      }),
    );
  });

  it('caps an unbounded request', async () => {
    eventFindMany.mockResolvedValue([]);
    await listSessionEventsForRepo('repo-1', { limit: 999_999 });
    expect(eventFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 5_000 }));
  });
});
