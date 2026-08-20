import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { getPortalTarget } from '../src/core/control-config';
import {
  getRepoPortalTargetAlias,
  migrateLegacyCredentialsIfNeeded,
  portalTargetIdentityKey,
  portalTargetsPath,
  readPortalTargetsStore,
  redactPortalTargetRecord,
  removePortalTarget,
  resolvePortalTargetsForRepo,
  setRepoPortalTarget,
  upsertPortalTarget,
  writePortalTargetTrajectoryPreference,
} from '../src/core/portal-targets';
import {
  readPortalCredentials,
} from '../src/core/portal-credentials';
import {
  readPortalWatermark,
  writePortalWatermark,
} from '../src/core/portal-watermark';

const ENV_KEYS = [
  'HAR_PORTAL_URL',
  'HAR_PORTAL_TOKEN',
  'HAR_CREDENTIALS_PATH',
  'HAR_PORTAL_TARGETS_PATH',
  'HAR_PORTAL_SYNC_STATE_PATH',
] as const;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-targets-'));
  process.env.HAR_CREDENTIALS_PATH = path.join(tmpDir, 'credentials.json');
  process.env.HAR_PORTAL_TARGETS_PATH = path.join(tmpDir, 'portal-targets.json');
  process.env.HAR_PORTAL_SYNC_STATE_PATH = path.join(tmpDir, 'portal-sync-state.json');
  for (const key of ENV_KEYS) {
    if (key.endsWith('_PATH')) continue;
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('portal targets store', () => {
  it('keeps multiple targets on the same portal with different workspace ids', () => {
    upsertPortalTarget({
      alias: 'org-a',
      portalUrl: 'https://portal.example.com',
      workspaceId: 'org_a',
      token: 'token-a',
    });
    upsertPortalTarget({
      alias: 'org-b',
      portalUrl: 'https://portal.example.com',
      workspaceId: 'org_b',
      token: 'token-b',
    });

    const store = readPortalTargetsStore();
    expect(store.targets).toHaveLength(2);
    expect(store.targets.map((entry) => entry.alias).sort()).toEqual(['org-a', 'org-b']);
  });

  it('updates an existing target identity in place without touching another alias', () => {
    upsertPortalTarget({
      alias: 'dev',
      portalUrl: 'https://dev.example.com',
      workspaceId: 'ws_dev',
      token: 'dev-1',
    });
    upsertPortalTarget({
      alias: 'prod',
      portalUrl: 'https://prod.example.com',
      workspaceId: 'ws_prod',
      token: 'prod-1',
    });

    upsertPortalTarget({
      alias: 'dev-renamed-ignored',
      portalUrl: 'https://dev.example.com',
      workspaceId: 'ws_dev',
      token: 'dev-2',
    });

    expect(getPortalTarget()?.token).toBe('dev-2');
    expect(readPortalTargetsStore().targets.find((entry) => entry.alias === 'prod')?.token).toBe(
      'prod-1',
    );
  });

  it('stores per-repository default targets', () => {
    upsertPortalTarget({
      alias: 'dev',
      portalUrl: 'https://dev.example.com',
      workspaceId: 'ws_dev',
      token: 'dev',
    });
    const repoPath = path.join(tmpDir, 'repo-a');
    fs.mkdirSync(repoPath, { recursive: true });
    setRepoPortalTarget(repoPath, 'dev');
    expect(getRepoPortalTargetAlias(repoPath)).toBe('dev');
  });

  it('redacts tokens from list/show payloads', () => {
    upsertPortalTarget({
      alias: 'dev',
      portalUrl: 'https://dev.example.com',
      workspaceId: 'ws_dev',
      token: 'secret-token',
      refreshToken: 'secret-refresh',
    });
    const raw = fs.readFileSync(portalTargetsPath(), 'utf8');
    expect(raw).toContain('secret-token');
    expect(redactPortalTargetRecord(readPortalTargetsStore().targets[0])).not.toHaveProperty('token');
  });
});

describe('legacy credentials migration', () => {
  it('migrates ~/.har/credentials.json into a default target', () => {
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

    const store = readPortalTargetsStore();
    expect(store.targets).toHaveLength(1);
    expect(store.defaultTarget).toBe(store.targets[0].alias);
    expect(readPortalCredentials()?.token).toBe('legacy-token');
    expect(getPortalTarget()?.token).toBe('legacy-token');
  });
});

describe('portal watermarks per target', () => {
  it('does not share cursors between targets for the same repo', () => {
    const repoPath = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoPath);
    const devKey = portalTargetIdentityKey('https://portal.example.com', 'org_dev');
    const prodKey = portalTargetIdentityKey('https://portal.example.com', 'org_prod');

    writePortalWatermark(repoPath, devKey, '2026-01-01T00:00:00.000Z');
    writePortalWatermark(repoPath, prodKey, '2026-02-01T00:00:00.000Z');

    expect(readPortalWatermark(repoPath, devKey)).toBe('2026-01-01T00:00:00.000Z');
    expect(readPortalWatermark(repoPath, prodKey)).toBe('2026-02-01T00:00:00.000Z');
  });
});

describe('resolvePortalTargetsForRepo', () => {
  it('prefers env overrides over saved targets', () => {
    upsertPortalTarget({
      alias: 'saved',
      portalUrl: 'https://saved.example.com',
      workspaceId: 'ws_saved',
      token: 'saved',
    });
    process.env.HAR_PORTAL_URL = 'https://env.example.com';
    process.env.HAR_PORTAL_TOKEN = 'env-token';
    expect(resolvePortalTargetsForRepo()?.targets[0]).toMatchObject({
      url: 'https://env.example.com',
      token: 'env-token',
    });
  });

  it('uses explicit sync targets without changing stored defaults', () => {
    upsertPortalTarget({
      alias: 'dev',
      portalUrl: 'https://dev.example.com',
      workspaceId: 'ws_dev',
      token: 'dev',
      setAsDefault: true,
    });
    upsertPortalTarget({
      alias: 'prod',
      portalUrl: 'https://prod.example.com',
      workspaceId: 'ws_prod',
      token: 'prod',
    });

    const resolved = resolvePortalTargetsForRepo({ explicitTargets: ['prod'] });
    expect(resolved?.targets[0].alias).toBe('prod');
    expect(readPortalTargetsStore().defaultTarget).toBe('dev');
  });
});

describe('target-specific trajectory preference', () => {
  it('stores trajectory forwarding per target', () => {
    upsertPortalTarget({
      alias: 'dev',
      portalUrl: 'https://dev.example.com',
      workspaceId: 'ws_dev',
      token: 'dev',
    });
    upsertPortalTarget({
      alias: 'prod',
      portalUrl: 'https://prod.example.com',
      workspaceId: 'ws_prod',
      token: 'prod',
    });

    writePortalTargetTrajectoryPreference('dev', true);
    const store = readPortalTargetsStore();
    expect(store.targets.find((entry) => entry.alias === 'dev')?.trajectoryForwarding).toBe(true);
    expect(store.targets.find((entry) => entry.alias === 'prod')?.trajectoryForwarding).not.toBe(true);
  });
});

describe('removePortalTarget', () => {
  it('removes one target without deleting another', () => {
    upsertPortalTarget({
      alias: 'dev',
      portalUrl: 'https://dev.example.com',
      workspaceId: 'ws_dev',
      token: 'dev',
      setAsDefault: true,
    });
    upsertPortalTarget({
      alias: 'prod',
      portalUrl: 'https://prod.example.com',
      workspaceId: 'ws_prod',
      token: 'prod',
    });

    expect(removePortalTarget('dev')).toBe(true);
    expect(readPortalTargetsStore().targets.map((entry) => entry.alias)).toEqual(['prod']);
    expect(getPortalTarget()?.alias).toBe('prod');
  });
});
