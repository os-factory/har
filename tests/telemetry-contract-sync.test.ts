/**
 * Outward telemetry contracts — guards for the HAR 2.0 non-breaking rule (#416).
 *
 * HAR 2.0 adds standard OpenTelemetry and Factory Commits output. It must not
 * break what HQ, Mission Control and the otel-hook already consume:
 *
 *   - the HQ sync bodies (`/api/sync`, `/api/otel`, `/api/trajectory`),
 *   - the `OTEL_RESOURCE_ATTRIBUTES` HAR writes for agent sessions,
 *   - the otel-hook exporter endpoints and its pinned package.
 *
 * The assertions allow additions and fail on removals or renames: key sets are
 * "contains at least these keys", and exact equality is used only where a value
 * is itself the contract (an endpoint path, an encoding rule). If one of these
 * tests fails, a consumer will break — add the new shape alongside the old one
 * instead of editing the expectation.
 *
 * Payloads are built from on-disk fixtures by the real writers and the real
 * sync builders; only the network (fetch) and machine-level preferences are
 * stubbed.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('../src/core/control-registry', () => ({
  isRepoPortalSyncEnabled: () => true,
  recordRepoForControlSync: () => undefined,
  removeRegisteredRepo: () => undefined,
  listRegisteredRepos: () => [],
}));
jest.mock('../src/core/telemetry-config', () => ({
  isTelemetryEnabled: () => true,
  isPortalTrajectoryEnabled: () => true,
  getTelemetrySignals: () => ({ metrics: true, logs: true, prompts: true, traces: true }),
  getTelemetryLevel: () => 'full',
  signalsForLevel: () => ({ metrics: false, logs: false, prompts: false, traces: false }),
  readTelemetryPreference: () => ({
    enabled: true,
    signals: { metrics: true, logs: true, prompts: true, traces: true },
    portalTrajectory: true,
  }),
}));
// Never read the developer's own agent transcripts.
jest.mock('../src/core/usage-harvest', () => {
  const actual = jest.requireActual('../src/core/usage-harvest') as typeof import('../src/core/usage-harvest');
  return { ...actual, harvestUsageForSlot: jest.fn(() => []), harvestEventsForSlot: jest.fn(() => []) };
});

import { syncRepoWithControl } from '../src/core/control-sync';
import { createRun, finishRun } from '../src/core/runs';
import { recordValidation } from '../src/core/validations';
import { bindValidationToAttempt, createWorkAttempt, upsertWorkUnit } from '../src/core/work-units';
import { recordCommitBinding } from '../src/core/commit-bindings';

const PORTAL = 'https://portal.example.com';
const CONTROL = 'http://control.test';
const MC_REPO_ID = 'mc-repo-1';
const WORK_UNIT_ID = 'ISSUE-416';
const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION = 'main-abcd-har-agent-1-xy12';

const realFetch = global.fetch;
const tmpDirs: string[] = [];

type Captured = { url: string; method: string; body: Record<string, unknown> };

function expectKeys(value: unknown, keys: string[]): void {
  expect(value).toEqual(expect.any(Object));
  expect(Object.keys(value as Record<string, unknown>)).toEqual(expect.arrayContaining(keys));
}

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** A git checkout with a minimal `.har/` and one record of every kind the sync carries. */
function makeFixtureRepo(): string {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'har-contract-')));
  tmpDirs.push(repo);
  fs.mkdirSync(path.join(repo, '.har'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.har', 'manifest.json'),
    JSON.stringify({
      version: '1',
      profile: 'cli',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    }),
  );
  fs.writeFileSync(
    path.join(repo, '.har', 'stages.json'),
    JSON.stringify({
      version: '1',
      artifactsDir: 'artifacts',
      logsDir: 'logs',
      agentSlots: { min: 1, max: 1 },
      verificationStages: [],
      stages: [],
    }),
  );
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  git(repo, 'init -q -b main');
  git(repo, '-c user.email=t@example.com -c user.name=t add -A');
  git(repo, '-c user.email=t@example.com -c user.name=t commit -q -m init');
  git(repo, 'remote add origin https://github.com/example/fixture.git');

  upsertWorkUnit(repo, {
    workUnitId: WORK_UNIT_ID,
    source: 'github',
    sourceUrl: 'https://github.com/example/fixture/issues/416',
    title: 'Fixture work unit',
  });
  createWorkAttempt(repo, {
    attemptId: ATTEMPT_ID,
    workUnitId: WORK_UNIT_ID,
    agentId: 1,
    sessionKey: SESSION,
    workDir: repo,
    branch: 'main',
  });
  const run = createRun(
    { repoPath: repo, agentId: 1, workUnitId: WORK_UNIT_ID, attemptId: ATTEMPT_ID },
    { stageId: 'verify', kind: 'verify', agentId: 1 },
  );
  finishRun(repo, run.runId, { status: 'pass', durationMs: 5 });
  const validation = recordValidation({
    checkoutDir: repo,
    harnessRoot: repo,
    status: 'pass',
    full: true,
    runId: run.runId,
    agentId: 1,
  });
  bindValidationToAttempt(repo, { workUnitId: WORK_UNIT_ID, attemptId: ATTEMPT_ID, validation });
  recordCommitBinding({
    harnessRoot: repo,
    validationId: validation.validationId,
    treeHash: validation.treeHash,
    commitSha: git(repo, 'rev-parse HEAD'),
    message: 'init',
    runId: run.runId,
  });
  return repo;
}

/** What Mission Control serves for the repo: the rows the HQ sync forwards. */
function missionControlRows(repo: string): Record<string, unknown> {
  const at = '2026-09-01T10:00:00.000Z';
  return {
    '/api/repos': [{ id: MC_REPO_ID, path: repo }],
    [`/api/repos/${MC_REPO_ID}/usage`]: {
      usage: [
        {
          sessionKey: 'provider-session-1',
          agentId: 1,
          agentTool: 'claude_code',
          workDir: repo,
          branch: SESSION,
          suffix: 'xy12',
          occupancyKey: 'occ-1',
          workUnitId: WORK_UNIT_ID,
          attemptId: ATTEMPT_ID,
          tokensInput: 10,
          tokensOutput: 20,
          tokensCacheRead: 1,
          tokensCacheCreation: 2,
          tokensTotal: 33,
          costUsd: 0.01,
          modelBreakdown: { 'claude-x': { tokensInput: 10, tokensOutput: 20 } },
          sources: ['otel'],
          harvestVersion: 0,
          firstSeenAt: at,
          lastSeenAt: at,
          changedAt: at,
          origin: 'observations',
        },
      ],
      unassigned: [
        {
          agentTool: 'cursor',
          sessionId: 'provider-session-2',
          workDir: repo,
          branch: 'main',
          tokensInput: 1,
          tokensOutput: 1,
          tokensTotal: 2,
          costUsd: null,
          sources: ['otel'],
          firstSeenAt: at,
          lastSeenAt: at,
          changedAt: at,
        },
      ],
    },
    [`/api/repos/${MC_REPO_ID}/events`]: {
      events: [
        {
          id: 'ev-1',
          sessionKey: SESSION,
          agentId: 1,
          agentTool: 'claude_code',
          eventName: 'user_prompt',
          sequence: 1,
          timestamp: at,
          attributes: { 'har.session_key': SESSION },
          promptText: 'hello',
          responseText: null,
          rawTruncated: null,
          source: 'otel',
          workUnitId: WORK_UNIT_ID,
          attemptId: ATTEMPT_ID,
          createdAt: at,
        },
      ],
    },
    [`/api/repos/${MC_REPO_ID}/spans`]: {
      spans: [
        {
          id: 'sp-1',
          sessionKey: SESSION,
          agentId: 1,
          agentTool: 'claude_code',
          workUnitId: WORK_UNIT_ID,
          attemptId: ATTEMPT_ID,
          traceId: '0af7651916cd43dd8448eb211c80319c',
          spanId: 'b7ad6b7169203331',
          parentSpanId: '00f067aa0ba902b7',
          name: 'tool_call',
          startTime: at,
          endTime: at,
          attributes: { 'gen_ai.operation.name': 'execute_tool' },
          createdAt: at,
        },
      ],
    },
    [`/api/repos/${MC_REPO_ID}/trajectory`]: {
      records: [
        {
          id: 'tr-1',
          version: 1,
          source: 'otel',
          sourceEventId: 'evt-1',
          contentKey: 'prompt',
          sessionKey: SESSION,
          agentId: 1,
          agentTool: 'claude_code',
          eventType: 'user_prompt',
          sequence: 1,
          eventTimestamp: at,
          payload: { text: 'hello' },
          contentKind: 'prompt',
          contentDisclosure: 'full',
          traceId: '0af7651916cd43dd8448eb211c80319c',
          spanId: 'b7ad6b7169203331',
          workUnitId: WORK_UNIT_ID,
          attemptId: ATTEMPT_ID,
          createdAt: at,
        },
      ],
    },
  };
}

function mockNetwork(repo: string, captured: Captured[]): void {
  const rows = missionControlRows(repo);
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    captured.push({ url: String(url), method, body });
    const { pathname } = new URL(String(url));
    let json: unknown = {};
    if (String(url).startsWith(CONTROL) && method === 'GET' && pathname in rows) json = rows[pathname];
    else if (String(url).startsWith(CONTROL) && pathname === '/api/repos') json = { id: MC_REPO_ID };
    else if (String(url).startsWith(PORTAL)) json = { repositoryId: 'hq-repo-1' };
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => json,
      text: async () => JSON.stringify(json),
    } as unknown as Response;
  });
}

function hqBodies(captured: Captured[], endpoint: string): Record<string, unknown>[] {
  return captured
    .filter((c) => c.url === `${PORTAL}${endpoint}` && c.method === 'POST')
    .map((c) => c.body);
}

describe('HQ sync payload contract (#416)', () => {
  let repo: string;
  let captured: Captured[];

  beforeAll(async () => {
    process.env.HAR_PORTAL_URL = PORTAL;
    process.env.HAR_PORTAL_TOKEN = 'har_ingest_contract';
    process.env.HAR_PORTAL_SYNC_STATE_PATH = path.join(os.tmpdir(), `har-contract-state-${process.pid}.json`);
    process.env.HAR_PACKAGE_VERSION = '1.2.3';
    // Never read the developer's saved HQ login (it carries their email).
    process.env.HAR_CREDENTIALS_PATH = path.join(os.tmpdir(), `har-contract-creds-${process.pid}.json`);
    // The usage-invariant pre-check has its own suite; it holds nothing back here.
    process.env.HAR_SYNC_ALLOW_USAGE_VIOLATIONS = '1';
    repo = makeFixtureRepo();
    captured = [];
    mockNetwork(repo, captured);
    await syncRepoWithControl({ repoPath: repo, apiUrl: CONTROL, full: true });
  });

  afterAll(() => {
    (global as unknown as { fetch: unknown }).fetch = realFetch;
    fs.rmSync(process.env.HAR_PORTAL_SYNC_STATE_PATH as string, { force: true });
    delete process.env.HAR_PORTAL_URL;
    delete process.env.HAR_PORTAL_TOKEN;
    delete process.env.HAR_PORTAL_SYNC_STATE_PATH;
    delete process.env.HAR_PACKAGE_VERSION;
    delete process.env.HAR_CREDENTIALS_PATH;
    delete process.env.HAR_SYNC_ALLOW_USAGE_VIOLATIONS;
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sends exactly one omnibus /api/sync body plus /api/otel and /api/trajectory batches', () => {
    expect(hqBodies(captured, '/api/sync')).toHaveLength(1);
    expect(hqBodies(captured, '/api/otel')).toHaveLength(2);
    expect(hqBodies(captured, '/api/trajectory')).toHaveLength(1);
    for (const endpoint of ['/api/sync', '/api/otel', '/api/trajectory']) {
      for (const body of hqBodies(captured, endpoint)) expect(body.path).toBe(repo);
    }
  });

  it('/api/sync carries the top-level keys HQ reads', () => {
    const [body] = hqBodies(captured, '/api/sync');
    expectKeys(body, [
      'path',
      'cliVersion',
      'gitRemote',
      'manifest',
      'stagesRegistry',
      'slots',
      'generatedAt',
      'validations',
      'workUnits',
      'attempts',
      'validationBindings',
      'commitBindings',
      'usage',
      'runs',
    ]);
    expect(body.cliVersion).toBe('1.2.3');
    expect(body.gitRemote).toBe('https://github.com/example/fixture.git');
  });

  it('/api/sync record kinds keep their keys', () => {
    const [body] = hqBodies(captured, '/api/sync') as Array<Record<string, Array<Record<string, unknown>>>>;
    expectKeys(body.slots[0], ['agentId', 'active']);
    expectKeys(body.runs[0], [
      'runId',
      'repoPath',
      'harnessRoot',
      'stageId',
      'kind',
      'agentId',
      'status',
      'startedAt',
      'finishedAt',
      'durationMs',
      'trigger',
      'relativePath',
      'workUnitId',
      'attemptId',
    ]);
    expectKeys(body.validations[0], [
      'validationId',
      'treeHash',
      'headSha',
      'branch',
      'workDir',
      'harnessRoot',
      'agentId',
      'status',
      'full',
      'runId',
      'changedFiles',
      'createdAt',
      'updatedAt',
    ]);
    expectKeys(body.workUnits[0], [
      'version',
      'workUnitId',
      'source',
      'sourceUrl',
      'title',
      'createdAt',
      'updatedAt',
    ]);
    expectKeys(body.attempts[0], [
      'version',
      'attemptId',
      'workUnitId',
      'agentId',
      'sessionKey',
      'workDir',
      'branch',
      'createdAt',
    ]);
    expectKeys(body.validationBindings[0], [
      'bindingId',
      'workUnitId',
      'attemptId',
      'validationId',
      'treeHash',
      'createdAt',
    ]);
    expectKeys(body.commitBindings[0], [
      'bindingId',
      'validationId',
      'treeHash',
      'commitSha',
      'parents',
      'refs',
      'message',
      'runId',
      'createdAt',
    ]);
  });

  it('/api/sync usage rows keep their keys (slot and unassigned buckets)', () => {
    const [body] = hqBodies(captured, '/api/sync') as Array<Record<string, Array<Record<string, unknown>>>>;
    const counters = [
      'tokensInput',
      'tokensOutput',
      'tokensCacheRead',
      'tokensCacheCreation',
      'tokensTotal',
      'costUsd',
      'sources',
      'harvestVersion',
      'firstSeenAt',
      'lastSeenAt',
    ];
    const slot = body.usage.find((row) => row.agentId === 1);
    expectKeys(slot, [
      'sessionKey',
      'providerSessionId',
      'agentId',
      'agentTool',
      'workDir',
      'branch',
      'suffix',
      'occupancyKey',
      'workUnitId',
      'attemptId',
      'modelBreakdown',
      'models',
      ...counters,
    ]);
    // The bucket encoding in sessionKey is how HQ tells slot, worktree and main usage apart.
    expect(slot?.sessionKey).toBe('provider-session-1@1:occ-1');

    const unassigned = body.usage.find((row) => row.agentId === 0);
    expectKeys(unassigned, [
      'sessionKey',
      'providerSessionId',
      'agentId',
      'agentTool',
      'workDir',
      'branch',
      'workUnitId',
      'attemptId',
      ...counters,
    ]);
    expect(unassigned?.sessionKey).toBe('provider-session-2@wt:main');
  });

  it('/api/otel carries events and spans with their keys', () => {
    const bodies = hqBodies(captured, '/api/otel') as Array<Record<string, Array<Record<string, unknown>>>>;
    const events = bodies.find((body) => 'events' in body);
    const spans = bodies.find((body) => 'spans' in body);
    expectKeys(events, ['path', 'events']);
    expectKeys(events?.events[0], [
      'sessionKey',
      'agentId',
      'agentTool',
      'eventName',
      'sequence',
      'timestamp',
      'workUnitId',
      'attemptId',
      'attributes',
      'promptText',
      'source',
    ]);
    expectKeys(spans, ['path', 'spans']);
    expectKeys(spans?.spans[0], [
      'sessionKey',
      'agentId',
      'agentTool',
      'workUnitId',
      'attemptId',
      'traceId',
      'spanId',
      'parentSpanId',
      'name',
      'startTime',
      'endTime',
      'attributes',
    ]);
  });

  it('/api/trajectory carries canonical trajectory records with their keys', () => {
    const [body] = hqBodies(captured, '/api/trajectory') as Array<Record<string, Array<Record<string, unknown>>>>;
    expectKeys(body, ['path', 'records']);
    expectKeys(body.records[0], [
      'version',
      'source',
      'sourceEventId',
      'contentKey',
      'sessionKey',
      'agentId',
      'agentTool',
      'eventType',
      'sequence',
      'timestamp',
      'payload',
      'contentKind',
      'contentDisclosure',
      'traceId',
      'spanId',
      'workUnitId',
      'attemptId',
    ]);
    expect(body.records[0].version).toBe(1);
  });
});
