import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isRepoPortalSyncEnabled, setRepoPortalSync } from '../src/core/control-registry';
import { describePortalSync, runPortalConnect } from '../src/core/portal-connect';
import {
  getActivePortalConnection,
  listAttachedRepos,
  writePortalConnectionTrajectoryPreference,
} from '../src/core/portal-targets';
import { writeTelemetryLevel } from '../src/core/telemetry-config';

const ENV_KEYS = [
  'HAR_PORTAL_URL',
  'HAR_PORTAL_TOKEN',
  'HAR_CREDENTIALS_PATH',
  'HAR_PORTAL_TARGETS_PATH',
  'HAR_CONTROL_REGISTRY_PATH',
  'HAR_TELEMETRY_CONFIG_PATH',
] as const;

let tmpDir: string;

const realFetch = global.fetch;
/** What portal-api's whoami answers per key; a key not listed gets 404, as from a portal without the check. */
let whoami: Record<string, { status: number; body?: unknown }>;
let whoamiCalls: string[];

beforeEach(() => {
  whoami = {};
  whoamiCalls = [];
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    whoamiCalls.push(String(url));
    const key = String((init?.headers as Record<string, string>).Authorization).replace('Bearer ', '');
    const answer = whoami[key] ?? { status: 404 };
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => answer.body ?? {},
    };
  });

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-connect-'));
  process.env.HAR_CREDENTIALS_PATH = path.join(tmpDir, 'credentials.json');
  process.env.HAR_PORTAL_TARGETS_PATH = path.join(tmpDir, 'portal-targets.json');
  process.env.HAR_CONTROL_REGISTRY_PATH = path.join(tmpDir, 'repos.json');
  process.env.HAR_TELEMETRY_CONFIG_PATH = path.join(tmpDir, 'telemetry.json');
  for (const key of ENV_KEYS) {
    if (key.endsWith('_PATH')) continue;
    delete process.env[key];
  }
});

afterEach(() => {
  (global as unknown as { fetch: unknown }).fetch = realFetch;
  for (const key of ENV_KEYS) delete process.env[key];
});

function makeRepo(name: string): string {
  const repoPath = path.join(tmpDir, name);
  fs.mkdirSync(repoPath, { recursive: true });
  return fs.realpathSync(repoPath);
}

describe('runPortalConnect', () => {
  it('saves an api-key connection and attaches the current repository', async () => {
    const repoPath = makeRepo('app');

    const result = await runPortalConnect({
      portalUrl: 'https://app.harhq.com',
      apiKey: 'har_ingest_test',
      repoPath,
    });

    expect(result.record.portalUrl).toBe('https://app.harhq.com');
    expect(result.record.token).toBe('har_ingest_test');
    expect(result.attachedRepo).toBe(repoPath);
    expect(result.replaced).toBeNull();
    expect(listAttachedRepos()).toEqual([repoPath]);
  });

  it('adds a second repository when reconnecting to the same org', async () => {
    const first = makeRepo('one');
    const second = makeRepo('two');

    const a = await runPortalConnect({ portalUrl: 'https://app.harhq.com', apiKey: 'shared', repoPath: first });
    const b = await runPortalConnect({ portalUrl: 'https://app.harhq.com', apiKey: 'shared', repoPath: second });

    expect(a.record.alias).toBe(b.record.alias);
    expect(b.replaced).toBeNull();
    expect(listAttachedRepos()).toEqual([first, second]);
  });

  it('replaces the connection and its repos when the key belongs to another org', async () => {
    const first = makeRepo('one');
    const second = makeRepo('two');

    await runPortalConnect({ portalUrl: 'https://app.harhq.com', apiKey: 'token-org-a', repoPath: first });
    const switched = await runPortalConnect({
      portalUrl: 'https://app.harhq.com',
      apiKey: 'token-org-b',
      repoPath: second,
    });

    expect(switched.replaced?.token).toBe('token-org-a');
    expect(switched.detachedRepos).toEqual([first]);
    expect(getActivePortalConnection()?.token).toBe('token-org-b');
    expect(listAttachedRepos()).toEqual([second]);
  });
});

describe('runPortalConnect with a key Kerno can check', () => {
  const org = { organizationId: 'org-1', organizationName: 'Acme', keyType: 'api_key' };

  it('asks portal-api who the key belongs to and saves that org, without a refresh token', async () => {
    whoami['sk-bf-live'] = { status: 200, body: org };

    const { record } = await runPortalConnect({
      portalUrl: 'https://portal.kerno.io',
      apiKey: 'sk-bf-live',
      repoPath: makeRepo('app'),
    });

    expect(whoamiCalls).toEqual(['https://api.kerno.io/api/har/ingest/whoami']);
    expect(record).toMatchObject({ workspaceId: 'org-1', workspaceName: 'Acme', token: 'sk-bf-live' });
    expect(record.refreshToken).toBeUndefined();
  });

  it('treats two keys of the same org as one connection', async () => {
    whoami['sk-bf-old'] = { status: 200, body: org };
    whoami['sk-bf-new'] = { status: 200, body: org };
    const first = makeRepo('one');
    const second = makeRepo('two');

    await runPortalConnect({ portalUrl: 'https://portal.kerno.io', apiKey: 'sk-bf-old', repoPath: first });
    const again = await runPortalConnect({ portalUrl: 'https://portal.kerno.io', apiKey: 'sk-bf-new', repoPath: second });

    expect(again.replaced).toBeNull();
    expect(getActivePortalConnection()?.token).toBe('sk-bf-new');
    expect(listAttachedRepos()).toEqual([first, second]);
  });

  it('keeps the repos of a key connected before Kerno could say whose it is', async () => {
    const first = makeRepo('one');
    const second = makeRepo('two');
    const before = await runPortalConnect({ portalUrl: 'https://portal.kerno.io', apiKey: 'sk-bf-live', repoPath: first });
    whoami['sk-bf-live'] = { status: 200, body: org };

    const after = await runPortalConnect({ portalUrl: 'https://portal.kerno.io', apiKey: 'sk-bf-live', repoPath: second });

    expect(before.record.workspaceId).toMatch(/^key:/);
    expect(after.record.workspaceId).toBe('org-1');
    expect(after.replaced).toBeNull();
    expect(after.detachedRepos).toEqual([]);
    expect(listAttachedRepos()).toEqual([first, second]);
  });

  it('saves nothing and attaches nothing when the key is rejected', async () => {
    whoami['sk-bf-revoked'] = { status: 401 };

    await expect(
      runPortalConnect({ portalUrl: 'https://portal.kerno.io', apiKey: 'sk-bf-revoked', repoPath: makeRepo('app') }),
    ).rejects.toThrow(/API key was rejected/);

    expect(getActivePortalConnection()).toBeNull();
    expect(listAttachedRepos()).toEqual([]);
  });

  it('fails instead of saving an unchecked key when portal-api is down', async () => {
    whoami['sk-bf-live'] = { status: 502 };

    await expect(
      runPortalConnect({ portalUrl: 'https://portal.kerno.io', apiKey: 'sk-bf-live', repoPath: makeRepo('app') }),
    ).rejects.toThrow(/Could not check the key/);

    expect(getActivePortalConnection()).toBeNull();
  });

  it('does not ask a portal that is not Kerno', async () => {
    const { record } = await runPortalConnect({
      portalUrl: 'https://har.example.com',
      apiKey: 'har_ingest_test',
      repoPath: makeRepo('app'),
    });

    expect(whoamiCalls).toEqual([]);
    expect(record.token).toBe('har_ingest_test');
  });
});

describe('connecting a repo that was kept local-only', () => {
  it('clears the opt-out, so an attached repo is never silently unsynced', async () => {
    const repoPath = makeRepo('ghost');
    setRepoPortalSync(repoPath, false);
    expect(isRepoPortalSyncEnabled(repoPath)).toBe(false);

    await runPortalConnect({ portalUrl: 'https://app.harhq.com', apiKey: 'k', repoPath });

    expect(isRepoPortalSyncEnabled(repoPath)).toBe(true);
    expect(describePortalSync().repos).toEqual([{ repoPath, sendsToHq: true }]);
  });

  it('reports an attached repo that is still opted out', async () => {
    const repoPath = makeRepo('later');
    await runPortalConnect({ portalUrl: 'https://app.harhq.com', apiKey: 'k', repoPath });
    setRepoPortalSync(repoPath, false);
    expect(describePortalSync().repos).toEqual([{ repoPath, sendsToHq: false }]);
  });
});

describe('what HQ receives', () => {
  it('follows the local level and the org trajectory setting', async () => {
    await runPortalConnect({ portalUrl: 'https://app.harhq.com', apiKey: 'k', repoPath: makeRepo('r') });

    writeTelemetryLevel('full');
    expect(describePortalSync().hqTrajectory).toBe('outline');
    writePortalConnectionTrajectoryPreference(true);
    expect(describePortalSync()).toMatchObject({
      telemetryLevel: 'full',
      trajectoryForwarding: true,
      hqTrajectory: 'full',
    });

    // Forwarding cannot send text the level never recorded.
    writeTelemetryLevel('outline');
    expect(describePortalSync().hqTrajectory).toBe('outline');
    writeTelemetryLevel('usage');
    expect(describePortalSync().hqTrajectory).toBe('usage');
    writeTelemetryLevel('off');
    expect(describePortalSync().hqTrajectory).toBe('none');
  });
});

