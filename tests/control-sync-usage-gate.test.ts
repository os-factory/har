jest.mock('../src/core/control-repo-path', () => ({
  canonicalizeControlRepoPath: (p: string) => p,
  listLinkedWorktrees: () => [],
}));
jest.mock('../src/core/portal-credentials', () => ({ readPortalCredentials: jest.fn(() => null) }));
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
jest.mock('../src/core/usage-harvest', () => ({
  harvestUsageForSlot: () => [],
  harvestEventsForSlot: () => [],
  omitHarvestWhenOtelPresent: (rows: unknown[]) => rows,
  omitHarvestEventsWhenOtelPresent: (rows: unknown[]) => rows,
}));
jest.mock('../src/core/session-attribution-sync', () => ({
  collectSessionAttribution: () => ({ bindings: [], observations: [] }),
  parseRemoteSessionBindings: () => [],
}));
jest.mock('../src/core/telemetry-config', () => ({
  isTelemetryEnabled: () => true,
  getTelemetrySignals: () => ({ prompts: true }),
  isPortalTrajectoryEnabled: () => false,
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
import { syncReposWithControl } from '../src/core/control-sync';
import { listRuns } from '../src/core/runs';
import type { RunRecord } from '../src/harness/schema';

const realFetch = global.fetch;
const mockedListRuns = listRuns as jest.MockedFunction<typeof listRuns>;

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

/**
 * The HQ sync leaves the sessions whose usage breaks a blocking invariant
 * (FE-2058) out of the post and sends the rest of the repository; it goes
 * on unchanged when Mission Control cannot check (an older version).
 */
const REPO = '/repos/gated';
const REPO_ID = 'local-repo-1';
const BAD = '11111111-1111-4111-8111-111111111111';
const GOOD = '22222222-2222-4222-8222-222222222222';
const AT = '2026-11-12T10:00:00.000Z';

function unassigned(sessionId: string, costUsd: number) {
  return {
    agentTool: 'claude_code',
    sessionId,
    workDir: null,
    branch: null,
    tokensInput: 10,
    tokensOutput: 20,
    tokensCacheRead: 970,
    tokensCacheCreation: 0,
    tokensTotal: 1_000,
    costUsd,
    itemized: true,
    firstSeenAt: AT,
    lastSeenAt: AT,
    changedAt: AT,
  };
}

function report(blocked: string[]) {
  return {
    ok: blocked.length === 0,
    checked: { repositories: 2, observations: 2, rows: 2 },
    summary: [],
    repositories: [
      { id: REPO_ID, path: REPO },
      { id: 'other', path: '/repos/other' },
    ],
    violations: [],
    blockedUnits: blocked.map((sessionId) => ({
      repositoryId: REPO_ID,
      agentTool: 'claude_code',
      key: sessionId,
      invariants: ['I1', 'I2'],
    })),
  };
}

describe('usage invariant gate before the HQ sync', () => {
  const calls: Array<{ call: string; body: Record<string, unknown> }> = [];
  let stateDir: string;
  let invariants: () => { status: number; body: unknown };
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    calls.length = 0;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-usage-gate-'));
    process.env.HAR_CONTROL_REGISTRY_PATH = path.join(stateDir, 'repos.json');
    process.env.HAR_PORTAL_SYNC_STATE_PATH = path.join(stateDir, 'state.json');
    process.env.HAR_PORTAL_URL = 'https://portal.example.com';
    process.env.HAR_PORTAL_TOKEN = 'har_ingest_test';
    fs.writeFileSync(process.env.HAR_CONTROL_REGISTRY_PATH, JSON.stringify({ repos: [REPO] }, null, 2));
    warnSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ call: `${method} ${url}`, body: init?.body ? JSON.parse(String(init.body)) : {} });
      if (String(url).includes('/api/usage/invariants')) {
        const { status, body } = invariants();
        return { ...jsonResponse(body), ok: status < 400, status };
      }
      if (String(url).endsWith(`/api/repos/${REPO_ID}/usage`)) {
        return jsonResponse({ usage: [], unassigned: [unassigned(BAD, 1.5), unassigned(GOOD, 0.25)] });
      }
      if (String(url).endsWith('/api/repos') && method === 'POST') return jsonResponse({ id: REPO_ID });
      if (String(url).endsWith('/api/repos') && method === 'GET') return jsonResponse([{ id: REPO_ID, path: REPO }]);
      return jsonResponse({});
    });
  });

  afterEach(() => {
    delete process.env.HAR_CONTROL_REGISTRY_PATH;
    delete process.env.HAR_PORTAL_SYNC_STATE_PATH;
    delete process.env.HAR_PORTAL_URL;
    delete process.env.HAR_PORTAL_TOKEN;
    delete process.env.HAR_SYNC_ALLOW_USAGE_VIOLATIONS;
    warnSpy.mockRestore();
    (global as unknown as { fetch: unknown }).fetch = realFetch;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const sentSessions = () =>
    calls
      .filter((c) => c.call === 'POST https://portal.example.com/api/sync' && Array.isArray(c.body.usage))
      .flatMap((c) => (c.body.usage as Array<{ providerSessionId?: string }>).map((r) => r.providerSessionId));
  const warnings = () => warnSpy.mock.calls.map((args) => String(args.join(' ')));

  it('leaves a session breaking I1/I2 out of the HQ post, sends the rest, and says what it held back', async () => {
    invariants = () => ({ status: 200, body: report([BAD]) });
    const result = await syncReposWithControl({ repoPaths: [REPO] });
    expect(result.failed).toBe(0);
    expect(sentSessions()).toEqual([GOOD]);
    expect(result.results[0].warnings?.join('\n')).toMatch(
      new RegExp(`held back 1 session\\(s\\) from HQ, \\$1\\.50.*${BAD} \\(I1/I2, 1\\.0k tokens, \\$1\\.50\\).*har control check-usage --repo /repos/gated`),
    );
    // The held session is offered again on the next sync: the watermark did not move.
    calls.length = 0;
    invariants = () => ({ status: 200, body: report([]) });
    await syncReposWithControl({ repoPaths: [REPO] });
    expect(sentSessions().sort()).toEqual([BAD, GOOD].sort());
  });

  it('sends everything when Mission Control predates the check, or when explicitly allowed', async () => {
    invariants = () => ({ status: 404, body: {} });
    await syncReposWithControl({ repoPaths: [REPO] });
    expect(sentSessions().sort()).toEqual([BAD, GOOD].sort());
    expect(warnings().some((w) => w.includes('Usage invariants not checked before the HQ sync'))).toBe(true);

    calls.length = 0;
    invariants = () => ({ status: 200, body: report([BAD]) });
    process.env.HAR_SYNC_ALLOW_USAGE_VIOLATIONS = '1';
    await syncReposWithControl({ repoPaths: [REPO], full: true });
    expect(sentSessions().sort()).toEqual([BAD, GOOD].sort());
  });
});
