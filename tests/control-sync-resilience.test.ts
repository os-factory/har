// Sync must stay bounded and scoped: requests time out and stop at the sync's
// deadline, transient HQ errors are retried, unattended syncs only touch the
// saved selection, and unchanged observations are not re-posted.
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
import { fetchPersistedPortalTelemetry } from '../src/core/control-persisted-usage';
import { readPortalWatermark, writePortalWatermark } from '../src/core/portal-watermark';
import {
  recordSentObservations,
  unsentObservations,
} from '../src/core/observation-ledger';
import { runWithDeadline, SyncDeadlineError, syncFetch } from '../src/core/sync-request';
import {
  persistTranscriptIndex,
  readTranscriptRecords,
  resetTranscriptCache,
  transcriptWorkspaces,
} from '../src/core/usage-harvest/transcript-cache';

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
    expect(result).toEqual({ synced: 1, failed: 0 });
  });
});

describe('portal telemetry watermark', () => {
  it('holds at the last event read when the events read hit the page cap', async () => {
    process.env.HAR_CONTROL_READ_PAGE_SIZE = '1';
    let page = 0;
    setFetch(
      jest.fn(async (url: string) => {
        const target = String(url);
        if (target.endsWith('/api/repos')) return ok([{ id: 'r1', path: '/repo/x' }]);
        if (target.includes('/events')) {
          page += 1;
          const createdAt = new Date(Date.UTC(2026, 0, 1, 0, page)).toISOString();
          return ok({
            events: [
              {
                id: `e${page}`,
                sessionKey: 's',
                agentId: 1,
                agentTool: 'claude_code',
                eventName: 'x',
                sequence: page,
                timestamp: createdAt,
                createdAt,
              },
            ],
          });
        }
        // A live session's usage moved long after the events that were read.
        return ok({
          usage: [
            {
              sessionKey: 's',
              agentId: 1,
              agentTool: 'claude_code',
              firstSeenAt: '2026-01-01T00:00:00.000Z',
              lastSeenAt: '2026-06-01T00:00:00.000Z',
              updatedAt: '2026-06-01T00:00:00.000Z',
            },
          ],
        });
      }),
    );

    try {
      const result = await fetchPersistedPortalTelemetry('/repo/x', 'http://mc', { since: null });
      expect(result.truncated).toEqual(['events']);
      // 20 pages read: the watermark is the 20th event, not the usage's June stamp.
      expect(result.maxSyncedAt).toBe(new Date(Date.UTC(2026, 0, 1, 0, 20)).toISOString());
    } finally {
      delete process.env.HAR_CONTROL_READ_PAGE_SIZE;
    }
  });

  it('writes the state file atomically', () => {
    process.env.HAR_PORTAL_SYNC_STATE_PATH = path.join(tmp, 'state.json');
    try {
      writePortalWatermark('/repo/x', 'https://hq', '2026-01-01T00:00:00.000Z');
      expect(readPortalWatermark('/repo/x', 'https://hq')).toBe('2026-01-01T00:00:00.000Z');
      expect(fs.readdirSync(tmp)).toEqual(['state.json']);
    } finally {
      delete process.env.HAR_PORTAL_SYNC_STATE_PATH;
    }
  });
});

describe('observation ledger', () => {
  it('re-posts only new or changed observations, per Mission Control repo id', () => {
    const a = { observationKey: 'a', tokensInput: 1 };
    const b = { observationKey: 'b', tokensInput: 2 };
    recordSentObservations('http://mc', 'repo-1', [a, b], [a, b]);

    const bChanged = { ...b, tokensInput: 3 };
    const c = { observationKey: 'c', tokensInput: 4 };
    expect(unsentObservations('http://mc', 'repo-1', [a, bChanged, c])).toEqual([bChanged, c]);
    // A wiped Mission Control hands out a new repo id: everything goes again.
    expect(unsentObservations('http://mc', 'repo-2', [a, b])).toEqual([a, b]);
  });
});

describe('transcript cache', () => {
  beforeEach(() => {
    resetTranscriptCache();
    process.env.HAR_TRANSCRIPT_INDEX_PATH = path.join(tmp, 'index.json');
  });
  afterEach(() => {
    delete process.env.HAR_TRANSCRIPT_INDEX_PATH;
    resetTranscriptCache();
  });

  it('reuses the indexed workspaces across processes and re-reads a changed file', () => {
    const file = path.join(tmp, 'session.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ cwd: '/work/a' })}\n${JSON.stringify({ cwd: '/work/b' })}\n`);

    expect(transcriptWorkspaces(file).cwds).toEqual(['/work/a', '/work/b']);
    persistTranscriptIndex();

    // A new process answers from the index, not the transcript: mark the
    // indexed entry and see the mark come back.
    const indexFile = path.join(tmp, 'index.json');
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    index.files[file].cwds = ['/from/index'];
    fs.writeFileSync(indexFile, JSON.stringify(index));
    resetTranscriptCache();
    expect(transcriptWorkspaces(file).cwds).toEqual(['/from/index']);

    fs.appendFileSync(file, `${JSON.stringify({ cwd: '/work/c', working_directory: '/work/d' })}\n`);
    expect(transcriptWorkspaces(file)).toMatchObject({
      cwds: ['/work/a', '/work/b', '/work/c'],
      lastWorkspace: '/work/d',
    });
  });

  it('serves parsed records from memory until the file changes', () => {
    const file = path.join(tmp, 'session.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ n: 1 })}\n`);
    const first = readTranscriptRecords(file);
    expect(readTranscriptRecords(file)).toBe(first);

    fs.appendFileSync(file, `${JSON.stringify({ n: 2 })}\n`);
    expect(readTranscriptRecords(file)).toEqual([{ n: 1 }, { n: 2 }]);
  });
});
