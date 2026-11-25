import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { canonicalizeControlRepoPath } from './control-repo-path';
import { isRepoPortalSyncEnabled, listRegisteredRepos, recordRepoForControlSync } from './control-registry';
import { isPortalApiKey, KERNO_INGEST_PREFIX, kernoApiUrlFor } from './portal-hosts';
import { loginViaBrowser } from './portal-login';
import {
  attachRepoToPortal,
  connectPortal,
  readPortalConnectionState,
  type ConnectPortalResult,
  type PortalTargetRecord,
} from './portal-targets';
import { getTelemetryLevel, type TelemetryLevel } from './telemetry-config';

export interface PortalConnectInput {
  portalUrl: string;
  apiKey?: string;
  repoPath?: string;
}

export interface PortalConnectResult {
  record: PortalTargetRecord;
  attachedRepo: string | null;
  /** The different org this connect replaced (nothing is sent to it any more). */
  replaced: PortalTargetRecord | null;
  /** Repos attached to the replaced org; they no longer sync until re-attached. */
  detachedRepos: string[];
}

function attachRepoIfPresent(repoPath?: string): string | null {
  const resolved = path.resolve(repoPath ?? '.');
  if (!fs.existsSync(resolved)) return null;
  const canonical = canonicalizeControlRepoPath(resolved);
  attachRepoToPortal(canonical);
  recordRepoForControlSync(canonical);
  return canonical;
}

function workspaceIdForApiKey(token: string): string {
  return `key:${createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
}

const KEY_CHECK_TIMEOUT_MS = 15_000;

/**
 * Ask Kerno which org `apiKey` writes to, so a wrong key fails here and not at
 * the first sync. Null when the portal cannot say (not a Kerno portal, or one
 * that predates the check): the key is then stored unchecked, as before.
 */
async function orgForApiKey(
  portalUrl: string,
  apiKey: string,
): Promise<{ organizationId: string; organizationName?: string } | null> {
  const apiUrl = kernoApiUrlFor(portalUrl);
  if (!apiUrl) return null;

  let response: Response;
  try {
    response = await fetch(`${apiUrl}${KERNO_INGEST_PREFIX}/whoami`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not check the key with ${apiUrl}: ${reason}`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      isPortalApiKey(apiKey)
        ? 'The API key was rejected — it was revoked, has expired, or belongs to another environment. Nothing was saved.'
        : 'The ingest token was rejected — run `har hq connect` without --api-key to log in again. Nothing was saved.',
    );
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not check the key with ${apiUrl}: HTTP ${response.status}`);

  const body = (await response.json().catch(() => null)) as {
    organizationId?: unknown;
    organizationName?: unknown;
  } | null;
  if (typeof body?.organizationId !== 'string' || !body.organizationId) return null;
  return {
    organizationId: body.organizationId,
    organizationName: typeof body.organizationName === 'string' ? body.organizationName : undefined,
  };
}

async function connectViaApiKey(portalUrl: string, apiKey: string): Promise<ConnectPortalResult> {
  const org = await orgForApiKey(portalUrl, apiKey);
  return connectPortal({
    portalUrl,
    workspaceId: org?.organizationId ?? workspaceIdForApiKey(apiKey),
    workspaceName: org?.organizationName,
    token: apiKey,
  });
}

/**
 * Connect the CLI to one org. This replaces any existing connection to a
 * different org — the CLI never holds keys for several orgs.
 */
export async function runPortalConnect(input: PortalConnectInput): Promise<PortalConnectResult> {
  const connected = input.apiKey
    ? await connectViaApiKey(input.portalUrl, input.apiKey)
    : await connectViaBrowser(input);

  return {
    record: connected.record,
    attachedRepo: attachRepoIfPresent(input.repoPath),
    replaced: connected.replaced,
    detachedRepos: connected.detachedRepos,
  };
}

async function connectViaBrowser(input: PortalConnectInput): Promise<ConnectPortalResult> {
  const creds = await loginViaBrowser(input.portalUrl, {
    repos: listRegisteredReposForConnect(input.repoPath),
  });
  return connectPortal({
    portalUrl: input.portalUrl,
    workspaceId: creds.workspaceId,
    workspace: creds.workspace,
    workspaceSlug: creds.workspaceSlug,
    workspaceName: creds.workspaceName,
    token: creds.token,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
    email: creds.email,
  });
}

function listRegisteredReposForConnect(repoPath?: string): string[] {
  const resolved = repoPath ? path.resolve(repoPath) : null;
  const current = resolved && fs.existsSync(resolved) ? canonicalizeControlRepoPath(resolved) : null;
  return [...new Set([...(current ? [current] : []), ...listRegisteredRepos()])];
}

export interface PortalRepoSyncState {
  repoPath: string;
  /** False when the repo is attached but kept local-only (`register --no-portal`). */
  sendsToHq: boolean;
}

/** What HQ actually receives from this machine, as `har hq list` reports it. */
export interface PortalSyncOverview {
  connection: PortalTargetRecord | null;
  repos: PortalRepoSyncState[];
  /** Whether prompts and tool text are forwarded, when the level records them. */
  trajectoryForwarding: boolean;
  telemetryLevel: TelemetryLevel;
  /** What a synced repo's sessions look like in HQ, from the two settings above. */
  hqTrajectory: 'none' | 'usage' | 'outline' | 'full';
}

export function describePortalSync(): PortalSyncOverview {
  const { connection, attachedRepos } = readPortalConnectionState();
  const telemetryLevel = getTelemetryLevel();
  const trajectoryForwarding = connection?.trajectoryForwarding === true;
  const hqTrajectory: PortalSyncOverview['hqTrajectory'] =
    telemetryLevel === 'off'
      ? 'none'
      : telemetryLevel === 'full'
        ? trajectoryForwarding
          ? 'full'
          : 'outline'
        : telemetryLevel;
  return {
    connection,
    repos: attachedRepos.map((repoPath) => ({
      repoPath,
      sendsToHq: isRepoPortalSyncEnabled(repoPath),
    })),
    trajectoryForwarding,
    telemetryLevel,
    hqTrajectory,
  };
}
