import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  applyRepoWorkspaceMap,
  planRepoWorkspaceMap,
  remainingConnections,
  remainingUnassignedRepos,
} from '../src/core/portal-repo-map';
import { getRepoPortalTargetAliases, upsertPortalTarget } from '../src/core/portal-targets';

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

describe('planRepoWorkspaceMap', () => {
  it('is a no-op when there are no other registered repos', () => {
    const repo = path.join(tmpDir, 'only');
    expect(
      planRepoWorkspaceMap({
        currentRepo: repo,
        currentAlias: 'acme',
        registeredRepos: [repo],
        connections: [
          {
            alias: 'acme',
            portalUrl: 'https://app.harhq.com',
            workspaceId: 'org-1',
            workspaceName: 'Acme',
            token: 't',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    ).toEqual({ kind: 'none' });
  });

  it('offers extra attachments when only one workspace is saved', () => {
    const current = path.join(tmpDir, 'current');
    const other = path.join(tmpDir, 'other');
    const plan = planRepoWorkspaceMap({
      currentRepo: current,
      currentAlias: 'acme',
      registeredRepos: [current, other],
      connections: [
        {
          alias: 'acme',
          portalUrl: 'https://app.harhq.com',
          workspaceId: 'org-1',
          workspaceName: 'Acme',
          token: 't',
          createdAt: new Date().toISOString(),
        },
      ],
    });
    expect(plan.kind).toBe('attach-more');
    if (plan.kind !== 'attach-more') return;
    expect(plan.repos).toEqual([other]);
    expect(plan.workspaceAlias).toBe('acme');
  });

  it('asks for a per-repo workspace when several connections exist', () => {
    const current = path.join(tmpDir, 'current');
    const other = path.join(tmpDir, 'other');
    const plan = planRepoWorkspaceMap({
      currentRepo: current,
      currentAlias: 'kerno',
      registeredRepos: [current, other],
      connections: [
        {
          alias: 'haulieros',
          portalUrl: 'http://localhost:3020',
          workspaceId: 'org-h',
          workspaceName: 'HaulierOS',
          token: 't1',
          createdAt: new Date().toISOString(),
        },
        {
          alias: 'kerno',
          portalUrl: 'http://localhost:3020',
          workspaceId: 'org-k',
          workspaceName: 'Kerno',
          token: 't2',
          createdAt: new Date().toISOString(),
        },
      ],
    });
    expect(plan.kind).toBe('map-orgs');
    if (plan.kind !== 'map-orgs') return;
    expect(plan.repos).toEqual([other]);
    expect(plan.connections.map((c) => c.alias)).toEqual(['haulieros', 'kerno']);
  });
});

describe('applyRepoWorkspaceMap', () => {
  it('attaches selected repos and skips the rest', () => {
    upsertPortalTarget({
      alias: 'acme',
      portalUrl: 'https://app.harhq.com',
      workspaceId: 'org-1',
      token: 't',
    });
    const keep = path.join(tmpDir, 'keep');
    const skip = path.join(tmpDir, 'skip');
    fs.mkdirSync(keep, { recursive: true });
    fs.mkdirSync(skip, { recursive: true });

    expect(
      applyRepoWorkspaceMap([
        { repoPath: keep, alias: 'acme' },
        { repoPath: skip, alias: null },
      ]),
    ).toEqual([keep]);
    expect(getRepoPortalTargetAliases(keep)).toEqual(['acme']);
    expect(getRepoPortalTargetAliases(skip)).toEqual([]);
  });
});

describe('remainingUnassignedRepos / remainingConnections', () => {
  it('hides already-assigned repositories from the next workspace', () => {
    const a = path.join(tmpDir, 'a');
    const b = path.join(tmpDir, 'b');
    const c = path.join(tmpDir, 'c');
    expect(remainingUnassignedRepos([a, b, c], [b])).toEqual([a, c]);
  });

  it('drops a workspace once it has been used in a round', () => {
    expect(
      remainingConnections(
        [
          { alias: 'kerno', label: 'Kerno' },
          { alias: 'haulieros', label: 'HaulierOS' },
        ],
        ['kerno'],
      ),
    ).toEqual([{ alias: 'haulieros', label: 'HaulierOS' }]);
  });
});
