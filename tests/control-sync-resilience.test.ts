// Sync must stay bounded and scoped: requests time out and stop at the sync's
// deadline, transient errors are retried, unattended syncs only touch the
// saved selection.
jest.mock('../src/core/control-repo-path', () => ({
  canonicalizeControlRepoPath: (p: string) => p,
  listLinkedWorktrees: () => [],
}));
jest.mock('../src/core/control-registry', () => ({
  ...jest.requireActual('../src/core/control-registry'),
  listRegisteredRepos: () => ['/repo/selected', '/repo/other'],
  isRepoPortalSyncEnabled: () => false,
}));
jest.mock('../src/core/portal-credentials', () => ({ readPortalCredentials: jest.fn(() => null) }));
jest.mock('../src/core/runs', () => ({ listRuns: () => [] }));
jest.mock('../src/core/slot-status', () => ({
  collectEnvironmentStatus: () => ({ slots: [], generatedAt: '2026-01-01T00:00:00.000Z' }),
}));
jest.mock('../src/core/validations', () => ({ listValidations: () => [] }));
jest.mock('../src/core/work-units', () => ({
  listWorkUnits: () => [],
  listWorkAttempts: () => [],
  listValidationBindings: () => [],
}));
jest.mock('../src/core/telemetry-config', () => ({
  isTelemetryEnabled: () => false,
  isPortalTrajectoryEnabled: () => false,
  getTelemetrySignals: () => ({ metrics: true, logs: true, prompts: true, traces: true }),
  readTelemetryPreference: () => ({ enabled: false, signals: {}, portalTrajectory: false }),
}));
jest.mock('../src/harness/manifest', () => ({
  readManifest: () => null,
  resolveHarnessRoot: (p: string) => p,
}));
jest.mock('../src/harness/stages', () => ({ readStageRegistry: () => null }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { syncAllKnownReposWithControl } from '../src/core/control-sync';
import { writeSyncSelection } from '../src/core/control-sync-selection';
import { runWithDeadline, SyncDeadlineError, syncFetch } from '../src/core/sync-request';

const realFetch = global.fetch;
let tmp: string;

function setFetch(fn: jest.Mock): jest.Mock {
  (global as unknown as { fetch: unknown }).fetch = fn;
  return fn;
}

function ok(json: unknown = {}): Partial<Response> {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async (): Promise<string> => '',
    json: async (): Promise<unknown> => json,
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-sync-resilience-'));
});
afterEach(() => {
  (global as unknown as { fetch: unknown }).fetch = realFetch;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('sync requests', () => {
  it('cancels the in-flight request at the deadline and starts no other', async () => {
    const started: string[] = [];
    setFetch(
      jest.fn((url: string, init?: RequestInit) => {
        started.push(url);
        return new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        });
      }),
    );

    const work = async () => {
      await syncFetch('http://mc/one').catch(() => undefined);
      await syncFetch('http://mc/two');
    };

    await expect(runWithDeadline(work, 50, 'control sync')).rejects.toBeInstanceOf(
      SyncDeadlineError,
    );
    // Let the cancelled work settle: it must not reach the second request.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toEqual(['http://mc/one']);
  });

  it('times out a request that never answers', async () => {
    setFetch(
      jest.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    );
    await expect(syncFetch('http://hq/sync', {}, 30)).rejects.toThrow(
      'request timed out after 30ms',
    );
  });
});

describe('unattended all-repos sync', () => {
  it('only touches the repos in the saved sync selection', async () => {
    writeSyncSelection(['/repo/selected']);
    const fetchMock = setFetch(
      jest.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/api/repos') && init?.method === 'POST') {
          return ok({ id: `id-${JSON.parse(String(init.body)).path}` });
        }
        return ok([]);
      }),
    );

    const result = await syncAllKnownReposWithControl({ apiUrl: 'http://mc' });

    const registered = fetchMock.mock.calls
      .filter(([url, init]) => String(url).endsWith('/api/repos') && init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init.body)).path);
    expect(registered).toEqual(['/repo/selected']);
    expect(result).toEqual({ synced: 1, failed: 0, repoPaths: ['/repo/selected'] });
  });
});
