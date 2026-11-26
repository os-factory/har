import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { describeHqStatus, runPortalConnect } from '../src/core/portal-connect';
import {
  getActivePortalConnection,
  listAttachedRepos,
} from '../src/core/portal-targets';
import { writeTelemetryLevel } from '../src/core/telemetry-config';

const ENV_KEYS = [
  'HAR_PORTAL_URL',
  'HAR_PORTAL_TOKEN',
  'HAR_CREDENTIALS_PATH',
  'HAR_PORTAL_TARGETS_PATH',
  'HAR_CONTROL_REGISTRY_PATH',
  'HAR_TELEMETRY_CONFIG_PATH',
  // An ambient HAR_TELEMETRY=false (opt-out) would override the levels these tests write.
  'HAR_TELEMETRY',
] as const;

let tmpDir: string;
// A level in the environment (HAR_TELEMETRY=false, as harness runs set it) outranks the preference file the tests write.
const savedTelemetry = process.env.HAR_TELEMETRY;

beforeEach(() => {
  delete process.env.HAR_TELEMETRY;
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
  if (savedTelemetry === undefined) delete process.env.HAR_TELEMETRY;
  else process.env.HAR_TELEMETRY = savedTelemetry;
});

function makeRepo(name: string): string {
  const repoPath = path.join(tmpDir, name);
  fs.mkdirSync(repoPath, { recursive: true });
  return fs.realpathSync(repoPath);
}

describe('runPortalConnect', () => {
  it('logs in with an api key and attaches nothing: HAR HQ gets only repositories chosen afterwards', async () => {
    const repoPath = makeRepo('app');

    const result = await runPortalConnect({
      portalUrl: 'https://app.harhq.com',
      apiKey: 'har_ingest_test',
      repoPath,
    });

    expect(result.record.portalUrl).toBe('https://app.harhq.com');
    expect(result.record.token).toBe('har_ingest_test');
    expect(result.replaced).toBeNull();
    expect(listAttachedRepos()).toEqual([]);
  });

  it('keeps the same connection when logging in to the same org again', async () => {
    const a = await runPortalConnect({ portalUrl: 'https://app.harhq.com', apiKey: 'shared' });
    const b = await runPortalConnect({ portalUrl: 'https://app.harhq.com', apiKey: 'shared' });
    expect(a.record.alias).toBe(b.record.alias);
    expect(b.replaced).toBeNull();
  });

  it('replaces the connection when the key belongs to another org', async () => {
    await runPortalConnect({ portalUrl: 'https://app.harhq.com', apiKey: 'token-org-a' });
    const switched = await runPortalConnect({ portalUrl: 'https://app.harhq.com', apiKey: 'token-org-b' });
    expect(switched.replaced?.token).toBe('token-org-a');
    expect(getActivePortalConnection()?.token).toBe('token-org-b');
  });
});

describe('describeHqStatus', () => {
  it('reports the login, no repository chosen, and the local level', async () => {
    const savedDestinations = process.env.HAR_DESTINATIONS_DIR;
    process.env.HAR_DESTINATIONS_DIR = path.join(tmpDir, 'destinations');
    writeTelemetryLevel('outline');
    expect(describeHqStatus()).toMatchObject({ connection: null, repositories: [], telemetryLevel: 'outline' });
    await runPortalConnect({ portalUrl: 'https://app.harhq.com', apiKey: 'k' });
    const status = describeHqStatus();
    expect(status.connection?.token).toBe('k');
    expect(status.repositories).toEqual([]);
    expect(status.hint).toMatch(/no repository is chosen/);
    process.env.HAR_DESTINATIONS_DIR = savedDestinations;
  });
});
