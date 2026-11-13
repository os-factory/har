import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { attachReposToPortal, planRepoWorkspaceMap } from '../src/core/portal-repo-map';
import {
  connectPortal,
  isRepoAttachedToPortal,
  type PortalTargetRecord,
} from '../src/core/portal-targets';

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

const ACME: PortalTargetRecord = {
  alias: 'acme',
  portalUrl: 'https://app.harhq.com',
  workspaceId: 'org-1',
  workspaceName: 'Acme',
  token: 't',
  createdAt: new Date().toISOString(),
};

describe('planRepoWorkspaceMap', () => {
  it('is a no-op without a connection', () => {
    const current = path.join(tmpDir, 'current');
    const other = path.join(tmpDir, 'other');
    expect(
      planRepoWorkspaceMap({
        currentRepo: current,
        registeredRepos: [current, other],
        connection: null,
      }),
    ).toEqual({ kind: 'none' });
  });

  it('is a no-op when there are no other registered repos', () => {
    const repo = path.join(tmpDir, 'only');
    expect(
      planRepoWorkspaceMap({
        currentRepo: repo,
        registeredRepos: [repo],
        connection: ACME,
        attachedRepos: [],
      }),
    ).toEqual({ kind: 'none' });
  });

  it('offers the other, not-yet-attached repos for the one org', () => {
    const current = path.join(tmpDir, 'current');
    const other = path.join(tmpDir, 'other');
    const attached = path.join(tmpDir, 'attached');
    const plan = planRepoWorkspaceMap({
      currentRepo: current,
      registeredRepos: [current, other, attached],
      connection: ACME,
      attachedRepos: [attached],
    });
    expect(plan).toEqual({
      kind: 'attach-more',
      workspaceAlias: 'acme',
      workspaceLabel: 'Acme @ app.harhq.com',
      repos: [other],
    });
  });
});

describe('attachReposToPortal', () => {
  it('attaches the selected repos to the active connection', () => {
    connectPortal({ alias: 'acme', portalUrl: 'https://app.harhq.com', workspaceId: 'org-1', token: 't' });
    const keep = path.join(tmpDir, 'keep');
    const skip = path.join(tmpDir, 'skip');
    fs.mkdirSync(keep, { recursive: true });
    fs.mkdirSync(skip, { recursive: true });

    expect(attachReposToPortal([keep])).toHaveLength(1);
    expect(isRepoAttachedToPortal(keep)).toBe(true);
    expect(isRepoAttachedToPortal(skip)).toBe(false);
  });
});
