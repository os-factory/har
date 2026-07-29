import { fetchPersistedPortalTelemetry } from '../src/core/control-persisted-usage';

type Route = { status: number; json?: unknown };

function routedFetch(routes: Record<string, Route>): jest.Mock {
  const fn = jest.fn(async (url: string) => {
    const path = url.replace('http://localhost:3847', '');
    const route = routes[path] ?? { status: 404 };
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: async () => route.json ?? {},
      text: async () => '',
    };
  });
  (global as unknown as { fetch: unknown }).fetch = fn;
  return fn;
}

const API = 'http://localhost:3847';

describe('fetchPersistedPortalTelemetry', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    (global as unknown as { fetch: unknown }).fetch = realFetch;
  });

  it('returns empty when Mission Control does not know the repo', async () => {
    routedFetch({ '/api/repos': { status: 200, json: [{ id: 'r1', path: '/other/repo' }] } });
    const result = await fetchPersistedPortalTelemetry('/repo/x', API);
    expect(result).toEqual({ usage: [], events: [] });
  });

  it('returns empty (never throws) when the control API is unreachable', async () => {
    const fn = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    (global as unknown as { fetch: unknown }).fetch = fn;
    await expect(fetchPersistedPortalTelemetry('/repo/x', API)).resolves.toEqual({
      usage: [],
      events: [],
    });
  });

  it('resolves the repo id by path and normalizes persisted usage + events', async () => {
    const fetchMock = routedFetch({
      '/api/repos': { status: 200, json: [{ id: 'repo-1', path: '/repo/x' }] },
      '/api/repos/repo-1/usage': {
        status: 200,
        json: {
          usage: [
            {
              id: 'u1',
              repositoryId: 'repo-1',
              sessionKey: 'feat/gone',
              agentId: 2,
              agentTool: 'claude_code',
              workDir: null,
              branch: 'feat/gone',
              tokensInput: 2000,
              tokensOutput: 2200,
              tokensCacheRead: 0,
              tokensCacheCreation: 0,
              tokensTotal: 4200,
              costUsd: null,
              modelBreakdown: { 'claude-opus-4-8': { tokensTotal: 4200 } },
              sources: ['harvest', 99],
              firstSeenAt: '2026-01-01T00:00:00.000Z',
              lastSeenAt: '2026-01-02T00:00:00.000Z',
            },
          ],
        },
      },
      '/api/repos/repo-1/events': {
        status: 200,
        json: {
          events: [
            {
              id: 'e1',
              repositoryId: 'repo-1',
              sessionKey: 'feat/gone',
              agentId: 2,
              agentTool: 'claude_code',
              eventName: 'claude_code.user_prompt',
              sequence: 1,
              timestamp: '2026-01-01T00:00:00.000Z',
              promptText: 'hello',
              responseText: null,
              source: 'harvest',
            },
          ],
        },
      },
    });

    const result = await fetchPersistedPortalTelemetry('/repo/x', API);

    // Read is scoped to the resolved repo id.
    expect(fetchMock).toHaveBeenCalledWith(`${API}/api/repos/repo-1/usage`, expect.anything());

    expect(result.usage).toHaveLength(1);
    const row = result.usage[0];
    expect(row.sessionKey).toBe('feat/gone');
    expect(row.tokensTotal).toBe(4200);
    expect(row.branch).toBe('feat/gone');
    expect('workDir' in row).toBe(false); // null dropped
    expect(row.sources).toEqual(['harvest']); // non-string filtered out
    expect(row.costUsd).toBeNull();

    expect(result.events).toHaveLength(1);
    expect(result.events[0].sessionKey).toBe('feat/gone');
    expect(result.events[0].promptText).toBe('hello');
    expect(result.events[0].source).toBe('harvest');
  });
});
