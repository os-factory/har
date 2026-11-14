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

beforeEach(() => {
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

