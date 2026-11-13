import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { getPortalTarget } from '../src/core/control-config';
import {
  attachRepoToPortal,
  connectPortal,
  detachRepoFromPortal,
  disconnectPortal,
  getActivePortalConnection,
  isPortalTargetActive,
  isPortalTrajectoryEnabledForTarget,
  isRepoAttachedToPortal,
  listAttachedRepos,
  migrateLegacyCredentialsIfNeeded,
  portalTargetIdentityKey,
  portalTargetsPath,
  readPortalConnectionState,
  recordToPortalTarget,
  redactPortalTargetRecord,
  resolvePortalTarget,
  resolveWorkspaceId,
  updatePortalTargetTokens,
  writePortalConnectionTrajectoryPreference,
} from '../src/core/portal-targets';
import { readPortalCredentials } from '../src/core/portal-credentials';
import { readPortalWatermark, writePortalWatermark } from '../src/core/portal-watermark';

const ENV_KEYS = [
  'HAR_PORTAL_URL',
  'HAR_PORTAL_TOKEN',
  'HAR_PORTAL_TRAJECTORY',
  'HAR_CREDENTIALS_PATH',
  'HAR_PORTAL_TARGETS_PATH',
  'HAR_PORTAL_SYNC_STATE_PATH',
  'HAR_CONTROL_REGISTRY_PATH',
] as const;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-targets-'));
  process.env.HAR_CREDENTIALS_PATH = path.join(tmpDir, 'credentials.json');
  process.env.HAR_PORTAL_TARGETS_PATH = path.join(tmpDir, 'portal-targets.json');
  process.env.HAR_PORTAL_SYNC_STATE_PATH = path.join(tmpDir, 'portal-sync-state.json');
  process.env.HAR_CONTROL_REGISTRY_PATH = path.join(tmpDir, 'repos.json');
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

function connectOrg(workspaceId: string, token = `${workspaceId}-token`) {
  return connectPortal({
    portalUrl: 'https://portal.example.com',
    workspaceId,
    workspaceName: workspaceId,
    token,
    refreshToken: `${workspaceId}-refresh`,
  });
}

function readFile(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(portalTargetsPath(), 'utf8')) as Record<string, unknown>;
}

describe('one org connection at a time', () => {
  it('stores a single connection on disk', () => {
    connectOrg('org_a');
    const file = readFile();
    expect(file.targets).toHaveLength(1);
    expect(file.defaultTarget).toBe('org_a');
  });

  it('replaces the connection when switching org', () => {
    connectOrg('org_a');
    const switched = connectOrg('org_b');

    expect(switched.replaced?.workspaceId).toBe('org_a');
    expect(getActivePortalConnection()?.workspaceId).toBe('org_b');
    const raw = fs.readFileSync(portalTargetsPath(), 'utf8');
    expect(raw).not.toContain('org_a-token');
    expect(raw).not.toContain('org_a-refresh');
    expect(readPortalCredentials()?.token).toBe('org_b-token');
  });

  it('clears attached repos when switching org, so none syncs to the new org unasked', () => {
    const repo = makeRepo('app');
    connectOrg('org_a');
    attachRepoToPortal(repo);

    const switched = connectOrg('org_b');

    expect(switched.detachedRepos).toEqual([repo]);
    expect(listAttachedRepos()).toEqual([]);
    expect(resolvePortalTarget({ repoPath: repo })).toBeNull();
  });

  it('keeps attached repos and trajectory setting on a same-org reconnect', () => {
    const repo = makeRepo('app');
    connectOrg('org_a', 'old');
    attachRepoToPortal(repo);
    writePortalConnectionTrajectoryPreference(true);

    const again = connectOrg('org_a', 'new');

    expect(again.replaced).toBeNull();
    expect(again.detachedRepos).toEqual([]);
    expect(listAttachedRepos()).toEqual([repo]);
    expect(getActivePortalConnection()).toMatchObject({ token: 'new', trajectoryForwarding: true });
  });

  it('attaches and detaches repos on the active connection only', () => {
    const repo = makeRepo('app');
    expect(() => attachRepoToPortal(repo)).toThrow(/har hq connect/);

    connectOrg('org_a');
    attachRepoToPortal(repo);
    attachRepoToPortal(repo);
    expect(listAttachedRepos()).toEqual([repo]);
    expect(isRepoAttachedToPortal(repo)).toBe(true);

    expect(detachRepoFromPortal(repo)).toBe(true);
    expect(isRepoAttachedToPortal(repo)).toBe(false);
  });

  it('disconnect removes the connection, its repos and the legacy credentials file', () => {
    const repo = makeRepo('app');
    connectOrg('org_a');
    attachRepoToPortal(repo);

    expect(disconnectPortal()?.workspaceId).toBe('org_a');
    expect(readPortalConnectionState()).toEqual({ connection: null, attachedRepos: [] });
    expect(fs.existsSync(process.env.HAR_CREDENTIALS_PATH!)).toBe(false);
    expect(getPortalTarget(repo)).toBeNull();
    expect(disconnectPortal()).toBeNull();
  });

  it('redacts tokens from list/show payloads', () => {
    const { record } = connectOrg('org_a', 'secret-token');
    expect(fs.readFileSync(portalTargetsPath(), 'utf8')).toContain('secret-token');
    expect(redactPortalTargetRecord(record)).not.toHaveProperty('token');
  });
});

describe('collapsing a store with several connections (older CLIs)', () => {
  function writeMultiOrgStore(defaultTarget?: string) {
    fs.writeFileSync(
      portalTargetsPath(),
      JSON.stringify({
        version: 1,
        ...(defaultTarget ? { defaultTarget } : {}),
        targets: [
          {
            alias: 'dev',
            portalUrl: 'https://portal.example.com',
            workspaceId: 'org_dev',
            token: 'dev-token',
            createdAt: '2026-01-01T00:00:00.000Z',
            lastUsedAt: '2026-03-01T00:00:00.000Z',
          },
          {
            alias: 'prod',
            portalUrl: 'https://portal.example.com',
            workspaceId: 'org_prod',
            token: 'prod-token',
            createdAt: '2026-01-01T00:00:00.000Z',
            lastUsedAt: '2026-02-01T00:00:00.000Z',
          },
        ],
        repoTargets: {
          '/repos/both': ['dev', 'prod'],
          '/repos/dev-only': ['dev'],
          '/repos/prod-only': ['prod'],
        },
      }),
    );
  }

  it('keeps defaultTarget, drops the other connections and their repo attachments', () => {
    writeMultiOrgStore('prod');

    const state = readPortalConnectionState();

    expect(state.connection?.alias).toBe('prod');
    expect(state.attachedRepos.sort()).toEqual(['/repos/both', '/repos/prod-only']);
    const raw = fs.readFileSync(portalTargetsPath(), 'utf8');
    expect(raw).not.toContain('dev-token');
    expect(readFile()).toEqual({
      version: 1,
      defaultTarget: 'prod',
      targets: [expect.objectContaining({ alias: 'prod' })],
      repoTargets: { '/repos/both': ['prod'], '/repos/prod-only': ['prod'] },
    });
    expect(readPortalCredentials()?.token).toBe('prod-token');
  });

  it('falls back to the most recently used connection without a defaultTarget', () => {
    writeMultiOrgStore();
    expect(getActivePortalConnection()?.alias).toBe('dev');
  });
});

describe('legacy credentials migration', () => {
  it('migrates ~/.har/credentials.json into the connection', () => {
    fs.writeFileSync(
      process.env.HAR_CREDENTIALS_PATH!,
      JSON.stringify({
        portalUrl: 'https://portal.example.com',
        token: 'legacy-token',
        workspace: 'acme',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    expect(fs.existsSync(portalTargetsPath())).toBe(false);

    migrateLegacyCredentialsIfNeeded();

    const connection = getActivePortalConnection();
    expect(connection?.workspaceId).toBe('slug:acme');
    expect(readPortalCredentials()?.token).toBe('legacy-token');
    expect(getPortalTarget()?.token).toBe('legacy-token');
  });

  it('attaches registered repos to the migrated connection', () => {
    const repoPath = path.join(__dirname, 'fixtures/minimal-harness');
    fs.writeFileSync(process.env.HAR_CONTROL_REGISTRY_PATH!, JSON.stringify({ repos: [repoPath] }));
    fs.writeFileSync(
      process.env.HAR_CREDENTIALS_PATH!,
      JSON.stringify({
        portalUrl: 'https://portal.example.com',
        token: 'legacy-token',
        workspace: 'acme',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    );

    migrateLegacyCredentialsIfNeeded();

    expect(isRepoAttachedToPortal(repoPath)).toBe(true);
  });
});

describe('portal watermarks per org', () => {
  it('does not share cursors between orgs for the same repo', () => {
    const repoPath = makeRepo('repo');
    const devKey = portalTargetIdentityKey('https://portal.example.com', 'org_dev');
    const prodKey = portalTargetIdentityKey('https://portal.example.com', 'org_prod');

    writePortalWatermark(repoPath, devKey, '2026-01-01T00:00:00.000Z');
    writePortalWatermark(repoPath, prodKey, '2026-02-01T00:00:00.000Z');

    expect(readPortalWatermark(repoPath, devKey)).toBe('2026-01-01T00:00:00.000Z');
    expect(readPortalWatermark(repoPath, prodKey)).toBe('2026-02-01T00:00:00.000Z');
  });
});

describe('resolvePortalTarget', () => {
  it('prefers the HAR_PORTAL_URL + HAR_PORTAL_TOKEN override for the run', () => {
    connectOrg('org_a');
    process.env.HAR_PORTAL_URL = 'https://env.example.com/';
    process.env.HAR_PORTAL_TOKEN = 'env-token';

    const resolved = resolvePortalTarget({ repoPath: makeRepo('any') });

    expect(resolved?.source).toBe('env');
    expect(resolved?.target).toMatchObject({ url: 'https://env.example.com', token: 'env-token' });
  });

  it('only resolves the connection for attached repos', () => {
    const repo = makeRepo('app');
    connectOrg('org_a');
    expect(resolvePortalTarget({ repoPath: repo })).toBeNull();

    attachRepoToPortal(repo);
    expect(resolvePortalTarget({ repoPath: repo })).toMatchObject({
      source: 'connection',
      target: { workspaceId: 'org_a' },
    });
  });
});

describe('isPortalTargetActive', () => {
  it('goes stale after switching org or disconnecting', () => {
    const { record } = connectOrg('org_a');
    const target = recordToPortalTarget(record);
    expect(isPortalTargetActive(target)).toBe(true);

    connectOrg('org_b');
    expect(isPortalTargetActive(target)).toBe(false);

    const current = recordToPortalTarget(getActivePortalConnection()!);
    disconnectPortal();
    expect(isPortalTargetActive(current)).toBe(false);
  });

  it('accepts the env override only while it is still set', () => {
    process.env.HAR_PORTAL_URL = 'https://env.example.com';
    process.env.HAR_PORTAL_TOKEN = 'env-token';
    const target = resolvePortalTarget()!.target;
    expect(isPortalTargetActive(target)).toBe(true);

    delete process.env.HAR_PORTAL_URL;
    expect(isPortalTargetActive(target)).toBe(false);
  });
});

describe('trajectory preference', () => {
  it('applies to the active connection and not to a replaced one', () => {
    const { record } = connectOrg('org_a');
    writePortalConnectionTrajectoryPreference(true);
    expect(isPortalTrajectoryEnabledForTarget(recordToPortalTarget(record))).toBe(true);

    const next = connectOrg('org_b');
    expect(isPortalTrajectoryEnabledForTarget(recordToPortalTarget(record))).toBe(false);
    expect(isPortalTrajectoryEnabledForTarget(recordToPortalTarget(next.record))).toBe(false);
  });

  it('throws without a connection', () => {
    expect(() => writePortalConnectionTrajectoryPreference(true)).toThrow(/har hq connect/);
  });
});

describe('workspace identity compatibility', () => {
  it('uses a slug: prefix when an older portal returns only the workspace slug', () => {
    expect(resolveWorkspaceId({ workspace: 'acme' })).toBe('slug:acme');
    expect(resolveWorkspaceId({ workspaceId: 'org_acme', workspace: 'acme' })).toBe('org_acme');
  });
});

describe('token refresh', () => {
  it('rotates the active connection token', () => {
    const { record } = connectOrg('org_a', 'old');
    updatePortalTargetTokens(recordToPortalTarget(record).identityKey, {
      token: 'new',
      expiresAt: '2026-03-01T00:00:00.000Z',
    });
    expect(getActivePortalConnection()).toMatchObject({
      token: 'new',
      refreshToken: 'org_a-refresh',
      expiresAt: '2026-03-01T00:00:00.000Z',
    });
  });

  it('ignores a refresh for an org that is no longer active', () => {
    const { record } = connectOrg('org_a', 'old');
    connectOrg('org_b', 'b-token');

    expect(
      updatePortalTargetTokens(recordToPortalTarget(record).identityKey, { token: 'late' }),
    ).toBeNull();
    expect(getActivePortalConnection()).toMatchObject({ workspaceId: 'org_b', token: 'b-token' });
  });
});
