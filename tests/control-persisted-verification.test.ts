import { fetchPersistedVerificationRuns, toPortalVerificationRun } from '../src/core/control-persisted-verification';

const CONTROL = 'http://control.test';
const REPO = '/home/dev/acme/app';
const realFetch = global.fetch;

function respond(routes: Record<string, { status: number; json: unknown }>) {
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
    const { pathname } = new URL(String(url));
    const route = routes[pathname] ?? { status: 404, json: {} };
    return new Response(JSON.stringify(route.json), { status: route.status });
  });
}

function row(id: string, createdAt: string) {
  return {
    id,
    runId: `validation-${id}`,
    traceId: 'd3209ae49e3ad07b6bb0ba4414331613',
    spanId: '1111111111111111',
    pipelineName: 'har verify',
    result: 'success',
    verdict: null,
    startTime: createdAt,
    endTime: null,
    createdAt,
    stages: [{ name: 'build', spanId: '2222222222222222', result: 'success', taskType: null, startTime: createdAt }],
  };
}

describe('fetchPersistedVerificationRuns', () => {
  afterEach(() => {
    (global as unknown as { fetch: unknown }).fetch = realFetch;
  });

  it('returns the rows after the watermark and the new watermark', async () => {
    respond({
      '/api/repos': { status: 200, json: [{ id: 'r1', path: REPO }] },
      '/api/repos/r1/verification-runs': {
        status: 200,
        json: { verificationRuns: [row('a', '2026-11-23T10:00:00.000Z'), row('b', '2026-11-23T11:00:00.000Z')] },
      },
    });
    const result = await fetchPersistedVerificationRuns(REPO, CONTROL, '2026-11-23T10:00:00.000Z');
    expect(result.runs.map((run) => run.runId)).toEqual(['validation-b']);
    expect(result.maxSyncedAt).toBe('2026-11-23T11:00:00.000Z');
    expect(result.failures).toEqual([]);
    // Nulls are left out, never sent as null.
    expect(result.runs[0]).not.toHaveProperty('verdict');
    expect(result.runs[0].stages[0]).not.toHaveProperty('taskType');
  });

  it('a Mission Control without the endpoint is not a failure', async () => {
    respond({ '/api/repos': { status: 200, json: [{ id: 'r1', path: REPO }] } });
    expect(await fetchPersistedVerificationRuns(REPO, CONTROL, null)).toEqual({
      runs: [],
      maxSyncedAt: null,
      failures: [],
      truncated: [],
    });
  });

  it('a read error holds the watermark', async () => {
    respond({
      '/api/repos': { status: 200, json: [{ id: 'r1', path: REPO }] },
      '/api/repos/r1/verification-runs': { status: 400, json: {} },
    });
    const result = await fetchPersistedVerificationRuns(REPO, CONTROL, null);
    expect(result.failures).toEqual([{ channel: 'verification-runs', reason: 'HTTP 400' }]);
    expect(result.maxSyncedAt).toBeNull();
  });

  it('skips malformed rows', () => {
    expect(toPortalVerificationRun({ runId: 'x' })).toBeNull();
  });
});
