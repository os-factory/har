import { describe, expect, it, vi } from 'vitest';

const syncSessionBindings = vi.fn();
const listSessionBindings = vi.fn(async () => []);
vi.mock('@/server/session-attribution', () => ({
  syncSessionBindings: (...args: unknown[]) => syncSessionBindings(...args),
  listSessionBindings: (...args: unknown[]) => listSessionBindings(...(args as [])),
}));

import { GET, POST } from './route';

const params = { params: Promise.resolve({ id: 'repo-1' }) };

describe('/api/repos/[id]/session-bindings', () => {
  it('answers 400 with the validation error', async () => {
    syncSessionBindings.mockRejectedValueOnce(new Error('kind: Invalid enum value'));
    const response = await POST(
      new Request('http://localhost/x', { method: 'POST', body: JSON.stringify({ bindings: [{}] }) }),
      params,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'kind: Invalid enum value' });
  });

  it('narrows the list by session', async () => {
    await GET(new Request('http://localhost/x?agentTool=codex&sessionId=t-1'), params);
    expect(listSessionBindings).toHaveBeenCalledWith('repo-1', { agentTool: 'codex', sessionId: 't-1' });
  });
});
