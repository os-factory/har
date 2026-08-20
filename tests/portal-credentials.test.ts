import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  readPortalCredentials,
  writePortalCredentials,
} from '../src/core/portal-credentials';
import {
  DEFAULT_PORTAL_URL,
  getPortalTarget,
  resolvePortalUrl,
} from '../src/core/control-config';

const PORTAL_ENV = [
  'HAR_PORTAL_URL',
  'HAR_PORTAL_TOKEN',
  'HAR_CLOUD_API_URL',
  'HAR_CLOUD_API_KEY',
] as const;

let tmpFile: string;

beforeEach(() => {
  tmpFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'har-creds-')),
    'credentials.json',
  );
  process.env.HAR_CREDENTIALS_PATH = tmpFile;
  process.env.HAR_PORTAL_TARGETS_PATH = path.join(path.dirname(tmpFile), 'portal-targets.json');
  for (const key of PORTAL_ENV) delete process.env[key];
});

afterEach(() => {
  delete process.env.HAR_CREDENTIALS_PATH;
  delete process.env.HAR_PORTAL_TARGETS_PATH;
});

describe('portal credentials store', () => {
  it('round-trips credentials and writes the file 0600', () => {
    writePortalCredentials({
      portalUrl: 'https://portal.example.com',
      token: 'har_ingest_x',
      workspace: 'acme',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const mode = fs.statSync(tmpFile).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readPortalCredentials()).toMatchObject({
      portalUrl: 'https://portal.example.com',
      token: 'har_ingest_x',
      workspace: 'acme',
      targetAlias: 'acme',
    });
  });

  it('round-trips the authenticated login email', () => {
    writePortalCredentials({
      portalUrl: 'https://portal.example.com',
      token: 'har_ingest_x',
      email: 'login@haulieros.io',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(readPortalCredentials()?.email).toBe('login@haulieros.io');
  });

  it('round-trips the refresh token and ingest-token expiry', () => {
    writePortalCredentials({
      portalUrl: 'https://portal.example.com',
      token: 'har_ingest_x',
      refreshToken: 'har_refresh_y',
      expiresAt: '2026-02-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const creds = readPortalCredentials();
    expect(creds?.refreshToken).toBe('har_refresh_y');
    expect(creds?.expiresAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('returns null when the file is missing or incomplete', () => {
    expect(readPortalCredentials()).toBeNull();
    fs.writeFileSync(tmpFile, JSON.stringify({ portalUrl: 'https://x' }));
    expect(readPortalCredentials()).toBeNull();
  });
});

describe('getPortalTarget source precedence', () => {
  it('uses stored credentials when no env is set', () => {
    writePortalCredentials({
      portalUrl: 'https://portal.example.com/',
      token: 'har_ingest_stored',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(getPortalTarget()).toMatchObject({
      url: 'https://portal.example.com',
      token: 'har_ingest_stored',
    });
  });

  it('prefers HAR_PORTAL_* env over stored credentials', () => {
    writePortalCredentials({
      portalUrl: 'https://stored.example.com',
      token: 'har_ingest_stored',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    process.env.HAR_PORTAL_URL = 'https://env.example.com';
    process.env.HAR_PORTAL_TOKEN = 'har_ingest_env';
    expect(getPortalTarget()).toMatchObject({
      url: 'https://env.example.com',
      token: 'har_ingest_env',
    });
  });
});

describe('resolvePortalUrl', () => {
  function storePortal(portalUrl: string): void {
    writePortalCredentials({
      portalUrl,
      token: 'har_ingest_stored',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  }

  it('falls back to the default portal when nothing is set', () => {
    expect(DEFAULT_PORTAL_URL).toBe('https://app.harhq.com');
    expect(resolvePortalUrl()).toEqual({
      url: DEFAULT_PORTAL_URL,
      source: 'default',
    });
  });

  it('reuses the portal from a previous login', () => {
    storePortal('https://stored.example.com');
    expect(resolvePortalUrl()).toEqual({
      url: 'https://stored.example.com',
      source: 'saved',
    });
  });

  it('prefers HAR_PORTAL_URL over a previous login', () => {
    storePortal('https://stored.example.com');
    process.env.HAR_PORTAL_URL = 'https://env.example.com';
    expect(resolvePortalUrl()).toEqual({
      url: 'https://env.example.com',
      source: 'env',
    });
  });

  it('prefers the explicit portal over env and a previous login', () => {
    storePortal('https://stored.example.com');
    process.env.HAR_PORTAL_URL = 'https://env.example.com';
    expect(resolvePortalUrl('https://flag.example.com')).toEqual({
      url: 'https://flag.example.com',
      source: 'flag',
    });
  });

  it('normalizes trailing slashes and blank values on every source', () => {
    storePortal('https://stored.example.com//');
    expect(resolvePortalUrl('  ')).toEqual({
      url: 'https://stored.example.com',
      source: 'saved',
    });
    process.env.HAR_PORTAL_URL = 'https://env.example.com/';
    expect(resolvePortalUrl('')).toEqual({
      url: 'https://env.example.com',
      source: 'env',
    });
  });
});
