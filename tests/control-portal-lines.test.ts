import { syncRepoWithControl } from '../src/core/control-sync';

// Same isolation as control-portal-trajectory: collectors are stubbed so only
// the factory-line forwarding decisions are under test.
jest.mock('../src/core/portal-credentials', () => ({
  readPortalCredentials: jest.fn(() => null),
  writePortalCredentials: jest.fn(),
}));
jest.mock('../src/core/control-repo-path', () => ({
  canonicalizeControlRepoPath: (p: string) => p,
  listLinkedWorktrees: () => [],
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
  fetchPersistedPortalTelemetry: jest.fn(async () => ({
    usage: [],
    events: [],
    maxSyncedAt: null,
    failures: [],
    truncated: [],
  })),
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
  getTelemetrySignals: jest.fn(() => ({ metrics: true, logs: true, prompts: true, traces: true })),
  readTelemetryPreference: jest.fn(() => ({
    enabled: true,
    signals: { metrics: true, logs: true, prompts: true, traces: true },
    portalTrajectory: true,
  })),
}));
jest.mock('../src/harness/manifest', () => ({
  DEFAULT_HAR_DIR: '.har',
  getHarnessDir: (p: string) => `${p}/.har`,
  readManifest: () => null,
  resolveHarnessRoot: (p: string) => p,
}));
jest.mock('../src/harness/line-ledger', () => ({
  getLineLedgerPath: (p: string) => `${p}/.har/lines.json`,
  readLineLedger: jest.fn(() => null),
}));
jest.mock('../src/harness/lines', () => ({
  listInstalledLineIds: jest.fn(() => []),
  readInstalledLineProgram: jest.fn(() => null),
}));
jest.mock('../src/core/line-gates', () => ({ listLineGateRuns: jest.fn(() => []) }));
jest.mock('../src/harness/stages', () => ({ readStageRegistry: () => null }));

import { listInstalledLineIds, readInstalledLineProgram } from '../src/harness/lines';
import { readLineLedger } from '../src/harness/line-ledger';
import { listLineGateRuns } from '../src/core/line-gates';
import { fetchPersistedTrajectory } from '../src/core/control-persisted-trajectory';

const listInstalledLineIdsMock = listInstalledLineIds as jest.Mock;
const readInstalledLineProgramMock = readInstalledLineProgram as jest.Mock;
const readLineLedgerMock = readLineLedger as jest.Mock;
const listLineGateRunsMock = listLineGateRuns as jest.Mock;
const fetchPersistedTrajectoryMock = fetchPersistedTrajectory as jest.Mock;

const PROGRAM = {
  contractVersion: 1,
  id: 'example-line',
  title: 'Example factory line',
  stations: [{ id: 'S1', title: 'Draft' }],
  gate: { cumulative: true, optInEnv: null, stages: [] },
  handoff: { autonomousShip: false },
};

const GATE = {
  gateRunId: '6f1c2d4e-8a9b-4c3d-9e1f-2a3b4c5d6e7f',
  lineId: 'example-line',
  stationId: 'S1',
  repoPath: '/repo/x',
  stages: [],
  pass: true,
  skipped: false,
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:01.000Z',
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

function installLine(): void {
  listInstalledLineIdsMock.mockReturnValue(['example-line']);
  readInstalledLineProgramMock.mockReturnValue(PROGRAM);
  readLineLedgerMock.mockReturnValue({
    version: '1',
    lines: [
      {
        id: 'example-line',
        source: 'bundled',
        spec: 'example-line',
        stageIds: ['example-gate'],
        programPath: '.har/lines/example-line/line.json',
        installedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.HAR_PORTAL_URL = 'https://portal.example.com';
  process.env.HAR_PORTAL_TOKEN = 'har_ingest_secret';
  listInstalledLineIdsMock.mockReturnValue([]);
  readInstalledLineProgramMock.mockReturnValue(null);
  readLineLedgerMock.mockReturnValue(null);
  listLineGateRunsMock.mockReturnValue([]);
  fetchPersistedTrajectoryMock.mockResolvedValue({
    records: [],
    spans: [],
    recordsMaxSyncedAt: null,
    spansMaxSyncedAt: null,
    failures: [],
    truncated: [],
  });
});

afterEach(() => {
  delete process.env.HAR_PORTAL_URL;
  delete process.env.HAR_PORTAL_TOKEN;
});

describe('factory line forwarding', () => {
  it('posts installed lines and gate runs to /api/lines with the ingest token', async () => {
    installLine();
    listLineGateRunsMock.mockReturnValue([GATE]);
    const fetchMock = mockFetch();

    await syncRepoWithControl({ repoPath: '/repo/x' });

    const call = portalCall(fetchMock, '/api/lines');
    expect(call).toBeDefined();
    expect((call![1].headers as Record<string, string>).Authorization).toBe(
      'Bearer har_ingest_secret',
    );
    const body = bodyOf(call!);
    expect(body.path).toBe('/repo/x');
    expect(body.lines).toEqual([
      expect.objectContaining({
        id: 'example-line',
        title: 'Example factory line',
        source: 'bundled',
        stageIds: ['example-gate'],
        program: PROGRAM,
        programHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
    expect(body.gates).toEqual([GATE]);
  });

  it('sends nothing for a repo that never installed a line', async () => {
    const fetchMock = mockFetch();

    await syncRepoWithControl({ repoPath: '/repo/x' });

    expect(portalCall(fetchMock, '/api/lines')).toBeUndefined();
  });

  it('sends gate runs even when no line is installed any more', async () => {
    listLineGateRunsMock.mockReturnValue([GATE]);
    const fetchMock = mockFetch();

    await syncRepoWithControl({ repoPath: '/repo/x' });

    const body = bodyOf(portalCall(fetchMock, '/api/lines')!);
    expect(body.lines).toEqual([]);
    expect(body.gates).toEqual([GATE]);
  });

  it('skips quietly when the portal has no /api/lines endpoint', async () => {
    installLine();
    const fetchMock = mockFetch({ '/api/lines': 404 });

    await expect(syncRepoWithControl({ repoPath: '/repo/x' })).resolves.toEqual({
      warnings: [],
    });
    expect(portalCall(fetchMock, '/api/lines')).toBeDefined();
  });

  it('fails the sync on a real portal error', async () => {
    installLine();
    mockFetch({ '/api/lines': 500 });

    await expect(syncRepoWithControl({ repoPath: '/repo/x' })).rejects.toThrow(/HTTP 500/);
  });

  it('does not post on dry-run', async () => {
    installLine();
    const fetchMock = mockFetch();

    await syncRepoWithControl({ repoPath: '/repo/x', dryRun: true });

    expect(portalCall(fetchMock, '/api/lines')).toBeUndefined();
  });
});
