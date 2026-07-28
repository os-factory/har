import { beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    agentSessionUsage: {
      findMany: (...args: unknown[]) => findMany(...args),
    },
  },
}));

import { listSessionUsageForRepo } from './usage';

describe('listSessionUsageForRepo', () => {
  beforeEach(() => findMany.mockReset());

  it('scopes the read to the repository id', async () => {
    findMany.mockResolvedValue([]);
    await listSessionUsageForRepo('repo-1');
    expect(findMany).toHaveBeenCalledWith({
      where: { repositoryId: 'repo-1' },
      orderBy: { lastSeenAt: 'desc' },
    });
  });

  it('coerces the JSON sources column back to a string[]', async () => {
    findMany.mockResolvedValue([
      {
        id: 'u1',
        repositoryId: 'repo-1',
        sessionKey: 'feat/gone',
        agentTool: 'claude_code',
        tokensTotal: 4200n,
        sources: ['harvest', 42, 'otel', null],
      },
    ]);
    const rows = await listSessionUsageForRepo('repo-1');
    expect(rows[0].sources).toEqual(['harvest', 'otel']);
  });
});
