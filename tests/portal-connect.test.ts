import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runPortalConnect } from '../src/core/portal-connect';
import {
  getRepoPortalTargetAliases,
  readPortalTargetsStore,
} from '../src/core/portal-targets';

const ENV_KEYS = [
  'HAR_PORTAL_URL',
  'HAR_PORTAL_TOKEN',
  'HAR_CREDENTIALS_PATH',
  'HAR_PORTAL_TARGETS_PATH',
  'HAR_CONTROL_REGISTRY_PATH',
] as const;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-connect-'));
  process.env.HAR_CREDENTIALS_PATH = path.join(tmpDir, 'credentials.json');
  process.env.HAR_PORTAL_TARGETS_PATH = path.join(tmpDir, 'portal-targets.json');
  process.env.HAR_CONTROL_REGISTRY_PATH = path.join(tmpDir, 'repos.json');
  for (const key of ENV_KEYS) {
    if (key.endsWith('_PATH')) continue;
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('runPortalConnect', () => {
  it('saves an api-key connection and attaches the current repository', async () => {
    const repoPath = path.join(tmpDir, 'app');
    fs.mkdirSync(repoPath, { recursive: true });

    const result = await runPortalConnect({
      portalUrl: 'https://app.harhq.com',
      apiKey: 'har_ingest_test',
      repoPath,
    });

    expect(result.record.portalUrl).toBe('https://app.harhq.com');
    expect(result.record.token).toBe('har_ingest_test');
    expect(result.attachedRepo).toBe(repoPath);
    expect(getRepoPortalTargetAliases(repoPath)).toEqual([result.record.alias]);
    expect(readPortalTargetsStore().targets).toHaveLength(1);
  });

  it('keeps an existing workspace connection when attaching a second repository', async () => {
    const first = path.join(tmpDir, 'one');
    const second = path.join(tmpDir, 'two');
    fs.mkdirSync(first, { recursive: true });
    fs.mkdirSync(second, { recursive: true });

    const a = await runPortalConnect({
      portalUrl: 'https://app.harhq.com',
      apiKey: 'token-shared',
      repoPath: first,
    });
    const b = await runPortalConnect({
      portalUrl: 'https://app.harhq.com',
      apiKey: 'token-shared',
      repoPath: second,
    });

    expect(a.record.alias).toBe(b.record.alias);
    expect(readPortalTargetsStore().targets).toHaveLength(1);
    expect(getRepoPortalTargetAliases(first)).toEqual([a.record.alias]);
    expect(getRepoPortalTargetAliases(second)).toEqual([b.record.alias]);
  });

  it('keeps two api-key connections on the same portal when the tokens differ', async () => {
    const repoPath = path.join(tmpDir, 'app');
    fs.mkdirSync(repoPath, { recursive: true });

    await runPortalConnect({
      portalUrl: 'https://app.harhq.com',
      apiKey: 'token-org-a',
      repoPath,
    });
    await runPortalConnect({
      portalUrl: 'https://app.harhq.com',
      apiKey: 'token-org-b',
      repoPath,
    });

    expect(readPortalTargetsStore().targets).toHaveLength(2);
    expect(getRepoPortalTargetAliases(repoPath)).toHaveLength(2);
  });
});
