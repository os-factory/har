import * as http from 'http';

import { loginViaBrowser } from '../src/core/portal-login';

function hitCallback(
  loginUrl: string,
  opts: { token?: string; state?: string; workspace?: string; email?: string },
): void {
  const url = new URL(loginUrl);
  const callback = url.searchParams.get('callback') as string;
  const params = new URLSearchParams();
  if (opts.token) params.set('token', opts.token);
  params.set('state', opts.state ?? (url.searchParams.get('state') as string));
  if (opts.workspace) params.set('workspace', opts.workspace);
  if (opts.email) params.set('email', opts.email);
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

  it('captures the login email from the callback', async () => {
    const creds = await loginViaBrowser('https://portal.example.com', (url) =>
      hitCallback(url, { token: 'har_ingest_abc', email: 'login@haulieros.io' }),
    );
    expect(creds.email).toBe('login@haulieros.io');
  });

  it('rejects on state mismatch', async () => {
    await expect(
      loginViaBrowser('https://portal.example.com', (url) =>
        hitCallback(url, { token: 'har_ingest_abc', state: 'wrong-state' }),
      ),
    ).rejects.toThrow(/state mismatch/);
  });
});
