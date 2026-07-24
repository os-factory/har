import { getPortalTarget } from '../src/core/control-config';
import { syncRepoWithControl } from '../src/core/control-sync';

// Keep buildPortalSyncBody deterministic and filesystem-free: the data
// collectors are exercised by their own suites — here we only care that the
// portal push targets the right URL, sends the bearer token, and shapes the
// omnibus body from whatever the collectors return.
jest.mock('../src/core/control-repo-path', () => ({
  canonicalizeControlRepoPath: (p: string) => p,
}));
jest.mock('../src/core/runs', () => ({ listRuns: () => [] }));
jest.mock('../src/core/slot-status', () => ({
  collectEnvironmentStatus: () => ({
    slots: [],
    generatedAt: '2026-01-01T00:00:00.000Z',
  }),
}));
jest.mock('../src/core/validations', () => ({ listValidations: () => [] }));
jest.mock('../src/harness/manifest', () => ({
  readManifest: () => null,
  resolveHarnessRoot: (p: string) => p,
}));
jest.mock('../src/harness/stages', () => ({ readStageRegistry: () => null }));

const PORTAL_ENV = [
  'HAR_PORTAL_URL',
  'HAR_PORTAL_TOKEN',
  'HAR_CLOUD_API_URL',
  'HAR_CLOUD_API_KEY',
] as const;

function clearPortalEnv(): void {
  for (const key of PORTAL_ENV) delete process.env[key];
}

type FetchResult = { status: number; body?: string };

function mockFetch(result: FetchResult): jest.Mock {
  const fn = jest.fn(async () => ({
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    text: async () => result.body ?? '',
    json: async () => ({}),
  }));
  (global as unknown as { fetch: unknown }).fetch = fn;
  return fn;
}

describe('getPortalTarget', () => {
  beforeEach(clearPortalEnv);
  afterAll(clearPortalEnv);

  it('prefers HAR_PORTAL_* over the legacy HAR_CLOUD_* alias', () => {
    process.env.HAR_PORTAL_URL = 'https://portal.example.com';
    process.env.HAR_PORTAL_TOKEN = 'har_ingest_new';
    process.env.HAR_CLOUD_API_URL = 'https://cloud.example.com';
    process.env.HAR_CLOUD_API_KEY = 'har_ingest_old';
    expect(getPortalTarget()).toEqual({
      url: 'https://portal.example.com',
      token: 'har_ingest_new',
    });
  });

  it('falls back to HAR_CLOUD_* when HAR_PORTAL_* is unset', () => {
    process.env.HAR_CLOUD_API_URL = 'https://cloud.example.com';
    process.env.HAR_CLOUD_API_KEY = 'har_ingest_old';
    expect(getPortalTarget()).toEqual({
      url: 'https://cloud.example.com',
      token: 'har_ingest_old',
    });
  });

  it('strips trailing slashes so `${url}/api/sync` is well-formed', () => {
    process.env.HAR_PORTAL_URL = 'https://portal.example.com/';
    process.env.HAR_PORTAL_TOKEN = 'har_ingest_x';
    expect(getPortalTarget()?.url).toBe('https://portal.example.com');
  });

  it('returns null when only one of URL/token is set (opt-in)', () => {
    process.env.HAR_PORTAL_URL = 'https://portal.example.com';
    expect(getPortalTarget()).toBeNull();
    clearPortalEnv();
    process.env.HAR_PORTAL_TOKEN = 'har_ingest_x';
    expect(getPortalTarget()).toBeNull();
  });
});

describe('syncRepoWithControl — portal push', () => {
  const realFetch = global.fetch;
  beforeEach(clearPortalEnv);
  afterEach(() => {
    (global as unknown as { fetch: unknown }).fetch = realFetch;
  });
  afterAll(clearPortalEnv);

  it('POSTs the omnibus body to /api/sync with a bearer token', async () => {
    process.env.HAR_PORTAL_URL = 'https://portal.example.com';
    process.env.HAR_PORTAL_TOKEN = 'har_ingest_secret';
    const fetchMock = mockFetch({ status: 200 });

    await syncRepoWithControl({ repoPath: '/repo/x' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://portal.example.com/api/sync');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer har_ingest_secret',
    );
    const body = JSON.parse(init.body as string);
    expect(body.path).toBe('/repo/x');
    expect(Array.isArray(body.runs)).toBe(true);
    expect(Array.isArray(body.slots)).toBe(true);
    expect(body.generatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('raises a token error on 401 (bad/revoked token)', async () => {
    process.env.HAR_PORTAL_URL = 'https://portal.example.com';
    process.env.HAR_PORTAL_TOKEN = 'har_ingest_bad';
    mockFetch({ status: 401 });
    await expect(syncRepoWithControl({ repoPath: '/repo/x' })).rejects.toThrow(
      /rejected the ingest token/,
    );
  });

  it('raises a generic error on other non-2xx responses', async () => {
    process.env.HAR_PORTAL_URL = 'https://portal.example.com';
    process.env.HAR_PORTAL_TOKEN = 'har_ingest_x';
    mockFetch({ status: 500, body: 'boom' });
    await expect(syncRepoWithControl({ repoPath: '/repo/x' })).rejects.toThrow(
      /har-portal sync failed: HTTP 500/,
    );
  });

  it('does not fetch on dryRun', async () => {
    process.env.HAR_PORTAL_URL = 'https://portal.example.com';
    process.env.HAR_PORTAL_TOKEN = 'har_ingest_x';
    const fetchMock = mockFetch({ status: 200 });
    await syncRepoWithControl({ repoPath: '/repo/x', dryRun: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws a clear error when --cloud is requested but nothing is configured', async () => {
    const fetchMock = mockFetch({ status: 200 });
    await expect(
      syncRepoWithControl({ repoPath: '/repo/x', cloud: true }),
    ).rejects.toThrow(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
