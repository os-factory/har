import { getPortalTarget } from '../src/core/control-config';
import { syncRepoWithControl } from '../src/core/control-sync';

// Keep buildPortalSyncBody deterministic and filesystem-free: the data
// collectors are exercised by their own suites — here we only care that the
// portal push targets the right URL, sends the bearer token, and shapes the
// omnibus body from whatever the collectors return.
jest.mock('../src/core/portal-credentials', () => ({ readPortalCredentials: jest.fn(() => null) }));
jest.mock('../src/core/control-repo-path', () => ({
  canonicalizeControlRepoPath: (p: string) => p,
}));
jest.mock('../src/core/runs', () => ({ listRuns: () => [] }));
jest.mock('../src/core/slot-status', () => ({
  collectEnvironmentStatus: jest.fn(() => ({
    slots: [],
    generatedAt: '2026-01-01T00:00:00.000Z',
  })),
}));
jest.mock('../src/core/validations', () => ({ listValidations: () => [] }));
jest.mock('../src/core/work-units', () => ({
  listWorkUnits: jest.fn(() => []),
  listWorkAttempts: jest.fn(() => []),
  listValidationBindings: jest.fn(() => []),
}));
jest.mock('../src/core/usage-harvest', () => ({
  harvestUsageForSlot: jest.fn(() => []),
  harvestEventsForSlot: jest.fn(() => []),
}));
jest.mock('../src/core/telemetry-config', () => ({ isTelemetryEnabled: () => true }));
jest.mock('../src/harness/manifest', () => ({
  readManifest: () => null,
  resolveHarnessRoot: (p: string) => p,
}));
jest.mock('../src/harness/stages', () => ({ readStageRegistry: () => null }));

import { collectEnvironmentStatus } from '../src/core/slot-status';
import { readPortalCredentials } from '../src/core/portal-credentials';
import {
  listWorkUnits,
  listWorkAttempts,
  listValidationBindings,
} from '../src/core/work-units';
import { harvestUsageForSlot, harvestEventsForSlot } from '../src/core/usage-harvest';

const collectEnvironmentStatusMock = collectEnvironmentStatus as jest.Mock;
const readPortalCredentialsMock = readPortalCredentials as jest.Mock;
const listWorkUnitsMock = listWorkUnits as jest.Mock;
const listWorkAttemptsMock = listWorkAttempts as jest.Mock;
const listValidationBindingsMock = listValidationBindings as jest.Mock;
const harvestUsageForSlotMock = harvestUsageForSlot as jest.Mock;
const harvestEventsForSlotMock = harvestEventsForSlot as jest.Mock;

function resetPayloadMocks(): void {
  collectEnvironmentStatusMock.mockReturnValue({
    slots: [],
    generatedAt: '2026-01-01T00:00:00.000Z',
  });
  readPortalCredentialsMock.mockReturnValue(null);
  listWorkUnitsMock.mockReturnValue([]);
  listWorkAttemptsMock.mockReturnValue([]);
  listValidationBindingsMock.mockReturnValue([]);
  harvestUsageForSlotMock.mockReturnValue([]);
  harvestEventsForSlotMock.mockReturnValue([]);
}

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

describe('syncRepoWithControl — portal full payload', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    clearPortalEnv();
    resetPayloadMocks();
    process.env.HAR_PORTAL_URL = 'https://portal.example.com';
    process.env.HAR_PORTAL_TOKEN = 'har_ingest_secret';
  });
  afterEach(() => {
    (global as unknown as { fetch: unknown }).fetch = realFetch;
    resetPayloadMocks();
  });
  afterAll(clearPortalEnv);

  it('forwards usage (with userEmail + models), work identity to /api/sync', async () => {
    collectEnvironmentStatusMock.mockReturnValue({
      slots: [
        {
          agentId: 1,
          workDir: '/repo/x/wt-1',
          worktreePath: '/repo/x/wt-1',
          branch: 'feat/x',
          suffix: 'a',
          sessionCreatedAt: '2026-01-01T00:00:00.000Z',
          workUnitId: 'WU-1',
          attemptId: 'AT-1',
        },
      ],
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    listWorkUnitsMock.mockReturnValue([{ workUnitId: 'WU-1', title: 't' }]);
    listWorkAttemptsMock.mockReturnValue([{ attemptId: 'AT-1', workUnitId: 'WU-1' }]);
    listValidationBindingsMock.mockReturnValue([{ bindingId: 'B-1' }]);
    harvestUsageForSlotMock.mockReturnValue([
      {
        sessionKey: '',
        agentId: 1,
        agentTool: 'claude_code',
        tokensTotal: 100,
        modelBreakdown: {
          'claude-opus-4-8': { tokensInput: 60, tokensOutput: 40, tokensTotal: 100 },
        },
        sources: ['harvest'],
        firstSeenAt: '2026-01-01T00:00:00.000Z',
        lastSeenAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const fetchMock = mockFetch({ status: 200 });

    await syncRepoWithControl({ repoPath: '/repo/x' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://portal.example.com/api/sync');
    const body = JSON.parse(init.body as string);
    expect(body.workUnits).toHaveLength(1);
    expect(body.attempts).toHaveLength(1);
    expect(body.validationBindings).toHaveLength(1);
    expect(body.usage).toHaveLength(1);
    expect('userEmail' in body.usage[0]).toBe(false);
    expect(body.usage[0].workUnitId).toBe('WU-1');
    expect(body.usage[0].attemptId).toBe('AT-1');
    expect(body.usage[0].sessionKey).toBe('feat/x');
    expect(body.usage[0].models).toEqual([
      { model: 'claude-opus-4-8', tokensInput: 60, tokensOutput: 40, tokensTotal: 100 },
    ]);
  });

  it('pushes harvested events to /api/otel with the same bearer token', async () => {
    collectEnvironmentStatusMock.mockReturnValue({
      slots: [
        {
          agentId: 1,
          workDir: '/repo/x/wt-1',
          worktreePath: '/repo/x/wt-1',
          branch: 'feat/x',
          workUnitId: 'WU-1',
          attemptId: 'AT-1',
        },
      ],
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    harvestEventsForSlotMock.mockReturnValue([
      {
        sessionKey: 'feat/x',
        agentId: 1,
        agentTool: 'claude_code',
        eventName: 'claude_code.user_prompt',
        sequence: 1,
        timestamp: '2026-01-01T00:00:00.000Z',
        promptText: 'hi',
        responseText: null,
        rawTruncated: null,
        source: 'harvest',
      },
    ]);
    const fetchMock = mockFetch({ status: 200 });

    await syncRepoWithControl({ repoPath: '/repo/x' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [syncUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [otelUrl, otelInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(syncUrl).toBe('https://portal.example.com/api/sync');
    expect(otelUrl).toBe('https://portal.example.com/api/otel');
    expect((otelInit.headers as Record<string, string>).Authorization).toBe(
      'Bearer har_ingest_secret',
    );
    const otelBody = JSON.parse(otelInit.body as string);
    expect(otelBody.path).toBe('/repo/x');
    expect(otelBody.events).toHaveLength(1);
    expect(otelBody.events[0].workUnitId).toBe('WU-1');
    expect(otelBody.events[0].promptText).toBe('hi');
    expect('responseText' in otelBody.events[0]).toBe(false);
    expect('rawTruncated' in otelBody.events[0]).toBe(false);
    expect(Array.isArray(otelBody.spans)).toBe(true);
  });

  it('does not call /api/otel when there are no events', async () => {
    const fetchMock = mockFetch({ status: 200 });
    await syncRepoWithControl({ repoPath: '/repo/x' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'https://portal.example.com/api/sync',
    );
  });

  it('attributes usage to the authenticated login email from credentials', async () => {
    readPortalCredentialsMock.mockReturnValue({
      portalUrl: 'https://portal.example.com',
      token: 'har_ingest_secret',
      email: 'login@haulieros.io',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    collectEnvironmentStatusMock.mockReturnValue({
      slots: [{ agentId: 1, branch: 'feat/x' }],
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    harvestUsageForSlotMock.mockReturnValue([
      {
        sessionKey: 'feat/x',
        agentId: 1,
        agentTool: 'claude_code',
        tokensTotal: 10,
        sources: ['harvest'],
        firstSeenAt: '2026-01-01T00:00:00.000Z',
        lastSeenAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const fetchMock = mockFetch({ status: 200 });

    await syncRepoWithControl({ repoPath: '/repo/x' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.usage[0].userEmail).toBe('login@haulieros.io');
  });

  it('leaves usage unattributed when credentials carry no email', async () => {
    readPortalCredentialsMock.mockReturnValue({
      portalUrl: 'https://portal.example.com',
      token: 'har_ingest_secret',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    collectEnvironmentStatusMock.mockReturnValue({
      slots: [{ agentId: 1, branch: 'feat/x' }],
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    harvestUsageForSlotMock.mockReturnValue([
      {
        sessionKey: 'feat/x',
        agentId: 1,
        agentTool: 'claude_code',
        tokensTotal: 10,
        sources: ['harvest'],
        firstSeenAt: '2026-01-01T00:00:00.000Z',
        lastSeenAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const fetchMock = mockFetch({ status: 200 });

    await syncRepoWithControl({ repoPath: '/repo/x' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect('userEmail' in body.usage[0]).toBe(false);
  });
});
