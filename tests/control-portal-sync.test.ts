import { getPortalTarget } from '../src/core/control-config';
import { syncRepoWithControl } from '../src/core/control-sync';

// Keep buildPortalSyncBody deterministic and filesystem-free: the data
// collectors are exercised by their own suites — here we only care that the
// portal push targets the right URL, sends the bearer token, and shapes the
// omnibus body from whatever the collectors return.
jest.mock('../src/core/portal-credentials', () => ({
  readPortalCredentials: jest.fn(() => null),
  writePortalCredentials: jest.fn(),
}));
jest.mock('../src/core/control-repo-path', () => ({
  canonicalizeControlRepoPath: (p: string) => p,
}));
jest.mock('../src/core/runs', () => ({ listRuns: jest.fn(() => []) }));
jest.mock('../src/core/slot-status', () => ({
  collectEnvironmentStatus: jest.fn(() => ({
    slots: [],
    generatedAt: '2026-01-01T00:00:00.000Z',
  })),
}));
jest.mock('../src/core/validations', () => ({ listValidations: jest.fn(() => []) }));
jest.mock('../src/core/work-units', () => ({
  listWorkUnits: jest.fn(() => []),
  listWorkAttempts: jest.fn(() => []),
  listValidationBindings: jest.fn(() => []),
}));
jest.mock('../src/core/usage-harvest', () => {
  const actual = jest.requireActual('../src/core/usage-harvest') as typeof import('../src/core/usage-harvest');
  return {
    ...actual,
    harvestUsageForSlot: jest.fn(() => []),
    harvestEventsForSlot: jest.fn(() => []),
  };
});
jest.mock('../src/core/control-persisted-usage', () => ({
  fetchPersistedPortalTelemetry: jest.fn(async () => ({ usage: [], events: [], maxSyncedAt: null })),
}));
jest.mock('../src/core/portal-watermark', () => ({
  ...jest.requireActual('../src/core/portal-watermark'),
  readPortalWatermark: jest.fn(() => null),
  writePortalWatermark: jest.fn(),
  readRunsWatermarkEntry: jest.fn(() => null),
  writeRunsWatermark: jest.fn(),
}));
jest.mock('../src/core/telemetry-config', () => ({ isTelemetryEnabled: () => true }));
jest.mock('../src/harness/manifest', () => ({
  readManifest: () => null,
  resolveHarnessRoot: (p: string) => p,
}));
jest.mock('../src/harness/stages', () => ({ readStageRegistry: () => null }));

import { collectEnvironmentStatus } from '../src/core/slot-status';
import { listRuns } from '../src/core/runs';
import { listValidations } from '../src/core/validations';
import {
  readPortalCredentials,
  writePortalCredentials,
} from '../src/core/portal-credentials';
import {
  listWorkUnits,
  listWorkAttempts,
  listValidationBindings,
} from '../src/core/work-units';
import { harvestUsageForSlot, harvestEventsForSlot } from '../src/core/usage-harvest';
import { fetchPersistedPortalTelemetry } from '../src/core/control-persisted-usage';
import { readPortalWatermark, writePortalWatermark } from '../src/core/portal-watermark';

const collectEnvironmentStatusMock = collectEnvironmentStatus as jest.Mock;
const listRunsMock = listRuns as jest.Mock;
const listValidationsMock = listValidations as jest.Mock;
const readPortalCredentialsMock = readPortalCredentials as jest.Mock;
const writePortalCredentialsMock = writePortalCredentials as jest.Mock;
const listWorkUnitsMock = listWorkUnits as jest.Mock;
const listWorkAttemptsMock = listWorkAttempts as jest.Mock;
const listValidationBindingsMock = listValidationBindings as jest.Mock;
const harvestUsageForSlotMock = harvestUsageForSlot as jest.Mock;
const harvestEventsForSlotMock = harvestEventsForSlot as jest.Mock;
const fetchPersistedPortalTelemetryMock = fetchPersistedPortalTelemetry as jest.Mock;
const readPortalWatermarkMock = readPortalWatermark as jest.Mock;
const writePortalWatermarkMock = writePortalWatermark as jest.Mock;

function resetPayloadMocks(): void {
  collectEnvironmentStatusMock.mockReturnValue({
    slots: [],
    generatedAt: '2026-01-01T00:00:00.000Z',
  });
  readPortalCredentialsMock.mockReturnValue(null);
  listRunsMock.mockReturnValue([]);
  listValidationsMock.mockReturnValue([]);
  listWorkUnitsMock.mockReturnValue([]);
  listWorkAttemptsMock.mockReturnValue([]);
  listValidationBindingsMock.mockReturnValue([]);
  harvestUsageForSlotMock.mockReturnValue([]);
  harvestEventsForSlotMock.mockReturnValue([]);
  fetchPersistedPortalTelemetryMock.mockResolvedValue({ usage: [], events: [], maxSyncedAt: null });
  readPortalWatermarkMock.mockReset();
  readPortalWatermarkMock.mockReturnValue(null);
  writePortalWatermarkMock.mockReset();
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

function portalSlot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: 1,
    active: true,
    harnessUsage: 'cli',
    ...overrides,
  };
}

function portalCalls(fetchMock: jest.Mock): [string, RequestInit][] {
  return fetchMock.mock.calls.filter(([url]) =>
    String(url).includes('portal.example.com'),
  ) as [string, RequestInit][];
}

function portalSyncCall(fetchMock: jest.Mock): [string, RequestInit] {
  const call = portalCalls(fetchMock).find(([url]) => url.endsWith('/api/sync'));
  if (!call) throw new Error('expected a portal /api/sync call');
  return call;
}

function portalOtelCall(fetchMock: jest.Mock): [string, RequestInit] {
  const call = portalCalls(fetchMock).find(([url]) => url.endsWith('/api/otel'));
  if (!call) throw new Error('expected a portal /api/otel call');
  return call;
}

function mockFetch(result: FetchResult): jest.Mock {
  const fn = jest.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (String(url).includes('portal.example.com')) {
      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        text: async () => result.body ?? '',
        json: async () => ({}),
      };
    }
    // Local Mission Control — keep sync tests deterministic.
    if (String(url).endsWith('/api/repos') && method === 'POST') {
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ id: 'local-repo-1' }),
      };
    }
    if (String(url).endsWith('/api/repos') && method === 'GET') {
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => [],
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({}),
    };
  });
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

    const portal = portalCalls(fetchMock);
    expect(portal).toHaveLength(1);
    const [url, init] = portal[0];
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

  it('syncs to local Mission Control before pushing to the portal', async () => {
    process.env.HAR_PORTAL_URL = 'https://portal.example.com';
    process.env.HAR_PORTAL_TOKEN = 'har_ingest_secret';
    const fetchMock = mockFetch({ status: 200 });

    await syncRepoWithControl({ repoPath: '/repo/x' });

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    const localRegisterIdx = urls.findIndex(
      (url) => url.endsWith('/api/repos') && !url.includes('portal.example.com'),
    );
    const portalSyncIdx = urls.findIndex((url) => url.includes('/api/sync'));
    expect(localRegisterIdx).toBeGreaterThanOrEqual(0);
    expect(portalSyncIdx).toBeGreaterThan(localRegisterIdx);
    expect(
      urls.some((url) => url.includes('/api/repos/local-repo-1/runs')),
    ).toBe(true);
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
        portalSlot({
          workDir: '/repo/x/wt-1',
          worktreePath: '/repo/x/wt-1',
          branch: 'feat/x',
          suffix: 'a',
          sessionCreatedAt: '2026-01-01T00:00:00.000Z',
          workUnitId: 'widget-123',
          attemptId: '00000000-0000-4000-8000-000000000002',
        }),
      ],
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    listWorkUnitsMock.mockReturnValue([
      {
        workUnitId: 'widget-123',
        source: 'github',
        title: 't',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    listWorkAttemptsMock.mockReturnValue([
      {
        attemptId: '00000000-0000-4000-8000-000000000002',
        workUnitId: 'widget-123',
        agentId: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    listValidationBindingsMock.mockReturnValue([
      {
        bindingId: '00000000-0000-4000-8000-000000000004',
        workUnitId: 'widget-123',
        attemptId: '00000000-0000-4000-8000-000000000002',
        validationId: '00000000-0000-4000-8000-000000000003',
        treeHash: 'a'.repeat(40),
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
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

    const portal = portalCalls(fetchMock);
    expect(portal).toHaveLength(1);
    const [url, init] = portal[0];
    expect(url).toBe('https://portal.example.com/api/sync');
    const body = JSON.parse(init.body as string);
    expect(body.workUnits).toHaveLength(1);
    expect(body.attempts).toHaveLength(1);
    expect(body.validationBindings).toHaveLength(1);
    expect(body.usage).toHaveLength(1);
    expect('userEmail' in body.usage[0]).toBe(false);
    expect(body.usage[0].workUnitId).toBe('widget-123');
    expect(body.usage[0].attemptId).toBe('00000000-0000-4000-8000-000000000002');
    expect(body.usage[0].sessionKey).toBe('feat/x');
    expect(body.usage[0].models).toEqual([
      {
        model: 'claude-opus-4-8',
        tokensInput: 60,
        tokensOutput: 40,
        tokensTotal: 100,
        costUsd: 0.0013,
      },
    ]);
    expect(body.usage[0].costUsd).toBe(0.0013);
  });

  it('pushes harvested events to /api/otel with the same bearer token', async () => {
    collectEnvironmentStatusMock.mockReturnValue({
      slots: [
        portalSlot({
          workDir: '/repo/x/wt-1',
          worktreePath: '/repo/x/wt-1',
          branch: 'feat/x',
          workUnitId: 'widget-123',
          attemptId: '00000000-0000-4000-8000-000000000002',
        }),
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

    expect(portalCalls(fetchMock)).toHaveLength(2);
    const [syncUrl] = portalSyncCall(fetchMock);
    const [otelUrl, otelInit] = portalOtelCall(fetchMock);
    expect(syncUrl).toBe('https://portal.example.com/api/sync');
    expect(otelUrl).toBe('https://portal.example.com/api/otel');
    expect((otelInit.headers as Record<string, string>).Authorization).toBe(
      'Bearer har_ingest_secret',
    );
    const otelBody = JSON.parse(otelInit.body as string);
    expect(otelBody.path).toBe('/repo/x');
    expect(otelBody.events).toHaveLength(1);
    expect(otelBody.events[0].workUnitId).toBe('widget-123');
    expect(otelBody.events[0].promptText).toBe('hi');
    expect('responseText' in otelBody.events[0]).toBe(false);
    expect('rawTruncated' in otelBody.events[0]).toBe(false);
    expect(Array.isArray(otelBody.spans)).toBe(true);
  });

  it('does not call /api/otel when there are no events', async () => {
    const fetchMock = mockFetch({ status: 200 });
    await syncRepoWithControl({ repoPath: '/repo/x' });
    expect(portalCalls(fetchMock)).toHaveLength(1);
    expect(portalSyncCall(fetchMock)[0]).toBe('https://portal.example.com/api/sync');
  });

  it('attributes usage to the authenticated login email from credentials', async () => {
    readPortalCredentialsMock.mockReturnValue({
      portalUrl: 'https://portal.example.com',
      token: 'har_ingest_secret',
      email: 'login@haulieros.io',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    collectEnvironmentStatusMock.mockReturnValue({
      slots: [portalSlot({ branch: 'feat/x' })],
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

    const [, init] = portalSyncCall(fetchMock);
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
      slots: [portalSlot({ branch: 'feat/x' })],
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

    const [, init] = portalSyncCall(fetchMock);
    const body = JSON.parse(init.body as string);
    expect('userEmail' in body.usage[0]).toBe(false);
  });

  it('attributes runs and validations to the authenticated login email', async () => {
    readPortalCredentialsMock.mockReturnValue({
      portalUrl: 'https://portal.example.com',
      token: 'har_ingest_secret',
      email: 'login@haulieros.io',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    listRunsMock.mockReturnValue([
      {
        runId: '11111111-1111-1111-1111-111111111111',
        repoPath: '/repo/x',
        stageId: 'verify',
        status: 'pass',
        trigger: 'cli',
        startedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    listValidationsMock.mockReturnValue([
      {
        validationId: '22222222-2222-2222-2222-222222222222',
        treeHash: 'a'.repeat(40),
        workDir: '/repo/x',
        harnessRoot: '/repo/x',
        status: 'pass',
        full: false,
        changedFiles: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const fetchMock = mockFetch({ status: 200 });

    await syncRepoWithControl({ repoPath: '/repo/x' });

    const [, init] = portalSyncCall(fetchMock);
    const body = JSON.parse(init.body as string);
    expect(body.runs[0].userEmail).toBe('login@haulieros.io');
    expect(body.validations[0].userEmail).toBe('login@haulieros.io');
  });

  it('leaves runs and validations unattributed when credentials carry no email', async () => {
    readPortalCredentialsMock.mockReturnValue({
      portalUrl: 'https://portal.example.com',
      token: 'har_ingest_secret',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    listRunsMock.mockReturnValue([
      {
        runId: '11111111-1111-1111-1111-111111111111',
        repoPath: '/repo/x',
        stageId: 'verify',
        status: 'pass',
        trigger: 'cli',
        startedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    listValidationsMock.mockReturnValue([
      {
        validationId: '22222222-2222-2222-2222-222222222222',
        treeHash: 'a'.repeat(40),
        workDir: '/repo/x',
        harnessRoot: '/repo/x',
        status: 'pass',
        full: false,
        changedFiles: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const fetchMock = mockFetch({ status: 200 });

    await syncRepoWithControl({ repoPath: '/repo/x' });

    const [, init] = portalSyncCall(fetchMock);
    const body = JSON.parse(init.body as string);
    expect('userEmail' in body.runs[0]).toBe(false);
    expect('userEmail' in body.validations[0]).toBe(false);
  });

  it('forwards Mission Control persisted usage when the slot is torn down', async () => {
    // No live slots — tokens only survive in the control DB.
    fetchPersistedPortalTelemetryMock.mockResolvedValue({
      usage: [
        {
          sessionKey: 'feat/gone',
          agentId: 2,
          agentTool: 'claude_code',
          tokensTotal: 4200,
          modelBreakdown: {
            'claude-opus-4-8': { tokensInput: 2000, tokensOutput: 2200, tokensTotal: 4200 },
          },
          sources: ['harvest'],
          firstSeenAt: '2026-01-01T00:00:00.000Z',
          lastSeenAt: '2026-01-02T00:00:00.000Z',
        },
      ],
      events: [],
    });
    const fetchMock = mockFetch({ status: 200 });

    await syncRepoWithControl({ repoPath: '/repo/x' });

    const [url, init] = portalSyncCall(fetchMock);
    expect(url).toBe('https://portal.example.com/api/sync');
    const body = JSON.parse(init.body as string);
    expect(body.usage).toHaveLength(1);
    expect(body.usage[0].sessionKey).toBe('feat/gone');
    expect(body.usage[0].tokensTotal).toBe(4200);
    expect(body.usage[0].models).toEqual([
      {
        model: 'claude-opus-4-8',
        tokensInput: 2000,
        tokensOutput: 2200,
        tokensTotal: 4200,
        costUsd: 0.065,
      },
    ]);
    expect(body.usage[0].costUsd).toBe(0.065);
  });

  it('prefers persisted otel usage over live harvest for the same session/tool', async () => {
    collectEnvironmentStatusMock.mockReturnValue({
      slots: [portalSlot({ branch: 'feat/x' })],
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    harvestUsageForSlotMock.mockReturnValue([
      {
        sessionKey: 'feat/x',
        agentId: 1,
        agentTool: 'claude_code',
        tokensTotal: 100,
        sources: ['harvest'],
        firstSeenAt: '2026-01-01T00:00:00.000Z',
        lastSeenAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    fetchPersistedPortalTelemetryMock.mockResolvedValue({
      usage: [
        {
          sessionKey: 'feat/x',
          agentId: 1,
          agentTool: 'claude_code',
          tokensTotal: 250,
          sources: ['otel'],
          firstSeenAt: '2026-01-01T00:00:00.000Z',
          lastSeenAt: '2026-01-03T00:00:00.000Z',
        },
      ],
      events: [],
    });
    const fetchMock = mockFetch({ status: 200 });

    await syncRepoWithControl({ repoPath: '/repo/x' });

    const [, init] = portalSyncCall(fetchMock);
    const body = JSON.parse(init.body as string);
    expect(body.usage).toHaveLength(1);
    expect(body.usage[0].tokensTotal).toBe(250);
    expect(body.usage[0].sources).toEqual(['otel']);
    expect(body.usage[0].lastSeenAt).toBe('2026-01-03T00:00:00.000Z');
  });

  it('forwards persisted events to /api/otel when the slot is torn down', async () => {
    fetchPersistedPortalTelemetryMock.mockResolvedValue({
      usage: [],
      events: [
        {
          sessionKey: 'feat/gone',
          agentId: 2,
          agentTool: 'claude_code',
          eventName: 'claude_code.user_prompt',
          sequence: 1,
          timestamp: '2026-01-01T00:00:00.000Z',
          promptText: 'persisted',
          responseText: null,
          rawTruncated: null,
          source: 'harvest',
        },
      ],
    });
    const fetchMock = mockFetch({ status: 200 });

    await syncRepoWithControl({ repoPath: '/repo/x' });

    expect(portalCalls(fetchMock)).toHaveLength(2);
    const [otelUrl, otelInit] = portalOtelCall(fetchMock);
    expect(otelUrl).toBe('https://portal.example.com/api/otel');
    const otelBody = JSON.parse(otelInit.body as string);
    expect(otelBody.events).toHaveLength(1);
    expect(otelBody.events[0].promptText).toBe('persisted');
    expect('responseText' in otelBody.events[0]).toBe(false);
  });

  it('forwards the git remote to /api/sync so the portal can group repos', async () => {
    collectEnvironmentStatusMock.mockReturnValue({
      slots: [],
      generatedAt: '2026-01-01T00:00:00.000Z',
      gitRemote: 'https://github.com/os-factory/har.git',
    });
    const fetchMock = mockFetch({ status: 200 });

    await syncRepoWithControl({ repoPath: '/repo/x' });

    const [, init] = portalSyncCall(fetchMock);
    const body = JSON.parse(init.body as string);
    expect(body.gitRemote).toBe('https://github.com/os-factory/har.git');
  });

  it('omits gitRemote when the repo has no origin remote', async () => {
    collectEnvironmentStatusMock.mockReturnValue({
      slots: [],
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    const fetchMock = mockFetch({ status: 200 });

    await syncRepoWithControl({ repoPath: '/repo/x' });

    const [, init] = portalSyncCall(fetchMock);
    const body = JSON.parse(init.body as string);
    expect('gitRemote' in body).toBe(false);
  });
});

describe('syncRepoWithControl — portal watermark', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    resetPayloadMocks();
    clearPortalEnv();
    process.env.HAR_PORTAL_URL = 'https://portal.example.com';
    process.env.HAR_PORTAL_TOKEN = 'har_ingest_x';
  });
  afterEach(() => {
    (global as unknown as { fetch: unknown }).fetch = realFetch;
  });
  afterAll(clearPortalEnv);

  it('passes the stored watermark as `since` and advances it to the max sent', async () => {
    readPortalWatermarkMock.mockReturnValue('2026-01-02T00:00:00.000Z');
    fetchPersistedPortalTelemetryMock.mockResolvedValue({
      usage: [],
      events: [],
      maxSyncedAt: '2026-01-09T00:00:00.000Z',
    });
    mockFetch({ status: 200 });

    await syncRepoWithControl({ repoPath: '/repo/x' });

    expect(fetchPersistedPortalTelemetryMock).toHaveBeenCalledWith('/repo/x', expect.any(String), {
      since: '2026-01-02T00:00:00.000Z',
    });
    expect(writePortalWatermarkMock).toHaveBeenCalledWith(
      '/repo/x',
      'https://portal.example.com',
      '2026-01-09T00:00:00.000Z',
    );
  });

  it('--full ignores the stored watermark (since=null) but still advances it', async () => {
    readPortalWatermarkMock.mockReturnValue('2026-01-02T00:00:00.000Z');
    fetchPersistedPortalTelemetryMock.mockResolvedValue({
      usage: [],
      events: [],
      maxSyncedAt: '2026-01-09T00:00:00.000Z',
    });
    mockFetch({ status: 200 });

    await syncRepoWithControl({ repoPath: '/repo/x', full: true });

    expect(fetchPersistedPortalTelemetryMock).toHaveBeenCalledWith('/repo/x', expect.any(String), {
      since: null,
    });
    expect(readPortalWatermarkMock).not.toHaveBeenCalled();
    expect(writePortalWatermarkMock).toHaveBeenCalledWith(
      '/repo/x',
      'https://portal.example.com',
      '2026-01-09T00:00:00.000Z',
    );
  });

  it('does not advance the watermark when nothing new was sent', async () => {
    readPortalWatermarkMock.mockReturnValue('2026-01-02T00:00:00.000Z');
    fetchPersistedPortalTelemetryMock.mockResolvedValue({ usage: [], events: [], maxSyncedAt: null });
    mockFetch({ status: 200 });

    await syncRepoWithControl({ repoPath: '/repo/x' });

    expect(writePortalWatermarkMock).not.toHaveBeenCalled();
  });

  it('does not advance the watermark on dry-run', async () => {
    fetchPersistedPortalTelemetryMock.mockResolvedValue({
      usage: [],
      events: [],
      maxSyncedAt: '2026-01-09T00:00:00.000Z',
    });
    mockFetch({ status: 200 });

    await syncRepoWithControl({ repoPath: '/repo/x', dryRun: true });

    expect(writePortalWatermarkMock).not.toHaveBeenCalled();
  });
});

describe('syncRepoWithControl — token refresh on 401', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    resetPayloadMocks();
    clearPortalEnv();
    writePortalCredentialsMock.mockReset();
  });
  afterEach(() => {
    (global as unknown as { fetch: unknown }).fetch = realFetch;
  });
  afterAll(clearPortalEnv);

  function storedCreds(overrides: Record<string, unknown> = {}): void {
    readPortalCredentialsMock.mockReturnValue({
      portalUrl: 'https://portal.example.com',
      token: 'har_ingest_old',
      createdAt: '2026-01-01T00:00:00.000Z',
      refreshToken: 'har_refresh_ok',
      ...overrides,
    });
  }

  function refreshFetch(opts: {
    syncStatuses: number[];
    refreshStatus: number;
    refreshBody?: Record<string, unknown>;
  }): jest.Mock {
    let syncCall = 0;
    const fn = jest.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.endsWith('/api/cli/refresh')) {
        const ok = opts.refreshStatus >= 200 && opts.refreshStatus < 300;
        return {
          ok,
          status: opts.refreshStatus,
          text: async () => '',
          json: async () => opts.refreshBody ?? {},
        };
      }
      if (u.includes('portal.example.com') && u.endsWith('/api/sync')) {
        const status = opts.syncStatuses[Math.min(syncCall, opts.syncStatuses.length - 1)];
        syncCall++;
        return {
          ok: status >= 200 && status < 300,
          status,
          text: async () => '',
          json: async () => ({}),
        };
      }
      if (u.endsWith('/api/repos') && method === 'POST') {
        return { ok: true, status: 200, text: async () => '', json: async () => ({ id: 'local-repo-1' }) };
      }
      return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
    });
    (global as unknown as { fetch: unknown }).fetch = fn;
    return fn;
  }

  function callsTo(fetchMock: jest.Mock, endpoint: string): [string, RequestInit][] {
    return fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith(endpoint),
    ) as [string, RequestInit][];
  }

  it('rotates the ingest token on 401 and retries the sync with it', async () => {
    storedCreds();
    const fetchMock = refreshFetch({
      syncStatuses: [401, 200],
      refreshStatus: 200,
      refreshBody: { token: 'har_ingest_new', expiresAt: '2026-02-01T00:00:00.000Z' },
    });

    await syncRepoWithControl({ repoPath: '/repo/x' });

    const refreshCalls = callsTo(fetchMock, '/api/cli/refresh');
    expect(refreshCalls).toHaveLength(1);
    expect((refreshCalls[0][1].headers as Record<string, string>).Authorization).toBe(
      'Bearer har_refresh_ok',
    );

    const syncCalls = callsTo(fetchMock, '/api/sync');
    expect(syncCalls).toHaveLength(2);
    expect((syncCalls[0][1].headers as Record<string, string>).Authorization).toBe(
      'Bearer har_ingest_old',
    );
    expect((syncCalls[1][1].headers as Record<string, string>).Authorization).toBe(
      'Bearer har_ingest_new',
    );

    expect(writePortalCredentialsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'har_ingest_new',
        expiresAt: '2026-02-01T00:00:00.000Z',
        refreshToken: 'har_refresh_ok',
      }),
    );
  });

  it('surfaces the 401 without refreshing when there is no refresh token', async () => {
    storedCreds({ refreshToken: undefined });
    const fetchMock = refreshFetch({ syncStatuses: [401], refreshStatus: 200 });

    await expect(syncRepoWithControl({ repoPath: '/repo/x' })).rejects.toThrow(
      /rejected the ingest token/,
    );
    expect(callsTo(fetchMock, '/api/cli/refresh')).toHaveLength(0);
    expect(writePortalCredentialsMock).not.toHaveBeenCalled();
  });

  it('surfaces the original 401 when the refresh itself is rejected', async () => {
    storedCreds();
    const fetchMock = refreshFetch({ syncStatuses: [401], refreshStatus: 401 });

    await expect(syncRepoWithControl({ repoPath: '/repo/x' })).rejects.toThrow(
      /rejected the ingest token/,
    );
    expect(callsTo(fetchMock, '/api/cli/refresh')).toHaveLength(1);
    expect(callsTo(fetchMock, '/api/sync')).toHaveLength(1);
    expect(writePortalCredentialsMock).not.toHaveBeenCalled();
  });
});
