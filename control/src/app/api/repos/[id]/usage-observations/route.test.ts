import { describe, expect, it, vi } from 'vitest';

const listUsageObservations = vi.fn(async () => []);
vi.mock('@/server/session-attribution', () => ({
  syncUsageObservations: vi.fn(async () => ({ synced: 0, created: 0 })),
  listUsageObservations: (...args: unknown[]) => listUsageObservations(...(args as [])),
}));

import { GET } from './route';

const params = { params: Promise.resolve({ id: 'repo-1' }) };

describe('GET /api/repos/[id]/usage-observations', () => {
  it('rejects an unreadable since', async () => {
    const response = await GET(new Request('http://localhost/x?since=yesterday'), params);
    expect(response.status).toBe(400);
  });

  it('passes filters and clamps the limit', async () => {
    await GET(new Request('http://localhost/x?sessionId=S1&since=2026-11-12T00:00:00Z&limit=999999'), params);
    expect(listUsageObservations).toHaveBeenCalledWith(
      'repo-1',
      { sessionId: 'S1', since: new Date('2026-11-12T00:00:00Z') },
      5000,
    );
  });
});
