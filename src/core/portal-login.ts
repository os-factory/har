import * as http from 'http';
import { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';

import { PortalCredentials } from './portal-credentials';

const CALLBACK_PATH = '/callback';
const LOGIN_TIMEOUT_MS = 3 * 60_000;

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Caller prints the URL so the user can open it manually.
  }
}

export async function loginViaBrowser(
  portalUrl: string,
  openUrl: (url: string) => void = openBrowser,
): Promise<PortalCredentials> {
  const state = randomUUID();

  return new Promise<PortalCredentials>((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url ?? '', 'http://127.0.0.1');
      if (requestUrl.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const token = requestUrl.searchParams.get('token');
      const returnedState = requestUrl.searchParams.get('state');
      const workspace = requestUrl.searchParams.get('workspace') ?? undefined;
      const workspaceId = requestUrl.searchParams.get('workspaceId') ?? undefined;
      const workspaceSlug =
        requestUrl.searchParams.get('workspaceSlug') ?? workspace ?? undefined;
      const email = requestUrl.searchParams.get('email') ?? undefined;
      const refreshToken = requestUrl.searchParams.get('refreshToken') ?? undefined;
      const expiresAt = requestUrl.searchParams.get('expiresAt') ?? undefined;

      if (returnedState !== state || !token) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>Login failed</h1><p>You can close this tab and try again.</p>');
        cleanup();
        reject(new Error('state mismatch or missing token'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Logged in</h1><p>You can close this tab and return to the terminal.</p>');
      cleanup();
      resolve({
        portalUrl,
        token,
        workspace: workspaceSlug ?? workspace,
        workspaceSlug,
        workspaceName:
          requestUrl.searchParams.get('workspaceName') ??
          requestUrl.searchParams.get('organizationName') ??
          workspace ??
          undefined,
        workspaceId,
        email,
        refreshToken,
        expiresAt,
        createdAt: new Date().toISOString(),
      });
    });

    const cleanup = () => {
      clearTimeout(timer);
      server.close();
    };

    server.on('error', (err) => {
      cleanup();
      reject(err);
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const callback = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
      const loginUrl = `${portalUrl}/cli/login?callback=${encodeURIComponent(callback)}&state=${state}`;
      openUrl(loginUrl);
      process.stderr.write(`Opening ${loginUrl}\nIf your browser did not open, paste that URL.\n`);
      timer = setTimeout(() => {
        cleanup();
        reject(new Error('timed out'));
      }, LOGIN_TIMEOUT_MS);
    });
  });
}
