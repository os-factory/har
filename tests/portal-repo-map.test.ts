import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { attachReposToPortal, unattachedRegisteredRepos } from '../src/core/portal-repo-map';
import { connectPortal, listAttachedRepos } from '../src/core/portal-targets';

const ENV_KEYS = ['HAR_PORTAL_TARGETS_PATH', 'HAR_CONTROL_REGISTRY_PATH', 'HAR_CREDENTIALS_PATH'] as const;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-repo-map-'));
  process.env.HAR_PORTAL_TARGETS_PATH = path.join(tmpDir, 'portal-targets.json');
  process.env.HAR_CONTROL_REGISTRY_PATH = path.join(tmpDir, 'repos.json');
  process.env.HAR_CREDENTIALS_PATH = path.join(tmpDir, 'credentials.json');
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('unattachedRegisteredRepos', () => {
  it('offers registered repos other than the current one and those already attached', () => {
    const current = path.join(tmpDir, 'current');
    const other = path.join(tmpDir, 'other');
    const attached = path.join(tmpDir, 'attached');
    expect(unattachedRegisteredRepos(current, [current, other, attached, other], [attached])).toEqual([
      other,
    ]);
  });

  it('is empty when there is nothing else to offer', () => {
    const repo = path.join(tmpDir, 'only');
    expect(unattachedRegisteredRepos(repo, [repo], [])).toEqual([]);
  });
});

describe('attachReposToPortal', () => {
  it('attaches the selected repos to the active connection', () => {
    connectPortal({ portalUrl: 'https://app.harhq.com', workspaceId: 'org-1', token: 't' });
    const keep = fs.realpathSync(fs.mkdtempSync(path.join(tmpDir, 'keep-')));

    expect(attachReposToPortal([keep])).toEqual([keep]);
    expect(listAttachedRepos()).toEqual([keep]);
  });
});
