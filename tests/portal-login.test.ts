import * as http from 'http';

import {
  encodeCliReposQuery,
  loginViaBrowser,
  parseCliTargetsParam,
} from '../src/core/portal-login';

function hitCallback(
  loginUrl: string,
  opts: {
    token?: string;
    state?: string;
    workspace?: string;
    workspaceId?: string;
    workspaceName?: string;
    email?: string;
    refreshToken?: string;
    expiresAt?: string;
    targets?: string;
  },
): void {
  const url = new URL(loginUrl);
  const callback = url.searchParams.get('callback') as string;
  const params = new URLSearchParams();
  if (opts.token) params.set('token', opts.token);
  params.set('state', opts.state ?? (url.searchParams.get('state') as string));
  if (opts.workspace) params.set('workspace', opts.workspace);
  if (opts.workspaceId) params.set('workspaceId', opts.workspaceId);
  if (opts.workspaceName) params.set('workspaceName', opts.workspaceName);
  if (opts.email) params.set('email', opts.email);
  if (opts.refreshToken) params.set('refreshToken', opts.refreshToken);
  if (opts.expiresAt) params.set('expiresAt', opts.expiresAt);
  if (opts.targets) params.set('targets', opts.targets);
  http.get(`${callback}?${params.toString()}`, (res) => res.resume());
}

describe('loginViaBrowser', () => {
  it('captures the token from the loopback callback', async () => {
    const creds = await loginViaBrowser('https://portal.example.com', (url) =>
      hitCallback(url, { token: 'har_ingest_abc', workspace: 'acme' }),
    );
    expect(creds).toMatchObject({
      portalUrl: 'https://portal.example.com',
      token: 'har_ingest_abc',
      workspace: 'acme',
    });
  });

  it('captures the stable workspace id from FE-1646 callbacks', async () => {
    const creds = await loginViaBrowser('https://portal.example.com', (url) =>
      hitCallback(url, {
        token: 'har_ingest_abc',
        workspace: 'acme',
        workspaceId: 'org_acme',
        workspaceName: 'Acme',
      }),
    );
    expect(creds.workspaceId).toBe('org_acme');
    expect(creds.workspaceName).toBe('Acme');
    expect(creds.workspaceSlug).toBe('acme');
  });

  it('captures the login email from the callback', async () => {
    const creds = await loginViaBrowser('https://portal.example.com', (url) =>
      hitCallback(url, { token: 'har_ingest_abc', email: 'login@haulieros.io' }),
    );
    expect(creds.email).toBe('login@haulieros.io');
  });

  it('captures the refresh token and ingest-token expiry from the callback', async () => {
    const creds = await loginViaBrowser('https://portal.example.com', (url) =>
      hitCallback(url, {
        token: 'har_ingest_abc',
        refreshToken: 'har_refresh_xyz',
        expiresAt: '2026-02-01T00:00:00.000Z',
      }),
    );
    expect(creds.refreshToken).toBe('har_refresh_xyz');
    expect(creds.expiresAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('forwards registered repos on the consent URL', async () => {
    const pending = loginViaBrowser('https://portal.example.com', {
      repos: ['/repo/a', '/repo/b'],
      openUrl: (url) => {
        const parsed = new URL(url);
        expect(JSON.parse(parsed.searchParams.get('repos') ?? '[]')).toEqual([
          '/repo/a',
          '/repo/b',
        ]);
        hitCallback(url, { token: 'har_ingest_abc' });
      },
    });
    await expect(pending).resolves.toMatchObject({ token: 'har_ingest_abc' });
  });

  it('captures browser assignment targets from the callback', async () => {
    const targets = Buffer.from(
      JSON.stringify({
        targets: [
          {
            workspaceId: 'org-a',
            workspace: 'acme',
            token: 'har_ingest_a',
            repos: ['/repo/a'],
          },
        ],
      }),
      'utf8',
    ).toString('base64url');
    const creds = await loginViaBrowser('https://portal.example.com', (url) =>
      hitCallback(url, { token: 'har_ingest_a', workspaceId: 'org-a', targets }),
    );
    expect(creds.targets).toEqual([
      {
        workspaceId: 'org-a',
        workspace: 'acme',
        token: 'har_ingest_a',
        repos: ['/repo/a'],
      },
    ]);
  });

  it('rejects on state mismatch', async () => {
    await expect(
      loginViaBrowser('https://portal.example.com', (url) =>
        hitCallback(url, { token: 'har_ingest_abc', state: 'wrong-state' }),
      ),
    ).rejects.toThrow(/state mismatch/);
  });
});

describe('cli repos / targets encoding', () => {
  it('encodes a short repo list and round-trips targets', () => {
    expect(JSON.parse(decodeURIComponent(encodeCliReposQuery(['/a', '/b'])!))).toEqual([
      '/a',
      '/b',
    ]);
    const raw = Buffer.from(
      JSON.stringify({
        targets: [{ workspaceId: 'o', token: 't', repos: ['/a'] }],
      }),
      'utf8',
    ).toString('base64url');
    expect(parseCliTargetsParam(raw)?.[0]).toMatchObject({ workspaceId: 'o', repos: ['/a'] });
  });
});
