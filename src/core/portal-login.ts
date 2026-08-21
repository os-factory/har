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

export type BrowserConnectTarget = {
  workspaceId: string;
  workspace?: string;
  workspaceName?: string;
  token: string;
  refreshToken?: string;
  expiresAt?: string;
  repos: string[];
};

export type PortalLoginResult = PortalCredentials & {
  /** Present when the portal assigned repositories in the browser. */
  targets?: BrowserConnectTarget[];
};

export type LoginViaBrowserOptions = {
  openUrl?: (url: string) => void;
  repos?: string[];
};

const REPOS_QUERY_BUDGET = 1800;

export function encodeCliReposQuery(repos: string[]): string | null {
  const unique = [...new Set(repos.filter((repo) => repo.trim().length > 0))];
  if (unique.length === 0) return null;
  const encoded = encodeURIComponent(JSON.stringify(unique));
  if (encoded.length > REPOS_QUERY_BUDGET) return null;
  return encoded;
}

export function parseCliTargetsParam(raw: string | null): BrowserConnectTarget[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      targets?: BrowserConnectTarget[];
    };
    if (!Array.isArray(parsed.targets)) return null;
    const targets = parsed.targets.filter(
      (entry) =>
        typeof entry?.workspaceId === 'string' &&
        typeof entry?.token === 'string' &&
        Array.isArray(entry.repos),
    );
    return targets.length > 0 ? targets : null;
  } catch {
    return null;
  }
}

export async function loginViaBrowser(
  portalUrl: string,
  openUrlOrOptions: ((url: string) => void) | LoginViaBrowserOptions = openBrowser,
): Promise<PortalLoginResult> {
  const options: LoginViaBrowserOptions =
    typeof openUrlOrOptions === 'function' ? { openUrl: openUrlOrOptions } : openUrlOrOptions;
  const openUrl = options.openUrl ?? openBrowser;
  const state = randomUUID();

  return new Promise<PortalLoginResult>((resolve, reject) => {
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
      const targets = parseCliTargetsParam(requestUrl.searchParams.get('targets'));
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
        ...(targets ? { targets } : {}),
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
      const reposQuery = encodeCliReposQuery(options.repos ?? []);
      const loginUrl = `${portalUrl}/cli/login?callback=${encodeURIComponent(callback)}&state=${state}${
        reposQuery ? `&repos=${reposQuery}` : ''
      }`;
      openUrl(loginUrl);
      process.stderr.write(`Opening ${loginUrl}\nIf your browser did not open, paste that URL.\n`);
      timer = setTimeout(() => {
        cleanup();
        reject(new Error('timed out'));
      }, LOGIN_TIMEOUT_MS);
    });
  });
}
