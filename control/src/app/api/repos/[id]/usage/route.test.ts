import { beforeEach, describe, expect, it, vi } from 'vitest';

const syncUsage = vi.fn(async (_id: string, rows: unknown[]) => ({ synced: rows.length }));
vi.mock('@/server/usage', () => ({ syncUsage: (id: string, rows: unknown[]) => syncUsage(id, rows) }));
vi.mock('@/server/session-attribution', () => ({ loadUsageView: vi.fn() }));

import { POST } from './route';

const params = { params: Promise.resolve({ id: 'repo-1' }) };
const row = (agentId: number) => ({
  sessionKey: `s-${agentId}`,
  agentId,
  agentTool: 'claude_code',
  firstSeenAt: '2026-11-12T10:00:00.000Z',
  lastSeenAt: '2026-11-12T10:00:00.000Z',
});

function post(body: unknown) {
  return POST(new Request('http://localhost/api/repos/repo-1/usage', { method: 'POST', body: JSON.stringify(body) }), params);
}

describe('POST /api/repos/[id]/usage', () => {
  beforeEach(() => {
    syncUsage.mockClear();
  });

  it('skips session totals placed in the main checkout instead of rejecting the batch', async () => {
    const response = await post({ usage: [row(2), row(0)] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ synced: 1, skipped: 1 });
    expect(syncUsage.mock.calls[0][1]).toHaveLength(1);
  });

  it('still rejects an invalid row', async () => {
    const response = await post({ usage: [{ ...row(2), agentId: -1 }] });
    expect(response.status).toBe(400);
  });
});
