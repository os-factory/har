// What `har control sync` still sends to Mission Control in 2.0: its local
// endpoints outside the ingest contract (ADR 0005 section 7). Registering the
// repository and the live slot view — never a v1 record route.
jest.mock('../src/core/control-repo-path', () => ({
  canonicalizeControlRepoPath: (p: string) => p,
  listLinkedWorktrees: () => [],
}));
jest.mock('../src/core/runs', () => ({ listRuns: jest.fn(() => []) }));
jest.mock('../src/core/slot-status', () => ({
  collectEnvironmentStatus: () => ({ slots: [], generatedAt: '2026-01-01T00:00:00.000Z' }),
}));
jest.mock('../src/core/validations', () => ({ listValidations: () => [] }));
jest.mock('../src/core/work-units', () => ({
  listWorkUnits: () => [],
  listWorkAttempts: () => [],
  listValidationBindings: () => [],
}));
jest.mock('../src/harness/manifest', () => ({
  readManifest: () => null,
  resolveHarnessRoot: (p: string) => p,
}));
jest.mock('../src/harness/stages', () => ({ readStageRegistry: () => null }));

import { syncReposWithControl } from '../src/core/control-sync';
import { listRuns } from '../src/core/runs';
import type { RunRecord } from '../src/harness/schema';

const realFetch = global.fetch;
const mockedListRuns = listRuns as jest.MockedFunction<typeof listRuns>;

const run: RunRecord = {
  runId: '00000000-0000-4000-8000-000000000099',
  repoPath: '/repos/big',
  stageId: 'verify',
  status: 'pass',
  startedAt: '2026-02-01T00:00:00.000Z',
  finishedAt: '2026-02-01T00:00:05.000Z',
  trigger: 'cli',
};

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => '',
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  mockedListRuns.mockReturnValue([]);
  (global as unknown as { fetch: unknown }).fetch = realFetch;
});

describe('har control sync speaks only v2 (ADR 0005 section 7)', () => {
  it('registers the repository and posts its slots, and nothing else', async () => {
    // A run history on disk is not sent: runs reach receivers as v2 records.
    mockedListRuns.mockReturnValue([run]);
    const calls: string[] = [];
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${String(url)}`);
      if (String(url).endsWith('/api/repos') && method === 'POST') return jsonResponse({ id: 'local-repo-1' });
      return jsonResponse({});
    });

    const result = await syncReposWithControl({ repoPaths: ['/repos/big'], apiUrl: 'http://mc' });

    expect(result).toMatchObject({ synced: 1, failed: 0 });
    expect(calls).toEqual(['POST http://mc/api/repos', 'POST http://mc/api/repos/local-repo-1/slots']);
  });
});

describe('sync error surfacing', () => {
  it('reports the underlying undici cause instead of a bare "fetch failed"', async () => {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (String(url).endsWith('/api/repos') && method === 'POST') return jsonResponse({ id: 'local-repo-1' });
      if (String(url).endsWith('/slots') && method === 'POST') {
        // Mirror undici: a bare TypeError whose real reason hides in `cause`.
        const err = new TypeError('fetch failed');
        (err as { cause?: unknown }).cause = { code: 'UND_ERR_SOCKET', message: 'other side closed' };
        throw err;
      }
      return jsonResponse({});
    });

    const result = await syncReposWithControl({ repoPaths: ['/repos/big'] });
    expect(result.failed).toBe(1);
    const error = result.results[0].error ?? '';
    expect(error).toContain('UND_ERR_SOCKET');
    expect(error).toContain('other side closed');
    expect(error).toContain('/slots');
  });
});
