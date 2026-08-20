import { syncRepoWithControl } from '../src/core/control-sync';

// Same isolation as control-portal-sync: the collectors have their own suites,
// so here only the trajectory/span forwarding decisions are under test.
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
jest.mock('../src/core/control-persisted-trajectory', () => ({
  fetchPersistedTrajectory: jest.fn(),
}));
jest.mock('../src/core/portal-watermark', () => ({
  ...jest.requireActual('../src/core/portal-watermark'),
  readPortalWatermark: jest.fn(() => null),
  writePortalWatermark: jest.fn(),
  readRunsWatermarkEntry: jest.fn(() => null),
  writeRunsWatermark: jest.fn(),
}));
jest.mock('../src/core/portal-targets', () => {
  const actual = jest.requireActual('../src/core/portal-targets') as typeof import('../src/core/portal-targets');
  return {
    ...actual,
    isPortalTrajectoryEnabledForTarget: jest.fn(() => true),
    updatePortalTargetTokens: jest.fn(),
  };
});
jest.mock('../src/core/telemetry-config', () => ({
  isTelemetryEnabled: jest.fn(() => true),
  isPortalTrajectoryEnabled: jest.fn(() => true),
  readTelemetryPreference: jest.fn(() => ({
    enabled: true,
    signals: { metrics: true, logs: true, prompts: true, traces: true },
    portalTrajectory: true,
  })),
}));
jest.mock('../src/harness/manifest', () => ({
  readManifest: () => null,
  resolveHarnessRoot: (p: string) => p,
}));
jest.mock('../src/harness/stages', () => ({ readStageRegistry: () => null }));

import { fetchPersistedTrajectory } from '../src/core/control-persisted-trajectory';
import { isPortalTrajectoryEnabledForTarget } from '../src/core/portal-targets';
import { isTelemetryEnabled } from '../src/core/telemetry-config';
import { readPortalWatermark, writePortalWatermark } from '../src/core/portal-watermark';

const fetchPersistedTrajectoryMock = fetchPersistedTrajectory as jest.Mock;
const isPortalTrajectoryEnabledForTargetMock = isPortalTrajectoryEnabledForTarget as jest.Mock;
const isTelemetryEnabledMock = isTelemetryEnabled as jest.Mock;
const readPortalWatermarkMock = readPortalWatermark as jest.Mock;
const writePortalWatermarkMock = writePortalWatermark as jest.Mock;

const RECORD = {
  version: 1 as const,
  source: 'otel' as const,
  sourceEventId: 'evt-1',
  contentKey: 'prompt',
  sessionKey: 'feat/x',
  agentId: 1,
  agentTool: 'claude_code' as const,
  eventType: 'claude_code.user_prompt',
  sequence: 7,
  timestamp: '2026-01-01T00:00:00.000Z',
  payload: { promptText: 'hi' },
  contentKind: 'prompt',
  contentDisclosure: 'truncated' as const,
  toolCallId: 'call-1',
};

const SPAN = {
  sessionKey: 'feat/x',
  agentId: 1,
  agentTool: 'claude_code',
  traceId: 'trace-1',
  spanId: 'span-1',
  name: 'tool.Read',
  startTime: '2026-01-01T00:00:00.000Z',
};

type EndpointStatus = Record<string, number>;

function mockFetch(statuses: EndpointStatus = {}): jest.Mock {
  const fn = jest.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    const method = init?.method ?? 'GET';
    if (target.includes('portal.example.com')) {
      const path = new URL(target).pathname;
      const status = statuses[path] ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => '',
        json: async () => ({}),
      };
    }
    if (target.endsWith('/api/repos') && method === 'POST') {
      return { ok: true, status: 200, text: async () => '', json: async () => ({ id: 'local-1' }) };
    }
    return { ok: true, status: 200, text: async () => '', json: async () => [] };
  });
  (global as unknown as { fetch: unknown }).fetch = fn;
  return fn;
}

function portalCall(fetchMock: jest.Mock, endpoint: string): [string, RequestInit] | undefined {
  return fetchMock.mock.calls.find(([url]) => String(url).endsWith(endpoint)) as
    | [string, RequestInit]
    | undefined;
}

function bodyOf(call: [string, RequestInit]): Record<string, unknown> {
  return JSON.parse(call[1].body as string);
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.HAR_PORTAL_URL = 'https://portal.example.com';
  process.env.HAR_PORTAL_TOKEN = 'har_ingest_secret';
  isTelemetryEnabledMock.mockReturnValue(true);
  isPortalTrajectoryEnabledForTargetMock.mockReturnValue(true);
  readPortalWatermarkMock.mockReturnValue(null);
  fetchPersistedTrajectoryMock.mockResolvedValue({
    records: [RECORD],
    spans: [SPAN],
    recordsMaxSyncedAt: '2026-01-02T00:00:00.000Z',
    spansMaxSyncedAt: '2026-01-03T00:00:00.000Z',
  });
});

afterEach(() => {
  delete process.env.HAR_PORTAL_URL;
  delete process.env.HAR_PORTAL_TOKEN;
});

describe('trajectory forwarding', () => {
  it('posts ledger records to /api/trajectory with the ingest token', async () => {
    const fetchMock = mockFetch();

    await syncRepoWithControl({ repoPath: '/repo/x' });

    const call = portalCall(fetchMock, '/api/trajectory');
    expect(call).toBeDefined();
    expect((call![1].headers as Record<string, string>).Authorization).toBe(
      'Bearer har_ingest_secret',
    );
    const body = bodyOf(call!);
    expect(body.path).toBe('/repo/x');
    expect(body.records).toHaveLength(1);
  });

  it('forwards contentDisclosure and the pairing id verbatim', async () => {
    const fetchMock = mockFetch();

    await syncRepoWithControl({ repoPath: '/repo/x' });

    const [record] = bodyOf(portalCall(fetchMock, '/api/trajectory')!).records as Record<
      string,
      unknown
    >[];
    expect(record.contentDisclosure).toBe('truncated');
    expect(record.toolCallId).toBe('call-1');
    expect(record.sequence).toBe(7);
  });

  it('sends spans on /api/otel instead of an empty array', async () => {
    const fetchMock = mockFetch();

    await syncRepoWithControl({ repoPath: '/repo/x' });

    const body = bodyOf(portalCall(fetchMock, '/api/otel')!);
    expect(body.spans).toHaveLength(1);
    expect((body.spans as Record<string, unknown>[])[0].spanId).toBe('span-1');
  });

  it('skips records but still sends spans when the opt-in is off', async () => {
    isPortalTrajectoryEnabledForTargetMock.mockReturnValue(false);
    fetchPersistedTrajectoryMock.mockResolvedValue({
      records: [],
      spans: [SPAN],
      recordsMaxSyncedAt: null,
      spansMaxSyncedAt: '2026-01-03T00:00:00.000Z',
    });
    const fetchMock = mockFetch();

    await syncRepoWithControl({ repoPath: '/repo/x' });

    expect(portalCall(fetchMock, '/api/trajectory')).toBeUndefined();
    expect(portalCall(fetchMock, '/api/otel')).toBeDefined();
    expect(fetchPersistedTrajectoryMock).toHaveBeenCalledWith(
      '/repo/x',
      expect.any(String),
      expect.objectContaining({ records: false }),
    );
  });

  it('sends nothing when telemetry is off and the opt-in is off', async () => {
    isTelemetryEnabledMock.mockReturnValue(false);
    isPortalTrajectoryEnabledForTargetMock.mockReturnValue(false);
    const fetchMock = mockFetch();

    await syncRepoWithControl({ repoPath: '/repo/x' });

    expect(fetchPersistedTrajectoryMock).not.toHaveBeenCalled();
    expect(portalCall(fetchMock, '/api/trajectory')).toBeUndefined();
  });

  it('advances each watermark independently', async () => {
    mockFetch();

    await syncRepoWithControl({ repoPath: '/repo/x' });

    expect(writePortalWatermarkMock).toHaveBeenCalledWith(
      '/repo/x',
      'trajectory:https://portal.example.com',
      '2026-01-02T00:00:00.000Z',
    );
    expect(writePortalWatermarkMock).toHaveBeenCalledWith(
      '/repo/x',
      'spans:https://portal.example.com',
      '2026-01-03T00:00:00.000Z',
    );
  });

  it('keeps the records watermark when the portal has no trajectory endpoint', async () => {
    const fetchMock = mockFetch({ '/api/trajectory': 404 });

    await expect(syncRepoWithControl({ repoPath: '/repo/x' })).resolves.toBeUndefined();

    expect(portalCall(fetchMock, '/api/trajectory')).toBeDefined();
    expect(writePortalWatermarkMock).not.toHaveBeenCalledWith(
      '/repo/x',
      'trajectory:https://portal.example.com',
      expect.anything(),
    );
    // Spans ride the pre-existing endpoint, so they are unaffected by the skew.
    expect(writePortalWatermarkMock).toHaveBeenCalledWith(
      '/repo/x',
      'spans:https://portal.example.com',
      '2026-01-03T00:00:00.000Z',
    );
  });

  it('still fails the sync on a real portal error', async () => {
    mockFetch({ '/api/trajectory': 500 });

    await expect(syncRepoWithControl({ repoPath: '/repo/x' })).rejects.toThrow(/HTTP 500/);
  });

  it('reads from the stored watermark unless --full', async () => {
    readPortalWatermarkMock.mockImplementation((_repo: string, target: string) =>
      target.startsWith('trajectory:') ? '2026-01-01T00:00:00.000Z' : null,
    );
    mockFetch();

    await syncRepoWithControl({ repoPath: '/repo/x' });
    expect(fetchPersistedTrajectoryMock).toHaveBeenCalledWith(
      '/repo/x',
      expect.any(String),
      expect.objectContaining({ records: { since: '2026-01-01T00:00:00.000Z' } }),
    );

    fetchPersistedTrajectoryMock.mockClear();
    await syncRepoWithControl({ repoPath: '/repo/x', full: true });
    expect(fetchPersistedTrajectoryMock).toHaveBeenCalledWith(
      '/repo/x',
      expect.any(String),
      expect.objectContaining({ records: { since: null } }),
    );
  });

  it('does not write watermarks on dry-run', async () => {
    mockFetch();

    await syncRepoWithControl({ repoPath: '/repo/x', dryRun: true });

    expect(writePortalWatermarkMock).not.toHaveBeenCalled();
  });
});
